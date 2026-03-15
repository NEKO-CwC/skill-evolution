import { access, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chdir, cwd } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

function buildPlugin(tempRoot: string, requireHumanMerge: boolean, maxRollbackVersions = 5): SkillEvolutionPlugin {
  const config = getDefaultConfig();
  config.sessionOverlay.storageDir = '.skill-overlays';
  config.triggers.onSessionEndReview = true;
  config.review.minEvidenceCount = 1;
  config.merge.requireHumanMerge = requireHumanMerge;
  config.merge.maxRollbackVersions = maxRollbackVersions;
  config.llm.inheritPrimaryConfig = false;
  return new SkillEvolutionPlugin(config, tempRoot);
}

describe('Workflow 1: Tool error -> overlay creation', () => {
  let tempRoot = '';
  let previousCwd = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'skill-workflow-1-'));
    previousCwd = cwd();
    chdir(tempRoot);
  });

  afterEach(async () => {
    chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('collects tool_error, writes overlay, and injects overlay into next prompt', async () => {
    const plugin = buildPlugin(tempRoot, false);
    const sessionId = 'workflow-1-session';
    const skillKey = 'skill.workflow.1';

    const firstPrompt = await plugin.before_prompt_build(sessionId, skillKey, 'BASE_PROMPT');
    expect(firstPrompt).toBe('BASE_PROMPT');

    await plugin.after_tool_call(sessionId, 'shell', 'Error: command failed', true);

    const events = await plugin.feedbackCollector.getSessionFeedback(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('tool_error');

    const overlays = await plugin.overlayStore.listBySession(sessionId);
    expect(overlays).toHaveLength(1);
    expect(overlays[0]?.content).toContain('Tool error observed for shell');

    const overlayPath = join(
      tempRoot,
      '.skill-overlays',
      encodeURIComponent(sessionId),
      `${encodeURIComponent(skillKey)}.json`
    );
    expect(await pathExists(overlayPath)).toBe(true);

    const secondPrompt = await plugin.before_prompt_build(sessionId, skillKey, 'BASE_PROMPT');
    expect(secondPrompt).toContain('--- SKILL OVERLAY (session-local) ---');
    expect(secondPrompt).toContain('Error excerpt: Error: command failed');
    expect(secondPrompt).toContain('BASE_PROMPT');
  });
});

describe('Workflow 2: Session end -> review -> patch generation', () => {
  let tempRoot = '';
  let previousCwd = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'skill-workflow-2-'));
    previousCwd = cwd();
    chdir(tempRoot);
  });

  afterEach(async () => {
    chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('runs review on session_end, writes merged content, and clears overlays', async () => {
    const plugin = buildPlugin(tempRoot, false);
    const sessionId = 'workflow-2-session';
    const skillKey = 'skill.workflow.2';

    await plugin.before_prompt_build(sessionId, skillKey, 'BASE');
    await plugin.after_tool_call(sessionId, 'build', 'Error: unresolved symbol', true);
    await plugin.session_end(sessionId);

    const skillFilePath = join('skills', skillKey, 'SKILL.md');
    expect(await pathExists(skillFilePath)).toBe(true);

    const merged = await readFile(skillFilePath, 'utf8');
    expect(merged).toContain(`--- PATCH: ${skillKey} ---`);
    expect(merged).toContain('## Proposed Changes');
    expect(merged).toContain('Error excerpt: Error: unresolved symbol');

    const overlaysAfterEnd = await plugin.overlayStore.listBySession(sessionId);
    expect(overlaysAfterEnd).toHaveLength(0);
  });
});

describe('Workflow 3: Manual merge blocks auto-write', () => {
  let tempRoot = '';
  let previousCwd = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'skill-workflow-3-'));
    previousCwd = cwd();
    chdir(tempRoot);
  });

  afterEach(async () => {
    chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('does not modify SKILL.md and queues patch under .skill-patches', async () => {
    const plugin = buildPlugin(tempRoot, true);
    const sessionId = 'workflow-3-session';
    const skillKey = 'skill.workflow.3';

    const skillDir = join('skills', skillKey);
    const skillFilePath = join(skillDir, 'SKILL.md');
    await mkdir(skillDir, { recursive: true });
    await writeFile(skillFilePath, 'ORIGINAL_SKILL_CONTENT', 'utf8');

    await plugin.before_prompt_build(sessionId, skillKey, 'BASE');
    await plugin.after_tool_call(sessionId, 'lint', 'Error: style violation', true);
    await plugin.session_end(sessionId);

    const after = await readFile(skillFilePath, 'utf8');
    expect(after).toBe('ORIGINAL_SKILL_CONTENT');

    const patchDir = join('.skill-patches', skillKey);
    expect(await pathExists(patchDir)).toBe(true);

    const patchFiles = (await readdir(patchDir)).filter((name) => name.endsWith('.md'));
    expect(patchFiles.length).toBeGreaterThan(0);

    const patchText = await readFile(join(patchDir, patchFiles[0] ?? ''), 'utf8');
    expect(patchText).toContain(`--- PATCH: ${skillKey} ---`);
    expect(patchText).toContain('Error excerpt: Error: style violation');
  });
});

