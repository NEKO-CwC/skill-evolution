import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewOrchestrator } from '../../src/review/review_orchestrator.ts';
import { PatchQueueManager } from '../../src/review/patch_queue.ts';
import { getDefaultConfig } from '../../src/plugin/config.ts';
import type { PatchCandidate, ReviewResult, ReviewRunner, SessionSummary } from '../../src/shared/types.ts';

function makePatch(overrides?: Partial<PatchCandidate>): PatchCandidate {
  const now = new Date().toISOString();
  return {
    id: `patch_orch_${Date.now()}`,
    skillKey: 'skill.orch',
    status: 'queued',
    risk: 'low',
    sourceSessionIds: ['s1'],
    createdAt: now,
    updatedAt: now,
    summary: 'test',
    justification: 'test justification',
    proposedDiff: 'new content',
    originalContent: 'old content',
    artifactVersion: 1,
    ...overrides,
  };
}

function makeReviewRunner(options?: { recommend?: boolean; risk?: 'low' | 'medium' | 'high' }): ReviewRunner {
  const recommend = options?.recommend ?? true;
  const risk = options?.risk ?? 'low';
  return {
    async runReview(summary: SessionSummary): Promise<ReviewResult> {
      return {
        isModificationRecommended: recommend,
        justification: 'Test review',
        proposedDiff: 'reviewed content',
        riskLevel: risk,
        metadata: {
          skillKey: summary.skillKey,
          patchId: `patch_${Date.now()}`,
          baseVersion: 'latest',
          sourceSessionId: summary.sessionId,
          mergeMode: 'manual',
          riskLevel: risk,
          rollbackChainDepth: 0,
        },
      };
    },
  };
}

function makeSummary(overrides?: Partial<SessionSummary>): SessionSummary {
  return {
    sessionId: 's1',
    skillKey: 'skill.orch',
    events: [],
    overlays: [],
    durationMs: 1000,
    totalErrors: 0,
    ...overrides,
  };
}

