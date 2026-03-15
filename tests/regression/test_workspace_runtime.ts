import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDefaultConfig } from '../../src/plugin/config.ts';
import { SkillEvolutionPlugin } from '../../src/plugin/index.ts';

describe('Regression: Workspace root from runtime context', () => {
  let tempRoot = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'skill-regression-workspace-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('plugin initializes with process.cwd() when no workspaceDir provided, then rebinds on ensureWorkspaceDir', async () => {
    const config = getDefaultConfig();
    const plugin = new SkillEvolutionPlugin(config);

    expect(plugin.paths.workspaceDir).toBe(process.cwd());

    plugin.ensureWorkspaceDir(tempRoot);

    expect(plugin.paths.workspaceDir).toBe(tempRoot);
    expect(plugin.paths.overlaysDir).toBe(join(tempRoot, '.skill-overlays'));
    expect(plugin.paths.skillsDir).toBe(join(tempRoot, 'skills'));
    expect(plugin.paths.backupsDir).toBe(join(tempRoot, '.skill-backups'));
    expect(plugin.paths.feedbackDir).toBe(join(tempRoot, '.skill-feedback'));
    expect(plugin.paths.patchesDir).toBe(join(tempRoot, '.skill-patches'));
  });

  it('ensureWorkspaceDir is idempotent after first call', () => {
    const config = getDefaultConfig();
    const plugin = new SkillEvolutionPlugin(config);

    plugin.ensureWorkspaceDir(tempRoot);
    const pathsAfterFirst = { ...plugin.paths };

    plugin.ensureWorkspaceDir('/some/other/path');
    expect(plugin.paths).toEqual(pathsAfterFirst);
  });

  it('does not rebind if workspace was explicitly provided at construction', () => {
    const config = getDefaultConfig();
    const explicitDir = tempRoot;
    const plugin = new SkillEvolutionPlugin(config, explicitDir);

    expect(plugin.paths.workspaceDir).toBe(explicitDir);

    plugin.ensureWorkspaceDir('/some/other/path');
    expect(plugin.paths.workspaceDir).toBe(explicitDir);
  });

  it('overlay store works after workspace rebind', async () => {
    const config = getDefaultConfig();
    const plugin = new SkillEvolutionPlugin(config);
    plugin.ensureWorkspaceDir(tempRoot);

    const sessionId = 'workspace-test';
    const skillKey = 'skill.ws';

    await plugin.before_prompt_build(sessionId, skillKey, 'BASE');
    await plugin.after_tool_call(sessionId, 'shell', 'Error: test', true);

    const overlays = await plugin.overlayStore.listBySession(sessionId);
    expect(overlays.length).toBeGreaterThanOrEqual(1);
    expect(overlays[0]?.content).toContain('Tool error observed');
  });
});
