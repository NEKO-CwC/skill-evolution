import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MergeManagerImpl } from '../../src/review/merge_manager.ts';
import RollbackManagerImpl from '../../src/review/rollback_manager.ts';
import { getDefaultConfig } from '../../src/plugin/config.ts';
import { ensureDir, fileExists, readFile, writeFile } from '../../src/shared/fs.ts';
import { MergeConflictError } from '../../src/shared/errors.ts';
import type { PatchMetadata, RollbackManager, SkillVersion } from '../../src/shared/types.ts';

describe('review/merge_manager', () => {
  let tempDir: string;
  let skillsDir: string;
  let patchesDir: string;
  let backupsDir: string;

  const metadata: PatchMetadata = {
    skillKey: 'skill.alpha',
    patchId: 'patch-1',
    baseVersion: 'latest',
    sourceSessionId: 'session-1',
    mergeMode: 'manual',
    riskLevel: 'low',
    rollbackChainDepth: 0
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skill-merge-test-'));
    skillsDir = join(tempDir, 'skills');
    patchesDir = join(tempDir, 'patches');
    backupsDir = join(tempDir, 'backups');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('checkMergePolicy blocks auto merge when requireHumanMerge is true', () => {
    const config = getDefaultConfig();
    config.merge.requireHumanMerge = true;
    const manager = new MergeManagerImpl(config);

    expect(manager.checkMergePolicy(metadata)).toBe(false);
  });

  it('checkMergePolicy allows auto merge when requireHumanMerge is false', () => {
    const config = getDefaultConfig();
    config.merge.requireHumanMerge = false;
    const manager = new MergeManagerImpl(config);

    expect(manager.checkMergePolicy(metadata)).toBe(true);
  });

  it('queues patch file in manual mode and returns false', async () => {
    const config = getDefaultConfig();
    config.merge.requireHumanMerge = true;
    const rollback = new RollbackManagerImpl(config, backupsDir, skillsDir);
    const manager = new MergeManagerImpl(config, rollback, skillsDir, patchesDir);

    const merged = await manager.merge('skill.alpha', 'patch content', metadata);
    expect(merged).toBe(false);

    const queuedPath = join(patchesDir, 'skill.alpha', 'patch-1.md');
    await expect(fileExists(queuedPath)).resolves.toBe(true);
    await expect(readFile(queuedPath)).resolves.toBe('patch content');
  });

  it('auto merges patch, writes SKILL.md, and creates backup of previous content', async () => {
    const config = getDefaultConfig();
    config.merge.requireHumanMerge = false;
    const rollback = new RollbackManagerImpl(config, backupsDir, skillsDir);
    const manager = new MergeManagerImpl(config, rollback, skillsDir, patchesDir);

    const skillPath = join(skillsDir, 'skill.alpha', 'SKILL.md');
    await ensureDir(dirname(skillPath));
    await writeFile(skillPath, 'old content');

    const merged = await manager.merge('skill.alpha', 'new content', metadata);
    expect(merged).toBe(true);
    await expect(readFile(skillPath)).resolves.toBe('new content');

    const backupFiles = await readdir(join(backupsDir, 'skill.alpha'));
    expect(backupFiles.some((name) => name.endsWith('.json'))).toBe(true);
  });

  it('wraps merge failures into MergeConflictError', async () => {
    const config = getDefaultConfig();
    config.merge.requireHumanMerge = false;
    const failingRollback: RollbackManager = {
      backup: async (): Promise<SkillVersion> => {
        throw new Error('forced backup failure');
      },
      restore: async (): Promise<void> => undefined,
      listVersions: async (): Promise<SkillVersion[]> => [],
      pruneOldVersions: async (): Promise<void> => undefined
    };
    const manager = new MergeManagerImpl(config, failingRollback, skillsDir, patchesDir);

    await expect(manager.merge('skill.alpha', 'x', metadata)).rejects.toBeInstanceOf(MergeConflictError);
  });
});