describe('Workflow 4: Auto merge writes + backs up + prunes', () => {
  let tempRoot = '';
  let previousCwd = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'skill-workflow-4-'));
    previousCwd = cwd();
    chdir(tempRoot);
  });

  afterEach(async () => {
    chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('writes SKILL.md, creates backups each merge, and prunes to maxRollbackVersions=3', async () => {
    const plugin = buildPlugin(tempRoot, false, 3);
    const skillKey = 'skill.workflow.4';
    const skillFilePath = join('skills', skillKey, 'SKILL.md');
    const backupDir = join('.skill-backups', skillKey);

    for (let i = 1; i <= 5; i += 1) {
      const sessionId = `workflow-4-session-${i}`;
      const previousContent = (await pathExists(skillFilePath)) ? await readFile(skillFilePath, 'utf8') : '';

      await plugin.before_prompt_build(sessionId, skillKey, 'BASE');
      await plugin.after_tool_call(sessionId, 'test', `Error: iteration-${i}`, true);
      await plugin.session_end(sessionId);

      const skillContent = await readFile(skillFilePath, 'utf8');
      expect(skillContent).toContain(`Source Session: ${sessionId}`);

      const backupFiles = (await readdir(backupDir)).filter((name) => name.endsWith('.json'));
      expect(backupFiles.length).toBe(Math.min(i, 3));

      const backupPayloads = await Promise.all(
        backupFiles.map(async (fileName) => {
          const raw = await readFile(join(backupDir, fileName), 'utf8');
          return JSON.parse(raw) as { content: string };
        })
      );
      expect(backupPayloads.some((entry) => entry.content === previousContent)).toBe(true);

      await delay(2);
    }

    const finalBackups = (await readdir(backupDir)).filter((name) => name.endsWith('.json'));
    expect(finalBackups).toHaveLength(3);
  });
});

describe('Workflow 5: Multi-turn lifecycle split', () => {
  let tempRoot = '';
  let previousCwd = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'skill-workflow-5-'));
    previousCwd = cwd();
    chdir(tempRoot);
  });

  afterEach(async () => {
    chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('keeps overlays across agent_end and applies review+cleanup at session_end', async () => {
    const plugin = buildPlugin(tempRoot, false);
    const sessionId = 'workflow-5-session';
    const skillKey = 'skill.workflow.5';
    const skillFilePath = join('skills', skillKey, 'SKILL.md');

    const firstPrompt = await plugin.before_prompt_build(sessionId, skillKey, 'BASE_PROMPT');
    expect(firstPrompt).toBe('BASE_PROMPT');

    await plugin.after_tool_call(sessionId, 'shell', 'Error: command failed first', true);

    await plugin.agent_end(sessionId);

    const overlaysAfterAgentEnd = await plugin.overlayStore.listBySession(sessionId);
    expect(overlaysAfterAgentEnd.length).toBeGreaterThan(0);
    expect(await pathExists(skillFilePath)).toBe(false);

    const secondPrompt = await plugin.before_prompt_build(sessionId, skillKey, 'BASE_PROMPT');
    expect(secondPrompt).toContain('--- SKILL OVERLAY (session-local) ---');
    expect(secondPrompt).toContain('Error excerpt: Error: command failed first');

    await plugin.after_tool_call(sessionId, 'shell', 'Error: command failed second', true);

    await plugin.session_end(sessionId);

    expect(await pathExists(skillFilePath)).toBe(true);
    const merged = await readFile(skillFilePath, 'utf8');
    expect(merged).toContain(`--- PATCH: ${skillKey} ---`);
    expect(merged).toContain('## Proposed Changes');

    const overlaysAfterSessionEnd = await plugin.overlayStore.listBySession(sessionId);
    expect(overlaysAfterSessionEnd).toHaveLength(0);
  });
});