describe('review/review_orchestrator', () => {
  let tempDir: string;
  let patchQueue: PatchQueueManager;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'review-orch-test-'));
    patchQueue = new PatchQueueManager(join(tempDir, '.skill-patches'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('enqueue', () => {
    it('does nothing for reviewMode=off', async () => {
      const config = { ...getDefaultConfig(), reviewMode: 'off' as const };
      const orch = new ReviewOrchestrator(config, patchQueue, makeReviewRunner());

      const patch = makePatch({ id: 'orch_off' });
      await patchQueue.create(patch);
      await orch.enqueue('orch_off');

      const updated = await patchQueue.get('orch_off');
      expect(updated.status).toBe('queued');
    });

    it('does nothing for reviewMode=queue-only', async () => {
      const config = { ...getDefaultConfig(), reviewMode: 'queue-only' as const };
      const orch = new ReviewOrchestrator(config, patchQueue, makeReviewRunner());

      const patch = makePatch({ id: 'orch_qo' });
      await patchQueue.create(patch);
      await orch.enqueue('orch_qo');

      const updated = await patchQueue.get('orch_qo');
      expect(updated.status).toBe('queued');
    });

    it('runs LLM fallback review for reviewMode=assisted', async () => {
      const config = {
        ...getDefaultConfig(),
        reviewMode: 'assisted' as const,
        agents: {
          ...getDefaultConfig().agents!,
          review: { ...getDefaultConfig().agents!.review, enabled: false },
        },
      };
      const orch = new ReviewOrchestrator(config, patchQueue, makeReviewRunner());

      const patch = makePatch({ id: 'orch_assisted' });
      await patchQueue.create(patch);
      await orch.enqueue('orch_assisted');

      const updated = await patchQueue.get('orch_assisted');
      expect(updated.status).toBe('ready');
    });

    it('falls back to LLM when agent spawn fails for assisted mode', async () => {
      const config = {
        ...getDefaultConfig(),
        reviewMode: 'assisted' as const,
        agents: {
          ...getDefaultConfig().agents!,
          review: { ...getDefaultConfig().agents!.review, enabled: true },
        },
      };
      const orch = new ReviewOrchestrator(config, patchQueue, makeReviewRunner());

      const patch = makePatch({ id: 'orch_fallback' });
      await patchQueue.create(patch);
      await orch.enqueue('orch_fallback');

      // Agent spawn always fails (placeholder), so falls back to LLM
      const updated = await patchQueue.get('orch_fallback');
      expect(updated.status).toBe('ready');
    });
  });

  describe('processReview', () => {
    it('transitions patch through reviewing -> ready', async () => {
      const orch = new ReviewOrchestrator(getDefaultConfig(), patchQueue, makeReviewRunner());

      const patch = makePatch({ id: 'orch_proc_1' });
      await patchQueue.create(patch);

      await orch.processReview('orch_proc_1', makeSummary());

      const updated = await patchQueue.get('orch_proc_1');
      expect(updated.status).toBe('ready');
      expect(updated.reviewOutput).toBeTruthy();
      expect(updated.reviewOutput!.suggestedAction).toBe('apply');
    });

    it('does not transition when review says no modification', async () => {
      const runner = makeReviewRunner({ recommend: false });
      const orch = new ReviewOrchestrator(getDefaultConfig(), patchQueue, runner);

      const patch = makePatch({ id: 'orch_proc_2' });
      await patchQueue.create(patch);

      await orch.processReview('orch_proc_2', makeSummary());

      const updated = await patchQueue.get('orch_proc_2');
      expect(updated.status).toBe('reviewing');
    });

    it('auto-approves low-risk patches in auto-low-risk mode', async () => {
      const config = {
        ...getDefaultConfig(),
        reviewMode: 'auto-low-risk' as const,
        risk: { autoApplyMaxRisk: 'low' as const, notifyMinRisk: 'low' as const },
      };
      const orch = new ReviewOrchestrator(config, patchQueue, makeReviewRunner({ risk: 'low' }));

      const patch = makePatch({ id: 'orch_auto_1' });
      await patchQueue.create(patch);

      await orch.processReview('orch_auto_1', makeSummary());

      const updated = await patchQueue.get('orch_auto_1');
      expect(updated.status).toBe('approved');
    });

    it('does not auto-approve high-risk patches in auto-low-risk mode', async () => {
      const config = {
        ...getDefaultConfig(),
        reviewMode: 'auto-low-risk' as const,
        risk: { autoApplyMaxRisk: 'low' as const, notifyMinRisk: 'low' as const },
      };
      const orch = new ReviewOrchestrator(config, patchQueue, makeReviewRunner({ risk: 'high' }));

      const patch = makePatch({ id: 'orch_auto_2' });
      await patchQueue.create(patch);

      await orch.processReview('orch_auto_2', makeSummary());

      const updated = await patchQueue.get('orch_auto_2');
      expect(updated.status).toBe('ready');
    });

    it('transitions to failed on review error', async () => {
      const failingRunner: ReviewRunner = {
        async runReview(): Promise<ReviewResult> {
          throw new Error('Review crashed');
        },
      };
      const orch = new ReviewOrchestrator(getDefaultConfig(), patchQueue, failingRunner);

      const patch = makePatch({ id: 'orch_fail' });
      await patchQueue.create(patch);

      await orch.processReview('orch_fail', makeSummary());

      const updated = await patchQueue.get('orch_fail');
      expect(updated.status).toBe('failed');
    });
  });

  describe('scheduleNotify', () => {
    it('is a no-op when notify is disabled', async () => {
      const config = getDefaultConfig();
      config.notify = { enabled: false, mode: 'off', channel: 'same-thread' };
      const orch = new ReviewOrchestrator(config, patchQueue, makeReviewRunner());

      // Should not throw
      await orch.scheduleNotify('any-patch');
    });

    it('logs when notify is enabled', async () => {
      const config = getDefaultConfig();
      config.notify = { enabled: true, mode: 'per-session', channel: 'same-thread' };
      const orch = new ReviewOrchestrator(config, patchQueue, makeReviewRunner());

      // Should not throw
      await orch.scheduleNotify('any-patch');
    });
  });
});
