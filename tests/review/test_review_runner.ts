import { describe, expect, it } from 'vitest';
import { ReviewRunnerImpl } from '../../src/review/review_runner.ts';
import { ReviewFailedError } from '../../src/shared/errors.ts';
import { getDefaultConfig } from '../../src/plugin/config.ts';
import type { FeedbackEvent, SessionSummary } from '../../src/shared/types.ts';

describe('review/review_runner', () => {
  const baseSummary = (totalErrors: number, overlaysCount: number, events: FeedbackEvent[] = []): SessionSummary => ({
    sessionId: 'session-1',
    skillKey: 'skill.alpha',
    events,
    overlays: Array.from({ length: overlaysCount }, (_, idx) => ({
      sessionId: 'session-1',
      skillKey: 'skill.alpha',
      content: `overlay-${idx + 1}`,
      createdAt: idx,
      updatedAt: idx,
      reasoning: 'reason'
    })),
    durationMs: 100,
    totalErrors
  });

  const correctionEvent = (idx: number): FeedbackEvent => ({
    sessionId: 'session-1',
    skillKey: 'skill.alpha',
    timestamp: idx,
    eventType: 'user_correction',
    severity: 'medium'
  });

  it('uses low risk for 0 and 1 total signals (errors + corrections)', async () => {
    const runner = new ReviewRunnerImpl();
    await expect(runner.runReview(baseSummary(0, 0))).resolves.toMatchObject({ riskLevel: 'low' });
    await expect(runner.runReview(baseSummary(1, 0))).resolves.toMatchObject({ riskLevel: 'low' });
    await expect(
      runner.runReview(baseSummary(0, 0, [correctionEvent(1)]))
    ).resolves.toMatchObject({ riskLevel: 'low' });
  });

  it('uses medium risk for 2-3 total signals', async () => {
    const runner = new ReviewRunnerImpl();
    await expect(runner.runReview(baseSummary(2, 0))).resolves.toMatchObject({ riskLevel: 'medium' });
    await expect(runner.runReview(baseSummary(3, 0))).resolves.toMatchObject({ riskLevel: 'medium' });
    await expect(
      runner.runReview(baseSummary(1, 0, [correctionEvent(1)]))
    ).resolves.toMatchObject({ riskLevel: 'medium' });
  });

  it('uses high risk for 4 or more total signals', async () => {
    const runner = new ReviewRunnerImpl();
    await expect(runner.runReview(baseSummary(4, 0))).resolves.toMatchObject({ riskLevel: 'high' });
    await expect(runner.runReview(baseSummary(10, 0))).resolves.toMatchObject({ riskLevel: 'high' });
  });

  it('recommends modification when there are errors', async () => {
    const runner = new ReviewRunnerImpl();
    await expect(runner.runReview(baseSummary(1, 0))).resolves.toMatchObject({ isModificationRecommended: true });
  });

  it('recommends modification when there are corrections but no errors or overlays', async () => {
    const runner = new ReviewRunnerImpl();
    await expect(
      runner.runReview(baseSummary(0, 0, [correctionEvent(1)]))
    ).resolves.toMatchObject({ isModificationRecommended: true });
  });

  it('recommends modification when there are overlays even with zero errors', async () => {
    const runner = new ReviewRunnerImpl();
    await expect(runner.runReview(baseSummary(0, 1))).resolves.toMatchObject({ isModificationRecommended: true });
  });

  it('does not recommend modification when no errors, no corrections, and no overlays', async () => {
    const runner = new ReviewRunnerImpl();
    await expect(runner.runReview(baseSummary(0, 0))).resolves.toMatchObject({ isModificationRecommended: false });
  });

  it('sets mergeMode to manual when requireHumanMerge is true', async () => {
    const config = getDefaultConfig();
    config.merge.requireHumanMerge = true;
    const runner = new ReviewRunnerImpl(config);
    const result = await runner.runReview(baseSummary(1, 0));
    expect(result.metadata.mergeMode).toBe('manual');
  });

  it('sets mergeMode to auto when requireHumanMerge is false', async () => {
    const config = getDefaultConfig();
    config.merge.requireHumanMerge = false;
    const runner = new ReviewRunnerImpl(config);
    const result = await runner.runReview(baseSummary(1, 0));
    expect(result.metadata.mergeMode).toBe('auto');
  });

  it('joins overlay contents into proposedDiff with blank line separator', async () => {
    const runner = new ReviewRunnerImpl();
    const result = await runner.runReview(baseSummary(0, 2));
    expect(result.proposedDiff).toBe('overlay-1\n\noverlay-2');
  });

  it('includes correction and positive counts in justification', async () => {
    const runner = new ReviewRunnerImpl();
    const result = await runner.runReview(baseSummary(1, 0, [correctionEvent(1)]));
    expect(result.justification).toContain('1 corrections');
    expect(result.justification).toContain('1 errors');
  });

  it('wraps unexpected errors as ReviewFailedError', async () => {
    const runner = new ReviewRunnerImpl();
    const invalidSummary = {
      ...baseSummary(1, 0),
      overlays: null
    } as unknown as SessionSummary;

    await expect(runner.runReview(invalidSummary)).rejects.toBeInstanceOf(ReviewFailedError);
  });
});
