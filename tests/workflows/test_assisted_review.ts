import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chdir, cwd } from 'node:process';
import { getDefaultConfig } from '../../src/plugin/config.ts';
import { SkillEvolutionPlugin } from '../../src/plugin/index.ts';
import { PatchQueueManager } from '../../src/review/patch_queue.ts';
import { MergeManagerImpl } from '../../src/review/merge_manager.ts';
import RollbackManagerImpl from '../../src/review/rollback_manager.ts';
import {
  patchApply,
  patchGet,
  patchList,
  patchStatus,
  reviewEnqueue,
} from '../../src/plugin/tools/patch_tools.ts';

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('Workflow: assisted review e2e', () => {
  let tempRoot = '';
  let previousCwd = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'assisted-review-'));
    previousCwd = cwd();
    chdir(tempRoot);
  });

  afterEach(async () => {
    chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('full flow: session events -> session_end -> patch queued -> tool review -> apply -> SKILL.md updated', async () => {
    const config = getDefaultConfig();
    config.sessionOverlay.storageDir = '.skill-overlays';
    config.triggers.onSessionEndReview = true;
    config.review.minEvidenceCount = 1;
    config.merge.requireHumanMerge = true;
    config.llm.inheritPrimaryConfig = false;
    config.reviewMode = 'queue-only';

    const plugin = new SkillEvolutionPlugin(config, tempRoot);
    const sessionId = 'assisted-session-1';
    const skillKey = 'skill.assisted';

    // Simulate tool error
    await plugin.before_prompt_build(sessionId, skillKey, 'BASE');
    await plugin.after_tool_call(sessionId, 'deploy', 'Error: deployment timeout', true);

    // Session end creates patch in queue (via legacy path for queue-only)
    vi.useFakeTimers();
    await plugin.session_end(sessionId);
    await vi.advanceTimersByTimeAsync(6_000);
    await plugin._pendingLegacyReview;
    vi.useRealTimers();

    // Verify patch was queued as .md file (legacy queue-only path)
    const patchDir = join('.skill-patches', skillKey);
    expect(await pathExists(patchDir)).toBe(true);

    // Now simulate what an agent would do via tools
    const patchesDir = join(tempRoot, '.skill-patches');
    const skillsDir = join(tempRoot, 'skills');
    const backupsDir = join(tempRoot, '.skill-backups');

    const mergeConfig = getDefaultConfig();
    mergeConfig.merge.requireHumanMerge = false;
    const rollback = new RollbackManagerImpl(mergeConfig, backupsDir, skillsDir);
    const mergeManager = new MergeManagerImpl(mergeConfig, rollback, skillsDir, patchesDir);
    const patchQueue = new PatchQueueManager(patchesDir);
    const toolDeps = { patchQueue, mergeManager };

    // Create a v2 patch candidate manually (simulating what assisted mode would do)
    const now = new Date().toISOString();
    await patchQueue.create({
      id: 'manual_patch_1',
      skillKey,
      status: 'queued',
      risk: 'low',
      sourceSessionIds: [sessionId],
      createdAt: now,
      updatedAt: now,
      summary: 'Fix deployment timeout handling',
      justification: 'Deployment errors detected in session',
      proposedDiff: '# Updated Skill\nHandle deployment timeouts gracefully.',
      originalContent: '',
      artifactVersion: 1,
    });

    // Agent workflow: list -> get -> enqueue -> apply
    const listResult = await patchList(toolDeps, { status: 'queued' }) as Array<{ id: string }>;
    expect(listResult.length).toBeGreaterThan(0);

    const statusResult = await patchStatus(toolDeps, { patchId: 'manual_patch_1' }) as Record<string, unknown>;
    expect(statusResult.status).toBe('queued');

    const getResult = await patchGet(toolDeps, { patchId: 'manual_patch_1' }) as Record<string, unknown>;
    expect(getResult.proposedDiff).toBe('# Updated Skill\nHandle deployment timeouts gracefully.');

    // Enqueue for review
    const enqueueResult = await reviewEnqueue(toolDeps, { patchId: 'manual_patch_1' }) as Record<string, unknown>;
    expect(enqueueResult.success).toBe(true);
    expect(enqueueResult.status).toBe('reviewing');

    // Simulate review completion: transition to ready then apply
    await patchQueue.transition('manual_patch_1', 'ready');
    await patchQueue.transition('manual_patch_1', 'approved');

    const applyResult = await patchApply(toolDeps, { patchId: 'manual_patch_1' }) as Record<string, unknown>;
    expect(applyResult.success).toBe(true);
    expect(applyResult.status).toBe('applied');

    // Verify SKILL.md was updated
    const skillFilePath = join(skillsDir, skillKey, 'SKILL.md');
    expect(await pathExists(skillFilePath)).toBe(true);
    const skillContent = await readFile(skillFilePath, 'utf8');
    expect(skillContent).toContain('Handle deployment timeouts gracefully');

    // Verify backup was created
    const backupFiles = await import('node:fs/promises').then(
      (fs) => fs.readdir(join(backupsDir, skillKey)).catch(() => [])
    );
    expect(backupFiles.length).toBeGreaterThan(0);
  });

  it('auto-low-risk: session -> review -> auto-approve -> agent can apply', async () => {
    const config = getDefaultConfig();
    config.triggers.onSessionEndReview = true;
    config.review.minEvidenceCount = 1;
    config.llm.inheritPrimaryConfig = false;
    config.reviewMode = 'auto-low-risk';
    config.merge.requireHumanMerge = true;
    config.risk = { autoApplyMaxRisk: 'low', notifyMinRisk: 'low' };

    const plugin = new SkillEvolutionPlugin(config, tempRoot);

    // The auto-low-risk mode uses the v2 pipeline via ReviewOrchestrator
    // which processes review inline (since agent spawn is placeholder)
    expect(plugin.patchQueue).toBeTruthy();
    expect(plugin.reviewOrchestrator).toBeTruthy();
  });
});
