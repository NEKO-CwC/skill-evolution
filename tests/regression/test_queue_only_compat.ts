import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chdir, cwd } from 'node:process';
import { getDefaultConfig } from '../../src/plugin/config.ts';
import { SkillEvolutionPlugin } from '../../src/plugin/index.ts';

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function buildPlugin(
  tempRoot: string,
  overrides?: Partial<ReturnType<typeof getDefaultConfig>>
): SkillEvolutionPlugin {
  const config = getDefaultConfig();
  config.sessionOverlay.storageDir = '.skill-overlays';
  config.triggers.onSessionEndReview = true;
  config.review.minEvidenceCount = 1;
  config.merge.requireHumanMerge = true;
  config.llm.inheritPrimaryConfig = false;
  Object.assign(config, overrides);
  return new SkillEvolutionPlugin(config, tempRoot);
}

describe('Regression: queue-only compat', () => {
  let tempRoot = '';
  let previousCwd = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'queue-only-compat-'));
    previousCwd = cwd();
    chdir(tempRoot);
  });

  afterEach(async () => {
    chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('queue-only with requireHumanMerge=true: patches queued as .md, no auto-merge', async () => {
    vi.useFakeTimers();
    const plugin = buildPlugin(tempRoot, {
      reviewMode: 'queue-only',
      merge: { requireHumanMerge: true, maxRollbackVersions: 5 },
    });

    const skillKey = 'skill.compat.1';
    const skillDir = join('skills', skillKey);
    const skillFilePath = join(skillDir, 'SKILL.md');
    await mkdir(skillDir, { recursive: true });
    await writeFile(skillFilePath, 'ORIGINAL_CONTENT', 'utf8');

    const sessionId = 'compat-session-1';
    await plugin.before_prompt_build(sessionId, skillKey, 'BASE');
    await plugin.after_tool_call(sessionId, 'build', 'Error: compile failed', true);
    await plugin.session_end(sessionId);

    await vi.advanceTimersByTimeAsync(6_000);
    await plugin._pendingLegacyReview;
    vi.useRealTimers();

    // SKILL.md should be untouched
    const content = await readFile(skillFilePath, 'utf8');
    expect(content).toBe('ORIGINAL_CONTENT');

    // Patch should be queued as .md file
    const patchDir = join('.skill-patches', skillKey);
    expect(await pathExists(patchDir)).toBe(true);
    const patchFiles = (await readdir(patchDir)).filter((n) => n.endsWith('.md'));
    expect(patchFiles.length).toBeGreaterThan(0);
  });

  it('queue-only with requireHumanMerge=false: auto-merges directly', async () => {
    vi.useFakeTimers();
    const plugin = buildPlugin(tempRoot, {
      reviewMode: 'queue-only',
      merge: { requireHumanMerge: false, maxRollbackVersions: 5 },
    });

    const skillKey = 'skill.compat.2';
    const sessionId = 'compat-session-2';

    await plugin.before_prompt_build(sessionId, skillKey, 'BASE');
    await plugin.after_tool_call(sessionId, 'test', 'Error: assertion failed', true);
    await plugin.session_end(sessionId);

    await vi.advanceTimersByTimeAsync(6_000);
    await plugin._pendingLegacyReview;
    vi.useRealTimers();

    const skillFilePath = join('skills', skillKey, 'SKILL.md');
    expect(await pathExists(skillFilePath)).toBe(true);

    const content = await readFile(skillFilePath, 'utf8');
    expect(content).toContain(`--- PATCH: ${skillKey} ---`);
  });

  it('no reviewMode set + onSessionEndReview=false -> derived off, no patch', async () => {
    const config = getDefaultConfig();
    config.triggers.onSessionEndReview = false;
    config.review.minEvidenceCount = 1;
    config.llm.inheritPrimaryConfig = false;
    // deliberately omit reviewMode to test backward compat derivation
    delete (config as Record<string, unknown>).reviewMode;

    const plugin = new SkillEvolutionPlugin(config, tempRoot);
    const sessionId = 'compat-session-3';
    const skillKey = 'skill.compat.3';

    await plugin.before_prompt_build(sessionId, skillKey, 'BASE');
    await plugin.after_tool_call(sessionId, 'run', 'Error: failed', true);
    await plugin.session_end(sessionId);

    const skillFilePath = join('skills', skillKey, 'SKILL.md');
    expect(await pathExists(skillFilePath)).toBe(false);

    const patchDir = join('.skill-patches', skillKey);
    expect(await pathExists(patchDir)).toBe(false);
  });
});
