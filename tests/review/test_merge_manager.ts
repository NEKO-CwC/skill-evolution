import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MergeManagerImpl } from '../../src/review/merge_manager.ts';
import RollbackManagerImpl from '../../src/review/rollback_manager.ts';
import { getDefaultConfig } from '../../src/plugin/config.ts';
import { ensureDir, fileExists, readFile, writeFile } from '../../src/shared/fs.ts';
import { MergeConflictError } from '../../src/shared/errors.ts';
import type { PatchCandidate, PatchMetadata, RollbackManager, SkillVersion } from '../../src/shared/types.ts';

function makeCandidate(overrides?: Partial<PatchCandidate>): PatchCandidate {
  const now = new Date().toISOString();
  return {
    id: 'patch_v2_1',
    skillKey: 'skill.alpha',
    status: 'approved',
    risk: 'low',
    sourceSessionIds: ['session-1'],
    createdAt: now,
    updatedAt: now,
    summary: 'Test apply',
    justification: 'Test justification',
    proposedDiff: 'new content via v2',
    originalContent: 'old content',
    artifactVersion: 1,
    ...overrides,
  };
}

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

  describe('applyPatch (v2)', () => {
    it('writes SKILL.md and creates backup', async () => {
      const config = getDefaultConfig();
      const rollback = new RollbackManagerImpl(config, backupsDir, skillsDir);
      const manager = new MergeManagerImpl(config, rollback, skillsDir, patchesDir);

      const skillPath = join(skillsDir, 'skill.alpha', 'SKILL.md');
      await ensureDir(dirname(skillPath));
      await writeFile(skillPath, 'old content');

      const candidate = makeCandidate();
      const result = await manager.applyPatch(candidate);

      expect(result.status).toBe('applied');
      await expect(readFile(skillPath)).resolves.toBe('new content via v2');

      const backupFiles = await readdir(join(backupsDir, 'skill.alpha'));
      expect(backupFiles.some((name) => name.endsWith('.json'))).toBe(true);
    });

    it('is idempotent for already applied patches', async () => {
      const config = getDefaultConfig();
      const rollback = new RollbackManagerImpl(config, backupsDir, skillsDir);
      const manager = new MergeManagerImpl(config, rollback, skillsDir, patchesDir);

      const candidate = makeCandidate({ status: 'applied' });
      const result = await manager.applyPatch(candidate);
      expect(result.status).toBe('applied');
    });

    it('uses revisedDiff from reviewOutput when available', async () => {
      const config = getDefaultConfig();
      const rollback = new RollbackManagerImpl(config, backupsDir, skillsDir);
      const manager = new MergeManagerImpl(config, rollback, skillsDir, patchesDir);

      const skillPath = join(skillsDir, 'skill.alpha', 'SKILL.md');
      await ensureDir(dirname(skillPath));
      await writeFile(skillPath, 'old');

      const candidate = makeCandidate({
        proposedDiff: 'original diff',
        reviewOutput: {
          reviewedAt: new Date().toISOString(),
          riskAssessment: 'low',
          suggestedAction: 'apply',
          rationale: 'looks good',
          revisedDiff: 'revised diff content',
        },
      });

      await manager.applyPatch(candidate);
      await expect(readFile(skillPath)).resolves.toBe('revised diff content');
    });

    it('wraps failures into MergeConflictError', async () => {
      const config = getDefaultConfig();
      const failingRollback: RollbackManager = {
        backup: async (): Promise<SkillVersion> => {
          throw new Error('forced');
        },
        restore: async (): Promise<void> => undefined,
        listVersions: async (): Promise<SkillVersion[]> => [],
        pruneOldVersions: async (): Promise<void> => undefined
      };
      const manager = new MergeManagerImpl(config, failingRollback, skillsDir, patchesDir);

      await expect(manager.applyPatch(makeCandidate())).rejects.toBeInstanceOf(MergeConflictError);
    });
  });

  describe('rejectPatch (v2)', () => {
    it('returns candidate with rejected status', async () => {
      const config = getDefaultConfig();
      const manager = new MergeManagerImpl(config);

      const candidate = makeCandidate({ status: 'ready' });
      const result = await manager.rejectPatch(candidate, 'Not applicable');

      expect(result.status).toBe('rejected');
      expect(result.justification).toContain('Not applicable');
    });

    it('is idempotent for already rejected patches', async () => {
      const config = getDefaultConfig();
      const manager = new MergeManagerImpl(config);

      const candidate = makeCandidate({ status: 'rejected' });
      const result = await manager.rejectPatch(candidate);
      expect(result.status).toBe('rejected');
    });
  });

  describe('checkRiskPolicy', () => {
    it('allows low risk when maxAutoApply is low', () => {
      const config = getDefaultConfig();
      const manager = new MergeManagerImpl(config);
      expect(manager.checkRiskPolicy('low', 'low')).toBe(true);
    });

    it('blocks medium risk when maxAutoApply is low', () => {
      const config = getDefaultConfig();
      const manager = new MergeManagerImpl(config);
      expect(manager.checkRiskPolicy('medium', 'low')).toBe(false);
    });

    it('allows medium risk when maxAutoApply is medium', () => {
      const config = getDefaultConfig();
      const manager = new MergeManagerImpl(config);
      expect(manager.checkRiskPolicy('medium', 'medium')).toBe(true);
    });

    it('allows all risks when maxAutoApply is high', () => {
      const config = getDefaultConfig();
      const manager = new MergeManagerImpl(config);
      expect(manager.checkRiskPolicy('low', 'high')).toBe(true);
      expect(manager.checkRiskPolicy('medium', 'high')).toBe(true);
      expect(manager.checkRiskPolicy('high', 'high')).toBe(true);
    });
  });
});
