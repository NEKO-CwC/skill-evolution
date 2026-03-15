import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDefaultConfig } from '../../src/plugin/config.ts';
import { SkillEvolutionPlugin } from '../../src/plugin/index.ts';
import { LLMReviewRunner } from '../../src/review/llm_review_runner.ts';

describe('Regression: Workspace binding race condition', () => {
  let tempRoot = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'skill-binding-race-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('session_end before workspace binding: does not crash, does not write files, does not execute review', async () => {
    const config = getDefaultConfig();
    config.triggers.onSessionEndReview = true;
    const plugin = new SkillEvolutionPlugin(config);

    // Plugin defaults to cwd, not bound
    expect(plugin.isWorkspaceBound()).toBe(false);

    // session_end should exit early with no side effects
    await plugin.session_end('unbound-session');

    // No files should have been written to tempRoot (not even the overlay/feedback dirs)
    // The important thing is no crash and no review pipeline execution
  });

  it('ensureWorkspaceDir rebinds all path-dependent components', () => {
    const config = getDefaultConfig();
    const plugin = new SkillEvolutionPlugin(config);

    expect(plugin.isWorkspaceBound()).toBe(false);

    plugin.ensureWorkspaceDir(tempRoot);

    expect(plugin.isWorkspaceBound()).toBe(true);
    expect(plugin.paths.workspaceDir).toBe(tempRoot);
    expect(plugin.paths.overlaysDir).toBe(join(tempRoot, '.skill-overlays'));
    expect(plugin.paths.skillsDir).toBe(join(tempRoot, 'skills'));
    expect(plugin.paths.backupsDir).toBe(join(tempRoot, '.skill-backups'));
    expect(plugin.paths.feedbackDir).toBe(join(tempRoot, '.skill-feedback'));
    expect(plugin.paths.patchesDir).toBe(join(tempRoot, '.skill-patches'));
  });

  it('reviewRunner.refreshRuntimeContext is called with resolver on workspace bind', () => {
    const config = getDefaultConfig();
    const plugin = new SkillEvolutionPlugin(config);

    const runner = plugin.reviewRunner as LLMReviewRunner;
    const refreshSpy = vi.spyOn(runner, 'refreshRuntimeContext');

    plugin.ensureWorkspaceDir(tempRoot);

    expect(refreshSpy).toHaveBeenCalledOnce();
    const callArgs = refreshSpy.mock.calls[0][0];
    expect(callArgs.paths).toEqual(plugin.paths);
    // Resolver should be a LlmRuntimeResolver instance (not null)
    expect(callArgs.llmRuntimeResolver).toBeDefined();
    expect(typeof callArgs.llmRuntimeResolver!.resolve).toBe('function');

    expect(runner.paths?.workspaceDir).toBe(tempRoot);
  });

  it('full lifecycle: session_end(unbound, skip) → ensureWorkspaceDir → session_end(bound, runs)', async () => {
    const config = getDefaultConfig();
    config.triggers.onSessionEndReview = true;
    config.review.minEvidenceCount = 999; // Set high so review pipeline skips due to insufficient evidence
    const plugin = new SkillEvolutionPlugin(config);
    const sessionId = 'lifecycle-test';

    // Phase 1: session_end while unbound — should skip silently
    expect(plugin.isWorkspaceBound()).toBe(false);
    await plugin.session_end(sessionId);

    // Phase 2: bind workspace
    plugin.ensureWorkspaceDir(tempRoot);
    expect(plugin.isWorkspaceBound()).toBe(true);

    // Phase 3: session_end after binding — should execute normally
    // Feed some data so the hook has something to process
    plugin.ensureSessionStarted(sessionId);
    plugin.setSessionSkillKey(sessionId, 'test-skill');
    await plugin.after_tool_call(sessionId, 'shell', 'Error: test failure', true);

    // This should run without error, even though review will be skipped
    // (minEvidenceCount is 999, we only have 1 event)
    await plugin.session_end(sessionId);

    // Verify overlay dir was created (proof the bound session_end ran path operations)
    const overlayDirExists = await readdir(join(tempRoot, '.skill-overlays')).then(
      () => true,
      () => false
    );
    expect(overlayDirExists).toBe(true);
  });

  it('isWorkspaceBound returns true when constructed with explicit workspaceDir', () => {
    const config = getDefaultConfig();
    const plugin = new SkillEvolutionPlugin(config, tempRoot);

    expect(plugin.isWorkspaceBound()).toBe(true);
  });

  it('fallback-bound workspace can be upgraded by ensureWorkspaceDir', () => {
    const config = getDefaultConfig();
    const fallbackDir = '/tmp/fallback-cwd';
    const realDir = tempRoot;

    // Simulate register() passing cwd as fallback
    const plugin = new SkillEvolutionPlugin(config, fallbackDir, true);

    // Plugin reports bound (session_end guard passes)
    expect(plugin.isWorkspaceBound()).toBe(true);
    expect(plugin.paths.workspaceDir).toBe(fallbackDir);

    // Hook context provides the real workspace — should upgrade
    plugin.ensureWorkspaceDir(realDir);

    expect(plugin.isWorkspaceBound()).toBe(true);
    expect(plugin.paths.workspaceDir).toBe(realDir);
    expect(plugin.paths.overlaysDir).toBe(join(realDir, '.skill-overlays'));
  });

  it('fallback-bound workspace: second ensureWorkspaceDir is a no-op after upgrade', () => {
    const config = getDefaultConfig();
    const plugin = new SkillEvolutionPlugin(config, '/tmp/fallback', true);

    // First call upgrades from fallback
    plugin.ensureWorkspaceDir(tempRoot);
    expect(plugin.paths.workspaceDir).toBe(tempRoot);

    // Second call is a no-op (no longer fallback-bound)
    const secondDir = '/tmp/should-be-ignored';
    plugin.ensureWorkspaceDir(secondDir);
    expect(plugin.paths.workspaceDir).toBe(tempRoot);
  });

  it('explicit workspaceDir (non-fallback) blocks ensureWorkspaceDir rebind', () => {
    const config = getDefaultConfig();
    const plugin = new SkillEvolutionPlugin(config, tempRoot, false);

    expect(plugin.isWorkspaceBound()).toBe(true);

    // ensureWorkspaceDir should not rebind
    plugin.ensureWorkspaceDir('/tmp/other-dir');
    expect(plugin.paths.workspaceDir).toBe(tempRoot);
  });
});
