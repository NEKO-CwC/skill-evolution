import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDefaultConfig, loadConfig, validateConfig } from '../../../src/plugin/config.ts';
import { writeFile } from '../../../src/shared/fs.ts';
import { InvalidConfigError } from '../../../src/shared/errors.ts';

describe('plugin/config', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skill-config-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns expected defaults from getDefaultConfig', () => {
    const config = getDefaultConfig();
    expect(config.enabled).toBe(true);
    expect(config.merge.requireHumanMerge).toBe(true);
    expect(config.merge.maxRollbackVersions).toBe(5);
    expect(config.sessionOverlay.injectMode).toBe('system-context');
  });

  it('loads yaml and deep-merges partial config with defaults', async () => {
    const configPath = join(tempDir, 'config.yml');
    await writeFile(
      configPath,
      [
        'skillEvolution:',
        '  merge:',
        '    requireHumanMerge: false',
        '  review:',
        '    minEvidenceCount: 4'
      ].join('\n')
    );

    const loaded = await loadConfig(configPath);
    expect(loaded.merge.requireHumanMerge).toBe(false);
    expect(loaded.review.minEvidenceCount).toBe(4);
    expect(loaded.merge.maxRollbackVersions).toBe(5);
    expect(loaded.sessionOverlay.storageDir).toBe('.skill-overlays');
  });

  it('throws InvalidConfigError when config file does not exist', async () => {
    const missingPath = join(tempDir, 'missing.yml');
    await expect(loadConfig(missingPath)).rejects.toBeInstanceOf(InvalidConfigError);
  });

  it('throws InvalidConfigError when top-level skillEvolution is missing', async () => {
    const configPath = join(tempDir, 'invalid.yml');
    await writeFile(configPath, 'notSkillEvolution:\n  enabled: true');
    await expect(loadConfig(configPath)).rejects.toThrow('Config must contain top-level "skillEvolution" object.');
  });

  it('throws InvalidConfigError for invalid merge.maxRollbackVersions', () => {
    const invalid = getDefaultConfig();
    invalid.merge.maxRollbackVersions = 0;
    expect(() => validateConfig(invalid)).toThrow('skillEvolution.merge.maxRollbackVersions must be an integer >= 1.');
  });

  it('throws InvalidConfigError for invalid sessionOverlay.injectMode', () => {
    const invalid = getDefaultConfig();
    invalid.sessionOverlay.injectMode = 'system-contextual' as 'system-context';
    expect(() => validateConfig(invalid)).toThrow(
      'skillEvolution.sessionOverlay.injectMode must be "system-context" or "tool-description".'
    );
  });
});
