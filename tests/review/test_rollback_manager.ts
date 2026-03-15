import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import RollbackManagerImpl from '../../src/review/rollback_manager.ts';
import { getDefaultConfig } from '../../src/plugin/config.ts';
import { ensureDir, fileExists, readFile } from '../../src/shared/fs.ts';

describe('review/rollback_manager', () => {
  let tempDir: string;
  let backupsDir: string;
  let skillsDir: string;
  let manager: RollbackManagerImpl;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skill-rollback-test-'));
    backupsDir = join(tempDir, 'backups');
    skillsDir = join(tempDir, 'skills');
    manager = new RollbackManagerImpl(getDefaultConfig(), backupsDir, skillsDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('backup creates versioned json file and returns version metadata', async () => {
    const version = await manager.backup('skill.alpha', 'content-v1');
    expect(version.skillKey).toBe('skill.alpha');
    expect(version.versionId).toMatch(/^v_/);

    const backupPath = join(backupsDir, 'skill.alpha', `${version.versionId}.json`);
    await expect(fileExists(backupPath)).resolves.toBe(true);
    const serialized = await readFile(backupPath);
    expect(serialized).toContain('"skillKey": "skill.alpha"');
    expect(serialized).toContain('"content": "content-v1"');
  });

  it('restore writes backed up content to skill SKILL.md file', async () => {
    const version = await manager.backup('skill.alpha', 'restored content');
    await manager.restore('skill.alpha', version.versionId);

    const skillFilePath = join(skillsDir, 'skill.alpha', 'SKILL.md');
    await expect(fileExists(skillFilePath)).resolves.toBe(true);
    await expect(readFile(skillFilePath)).resolves.toBe('restored content');
  });

  it('restore throws when target version file does not exist', async () => {
    await expect(manager.restore('skill.alpha', 'v_missing')).rejects.toThrow(
      'Rollback version not found for skill.alpha: v_missing'
    );
  });

  it('listVersions returns versions sorted by timestamp descending', async () => {
    await manager.backup('skill.alpha', 'c1');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await manager.backup('skill.alpha', 'c2');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await manager.backup('skill.alpha', 'c3');

    const versions = await manager.listVersions('skill.alpha');
    expect(versions).toHaveLength(3);
    expect(versions[0]!.timestamp).toBeGreaterThanOrEqual(versions[1]!.timestamp);
    expect(versions[1]!.timestamp).toBeGreaterThanOrEqual(versions[2]!.timestamp);
  });

  it('pruneOldVersions caps rollback history to maxRollbackVersions', async () => {
    const config = getDefaultConfig();
    config.merge.maxRollbackVersions = 5;
    manager = new RollbackManagerImpl(config, backupsDir, skillsDir);

    for (let i = 0; i < 7; i += 1) {
      await manager.backup('skill.alpha', `content-${i}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    await manager.pruneOldVersions('skill.alpha');
    const versions = await manager.listVersions('skill.alpha');
    expect(versions).toHaveLength(5);
  });

  it('throws parse error when backup JSON is malformed', async () => {
    const skillBackupDir = join(backupsDir, 'skill.alpha');
    await ensureDir(skillBackupDir);
    const badPath = join(skillBackupDir, 'v_bad.json');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(badPath, '{bad', 'utf8'));

    await expect(manager.listVersions('skill.alpha')).rejects.toThrow(`Invalid backup JSON at ${badPath}`);
  });

  it('throws shape validation error when backup JSON misses required fields', async () => {
    const skillBackupDir = join(backupsDir, 'skill.alpha');
    await ensureDir(skillBackupDir);
    const badShapePath = join(skillBackupDir, 'v_shape.json');
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(badShapePath, JSON.stringify({ versionId: 'v_shape' }), 'utf8')
    );

    await expect(manager.listVersions('skill.alpha')).rejects.toThrow(`Invalid skill version shape at ${badShapePath}`);
  });
});
