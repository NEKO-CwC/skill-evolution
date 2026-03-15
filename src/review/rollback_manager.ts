/**
 * Rollback manager implementing backup, restore, listing, and pruning contracts.
 */

import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import ConsoleLogger from '../shared/logger.js';
import { ensureDir, fileExists, readFile, writeFile } from '../shared/fs.js';
import type { RollbackManager, SkillVersion } from '../shared/types.js';
import type { SkillEvolutionConfig } from '../shared/types.js';

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
 * Default rollback manager placeholder implementation.
 */
export class RollbackManagerImpl implements RollbackManager {
  private readonly logger = new ConsoleLogger('rollback_manager');

  private readonly config: SkillEvolutionConfig;

  private readonly backupsDir: string;

  private readonly skillsDir: string;

  public constructor(
    config: SkillEvolutionConfig = DEFAULT_CONFIG,
    backupsDir = '.skill-backups',
    skillsDir = 'skills'
  ) {
    this.config = config;
    this.backupsDir = backupsDir;
    this.skillsDir = skillsDir;
  }

  /**
   * Creates a rollback backup version.
   */
  public async backup(skillKey: string, content: string): Promise<SkillVersion> {
    const version: SkillVersion = {
      skillKey,
      versionId: `v_${Date.now()}`,
      timestamp: Date.now(),
      content
    };

    const skillBackupDir = this.getSkillBackupDir(skillKey);
    await ensureDir(skillBackupDir);
    const versionPath = this.getVersionPath(skillKey, version.versionId);
    await writeFile(versionPath, JSON.stringify(version, null, 2));

    this.logger.info('Created skill backup version', {
      skillKey,
      versionId: version.versionId,
      backupPath: versionPath
    });

    return version;
  }

  /**
   * Restores a specific skill version.
   */
  public async restore(skillKey: string, versionId: string): Promise<void> {
    const versionPath = this.getVersionPath(skillKey, versionId);
    if (!(await fileExists(versionPath))) {
      throw new Error(`Rollback version not found for ${skillKey}: ${versionId}`);
    }

    const serialized = await readFile(versionPath);
    const version = this.parseSkillVersion(serialized, versionPath);

    const skillDir = this.getSkillDir(skillKey);
    await ensureDir(skillDir);
    const skillFilePath = this.getSkillFilePath(skillKey);
    await writeFile(skillFilePath, version.content);

    this.logger.info('Restored skill from backup', {
      skillKey,
      versionId,
      skillFilePath
    });
  }

  /**
   * Lists known versions for a skill.
   */
  public async listVersions(skillKey: string): Promise<SkillVersion[]> {
    const skillBackupDir = this.getSkillBackupDir(skillKey);
    if (!(await fileExists(skillBackupDir))) {
      return [];
    }

    const entries = await readdir(skillBackupDir);
    const versionFiles = entries.filter((entry) => entry.endsWith('.json'));

    const versions = await Promise.all(
      versionFiles.map(async (fileName) => {
        const versionPath = join(skillBackupDir, fileName);
        const serialized = await readFile(versionPath);
        return this.parseSkillVersion(serialized, versionPath);
      })
    );

    return versions.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Prunes old versions exceeding retention limits.
   */
  public async pruneOldVersions(skillKey: string): Promise<void> {
    const versions = await this.listVersions(skillKey);
    const maxVersions = this.config.merge.maxRollbackVersions;

    if (versions.length <= maxVersions) {
      return;
    }

    const versionsToDelete = versions.slice(maxVersions);
    await Promise.all(
      versionsToDelete.map(async (version) => {
        const versionPath = this.getVersionPath(skillKey, version.versionId);
        await rm(versionPath, { force: true });
      })
    );

    this.logger.info('Pruned rollback versions', {
      skillKey,
      maxVersions,
      prunedCount: versionsToDelete.length
    });
  }

  private getSkillBackupDir(skillKey: string): string {
    return join(this.backupsDir, skillKey);
  }

  private getSkillDir(skillKey: string): string {
    return join(this.skillsDir, skillKey);
  }

  private getSkillFilePath(skillKey: string): string {
    return join(this.getSkillDir(skillKey), 'SKILL.md');
  }

  private getVersionPath(skillKey: string, versionId: string): string {
    return join(this.getSkillBackupDir(skillKey), `${versionId}.json`);
  }

  private parseSkillVersion(serialized: string, filePath: string): SkillVersion {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid backup JSON at ${filePath}: ${message}`);
    }

    if (!this.isSkillVersion(parsed)) {
      throw new Error(`Invalid skill version shape at ${filePath}`);
    }

    return parsed;
  }

  private isSkillVersion(value: unknown): value is SkillVersion {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const record = value as Record<string, unknown>;
    const hasRequiredFields =
      typeof record.skillKey === 'string' &&
      typeof record.versionId === 'string' &&
      typeof record.timestamp === 'number' &&
      typeof record.content === 'string';

    if (!hasRequiredFields) {
      return false;
    }

    if ('restoredFrom' in record && record.restoredFrom !== undefined && typeof record.restoredFrom !== 'string') {
      return false;
    }

    return true;
  }
}

export default RollbackManagerImpl;
