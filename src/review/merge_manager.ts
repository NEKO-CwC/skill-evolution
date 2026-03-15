/**
 * Merge manager implementing patch-application and policy-check contracts.
 */

import { join } from 'node:path';
import { MergeConflictError } from '../shared/errors.js';
import { ensureDir, fileExists, readFile, writeFile } from '../shared/fs.js';
import ConsoleLogger from '../shared/logger.js';
import RollbackManagerImpl from './rollback_manager.js';
import type { MergeManager, PatchMetadata } from '../shared/types.js';
import type { RollbackManager, SkillEvolutionConfig } from '../shared/types.js';

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
 * Default merge manager placeholder implementation.
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
   * Applies patch content to a skill target.
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

      const skillFilePath = this.getSkillFilePath(skillKey);
      const skillDir = this.getSkillDir(skillKey);
      await ensureDir(skillDir);

      const currentContent = (await fileExists(skillFilePath)) ? await readFile(skillFilePath) : '';
      await this.rollbackManager.backup(skillKey, currentContent);

      await writeFile(skillFilePath, patchContent);
      await this.rollbackManager.pruneOldVersions(skillKey);

      this.logger.info('Patch auto-merged successfully', {
        skillKey,
        patchId: metadata.patchId,
        skillFilePath
      });
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MergeConflictError(`Failed to merge patch ${metadata.patchId} for skill ${skillKey}: ${message}`);
    }
  }

  /**
   * Validates whether metadata satisfies merge policy.
   */
  public checkMergePolicy(metadata: PatchMetadata): boolean {
    void metadata;
    return this.config.merge.requireHumanMerge === false;
  }

  private getSkillDir(skillKey: string): string {
    return join(this.skillsDir, skillKey);
  }

  private getSkillFilePath(skillKey: string): string {
    return join(this.getSkillDir(skillKey), 'SKILL.md');
  }
}

export default MergeManagerImpl;
