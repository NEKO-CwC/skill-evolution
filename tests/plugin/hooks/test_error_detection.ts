import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chdir, cwd } from 'node:process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDefaultConfig } from '../../../src/plugin/config.ts';
import { SkillEvolutionPlugin } from '../../../src/plugin/index.ts';

function buildPlugin(tempRoot: string): SkillEvolutionPlugin {
  const config = getDefaultConfig();
  config.review.minEvidenceCount = 1;
  return new SkillEvolutionPlugin(config, tempRoot);
}

describe('after_tool_call error detection', () => {
  let tempRoot = '';
  let previousCwd = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'skill-error-detection-'));
    previousCwd = cwd();
    chdir(tempRoot);
  });

  afterEach(async () => {
    chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('creates overlay when explicit isError=true', async () => {
    const plugin = buildPlugin(tempRoot);
    const sessionId = 'error-detect-1';
    await plugin.before_prompt_build(sessionId, 'skill.error.1', 'BASE');

    await plugin.after_tool_call(sessionId, 'shell', 'failed', true, { status: 'success' });

    const overlays = await plugin.overlayStore.listBySession(sessionId);
    expect(overlays).toHaveLength(1);
  });

  it('creates overlay when rawResult has status=error', async () => {
    const plugin = buildPlugin(tempRoot);
    const sessionId = 'error-detect-2';
    await plugin.before_prompt_build(sessionId, 'skill.error.2', 'BASE');

    await plugin.after_tool_call(sessionId, 'shell', 'failed', false, { status: 'error' });

    const overlays = await plugin.overlayStore.listBySession(sessionId);
    expect(overlays).toHaveLength(1);
  });

  it('creates overlay when rawResult has non-empty error field', async () => {
    const plugin = buildPlugin(tempRoot);
    const sessionId = 'error-detect-3';
    await plugin.before_prompt_build(sessionId, 'skill.error.3', 'BASE');

    await plugin.after_tool_call(sessionId, 'shell', 'failed', false, { error: 'something went wrong' });

    const overlays = await plugin.overlayStore.listBySession(sessionId);
    expect(overlays).toHaveLength(1);
  });

  it('does not create overlay when rawResult status=success', async () => {
    const plugin = buildPlugin(tempRoot);
    const sessionId = 'error-detect-4';
    await plugin.before_prompt_build(sessionId, 'skill.error.4', 'BASE');

    await plugin.after_tool_call(sessionId, 'shell', 'success', false, { status: 'success' });

    const overlays = await plugin.overlayStore.listBySession(sessionId);
    expect(overlays).toHaveLength(0);
  });

  it('does not create overlay when rawResult is undefined', async () => {
    const plugin = buildPlugin(tempRoot);
    const sessionId = 'error-detect-5';
    await plugin.before_prompt_build(sessionId, 'skill.error.5', 'BASE');

    await plugin.after_tool_call(sessionId, 'shell', 'success', false, undefined);

    const overlays = await plugin.overlayStore.listBySession(sessionId);
    expect(overlays).toHaveLength(0);
  });

  it('does not create overlay when rawResult is string', async () => {
    const plugin = buildPlugin(tempRoot);
    const sessionId = 'error-detect-6';
    await plugin.before_prompt_build(sessionId, 'skill.error.6', 'BASE');

    await plugin.after_tool_call(sessionId, 'shell', 'success', false, 'some string');

    const overlays = await plugin.overlayStore.listBySession(sessionId);
    expect(overlays).toHaveLength(0);
  });
});
