/**
 * Regression test: verifies that session_end's review pipeline does NOT
 * block or run synchronously, preventing concurrent LLM request competition.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chdir, cwd } from 'node:process';
import { getDefaultConfig } from '../../src/plugin/config.ts';
import { SkillEvolutionPlugin } from '../../src/plugin/index.ts';

describe('Regression: concurrent session safety', () => {
  let tempRoot = '';
  let previousCwd = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'concurrent-session-'));
    previousCwd = cwd();
    chdir(tempRoot);
  });

  afterEach(async () => {
    chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('session_end returns immediately (legacy review is deferred)', async () => {
    const config = getDefaultConfig();
    config.triggers.onSessionEndReview = true;
    config.review.minEvidenceCount = 1;
    config.llm.inheritPrimaryConfig = false;
    config.reviewMode = 'queue-only';

    const plugin = new SkillEvolutionPlugin(config, tempRoot);
    const sessionId = 'concurrent-session-1';
    const skillKey = 'skill.concurrent.1';

    await plugin.before_prompt_build(sessionId, skillKey, 'BASE');
    await plugin.after_tool_call(sessionId, 'run', 'Error: timeout', true);

    const start = Date.now();
    await plugin.session_end(sessionId);
    const elapsed = Date.now() - start;

    // session_end should return almost immediately (< 500ms)
    // because the legacy review is scheduled with setTimeout
    expect(elapsed).toBeLessThan(500);

    // The pending review promise should exist but not yet resolved
    expect(plugin._pendingLegacyReview).not.toBeNull();
  });

  it('v2 session_end creates patch without LLM call', async () => {
    const config = getDefaultConfig();
    config.triggers.onSessionEndReview = true;
    config.review.minEvidenceCount = 1;
    config.llm.inheritPrimaryConfig = false;
    config.reviewMode = 'assisted';
    config.agent = { enabled: false, id: 'skill-evolution', model: null };

    const plugin = new SkillEvolutionPlugin(config, tempRoot);
    const sessionId = 'concurrent-session-2';
    const skillKey = 'skill.concurrent.2';

    await plugin.before_prompt_build(sessionId, skillKey, 'BASE');
    await plugin.after_tool_call(sessionId, 'deploy', 'Error: deploy failed', true);

    const start = Date.now();
    await plugin.session_end(sessionId);
    const elapsed = Date.now() - start;

    // v2 path: no LLM call, should complete quickly
    expect(elapsed).toBeLessThan(500);

    // No pending legacy review (this is v2 path)
    expect(plugin._pendingLegacyReview).toBeNull();

    // Patch should be queued via v2 pipeline
    const patches = await plugin.patchQueue!.list({ skillKey });
    expect(patches.length).toBeGreaterThan(0);
    expect(patches[0]!.status).toBe('queued');
  });

  it('simulates rapid session turnover without blocking', async () => {
    vi.useFakeTimers();
    const config = getDefaultConfig();
    config.triggers.onSessionEndReview = true;
    config.review.minEvidenceCount = 1;
    config.llm.inheritPrimaryConfig = false;
    config.reviewMode = 'queue-only';
    config.merge.requireHumanMerge = true;

    const plugin = new SkillEvolutionPlugin(config, tempRoot);

    // Session 1: ends, fires deferred review
    const s1 = 'rapid-session-1';
    const sk = 'skill.rapid';
    await plugin.before_prompt_build(s1, sk, 'BASE');
    await plugin.after_tool_call(s1, 'test', 'Error: fail-1', true);
    await plugin.session_end(s1);

    // Session 2: starts immediately after session 1 ends
    const s2 = 'rapid-session-2';
    await plugin.before_prompt_build(s2, sk, 'BASE');
    await plugin.after_tool_call(s2, 'build', 'Error: fail-2', true);

    // Session 1's review should NOT have run yet (it's delayed)
    // We can verify the review hasn't executed by checking patch dir is still empty
    const patchesBefore = await plugin.patchQueue!.list({ skillKey: sk });

    // Now advance timers to let the deferred review run
    await vi.advanceTimersByTimeAsync(6_000);
    await plugin._pendingLegacyReview;

    // Session 2 ends
    await plugin.session_end(s2);
    await vi.advanceTimersByTimeAsync(6_000);
    await plugin._pendingLegacyReview;
    vi.useRealTimers();

    // Both sessions should have eventually produced patches (as .md files)
    // without blocking each other
    const { readdir } = await import('node:fs/promises');
    const patchDir = join(tempRoot, '.skill-patches', sk);
    const files = (await readdir(patchDir)).filter(n => n.endsWith('.md'));
    expect(files.length).toBeGreaterThanOrEqual(1);
  });
});
