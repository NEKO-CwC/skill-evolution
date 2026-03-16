/**
 * Merge manager implementing patch-application and policy-check contracts.
 */

import { join } from 'node:path';
import { MergeConflictError } from '../shared/errors.js';
import { ensureDir, fileExists, readFile, writeFile } from '../shared/fs.js';
import ConsoleLogger from '../shared/logger.js';
import RollbackManagerImpl from './rollback_manager.js';
import type {
  MergeManager,
  PatchCandidate,
  PatchMetadata,
  RiskLevel,
  RollbackManager,
  SkillEvolutionConfig,
} from '../shared/types.js';

const DEFAULT_CONFIG: SkillEvolutionConfig = {
  enabled: true,
  merge: {
    requireHumanMerge: true,
    maxRollbackVersions: 5
  },
  sessionOverlay: {
    enabled: true,
    storageDir: '.skill-overlays',
    injectMode: 'system-context',
    clearOnSessionEnd: true
  },
  triggers: {
    onToolError: true,
    onUserCorrection: true,
    onSessionEndReview: true,
    onPositiveFeedback: true
  },
  llm: {
    inheritPrimaryConfig: true,
    modelOverride: null,
    thinkingOverride: null,
    provider: null
  },
  review: {
    minEvidenceCount: 2,
    allowAutoMergeOnLowRiskOnly: false
  }
};

/**
 * Default merge manager with support for both legacy merge() and v2 applyPatch()/rejectPatch().
 */
export class MergeManagerImpl implements MergeManager {
  private readonly config: SkillEvolutionConfig;

  private readonly rollbackManager: RollbackManager;

  private readonly skillsDir: string;

  private readonly patchesDir: string;

  private readonly logger = new ConsoleLogger('merge_manager');

  public constructor(
    config: SkillEvolutionConfig = DEFAULT_CONFIG,
    rollbackManager?: RollbackManager,
    skillsDir = 'skills',
    patchesDir = '.skill-patches'
  ) {
    this.config = config;
    this.skillsDir = skillsDir;
    this.patchesDir = patchesDir;
    this.rollbackManager = rollbackManager ?? new RollbackManagerImpl(config, '.skill-backups', skillsDir);
  }

  /**
   * Applies patch content to a skill target (legacy v1 interface).
   */
  public async merge(skillKey: string, patchContent: string, metadata: PatchMetadata): Promise<boolean> {
    try {
      const autoMergeAllowed = this.checkMergePolicy(metadata);
      if (!autoMergeAllowed) {
        const patchDir = join(this.patchesDir, skillKey);
        await ensureDir(patchDir);

        const patchPath = join(patchDir, `${metadata.patchId}.md`);
        await writeFile(patchPath, patchContent);

        this.logger.info('Patch queued for human review', {
          skillKey,
          patchId: metadata.patchId,
          patchPath
        });
        return false;
      }

      await this.applyToSkill(skillKey, patchContent, metadata.patchId);
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MergeConflictError(`Failed to merge patch ${metadata.patchId} for skill ${skillKey}: ${message}`);
    }
  }

  /**
   * Applies a PatchCandidate to the skill file (v2 interface).
   * Returns the candidate with status='applied'. Idempotent for already-applied patches.
   */
  public async applyPatch(candidate: PatchCandidate): Promise<PatchCandidate> {
    if (candidate.status === 'applied') {
      return candidate;
    }

    try {
      const content = candidate.reviewOutput?.revisedDiff ?? candidate.proposedDiff;
      await this.applyToSkill(candidate.skillKey, content, candidate.id);

      const now = new Date().toISOString();
      return {
        ...candidate,
        status: 'applied',
        updatedAt: now,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MergeConflictError(
        `Failed to apply patch ${candidate.id} for skill ${candidate.skillKey}: ${message}`
      );
    }
  }

  /**
   * Rejects a PatchCandidate (v2 interface).
   * Returns the candidate with status='rejected'. Idempotent for already-rejected patches.
   */
  public async rejectPatch(candidate: PatchCandidate, reason?: string): Promise<PatchCandidate> {
    if (candidate.status === 'rejected') {
      return candidate;
    }

    const now = new Date().toISOString();
    this.logger.info('Patch rejected', {
      patchId: candidate.id,
      skillKey: candidate.skillKey,
      reason: reason ?? 'no reason provided',
    });

    return {
      ...candidate,
      status: 'rejected',
      updatedAt: now,
      justification: reason
        ? `${candidate.justification}\n\nRejection reason: ${reason}`
        : candidate.justification,
    };
  }

  /**
   * Validates whether metadata satisfies merge policy.
   */
  public checkMergePolicy(metadata: PatchMetadata): boolean {
    void metadata;
    return this.config.merge.requireHumanMerge === false;
  }

  /**
   * Checks whether a risk level qualifies for auto-merge under risk-based policy.
   */
  public checkRiskPolicy(risk: RiskLevel, maxAutoApplyRisk: RiskLevel): boolean {
    const riskOrder: RiskLevel[] = ['low', 'medium', 'high'];
    return riskOrder.indexOf(risk) <= riskOrder.indexOf(maxAutoApplyRisk);
  }

  private async applyToSkill(skillKey: string, content: string, patchId: string): Promise<void> {
    const skillFilePath = this.getSkillFilePath(skillKey);
    const skillDir = this.getSkillDir(skillKey);
    await ensureDir(skillDir);

    const currentContent = (await fileExists(skillFilePath)) ? await readFile(skillFilePath) : '';
    await this.rollbackManager.backup(skillKey, currentContent);

    await writeFile(skillFilePath, content);
    await this.rollbackManager.pruneOldVersions(skillKey);

    this.logger.info('Patch applied successfully', {
      skillKey,
      patchId,
      skillFilePath
    });
  }

  private getSkillDir(skillKey: string): string {
    return join(this.skillsDir, skillKey);
  }

  private getSkillFilePath(skillKey: string): string {
    return join(this.getSkillDir(skillKey), 'SKILL.md');
  }
}

export default MergeManagerImpl;
