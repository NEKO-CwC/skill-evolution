import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDefaultConfig } from '../../src/plugin/config.ts';
import { SkillEvolutionPlugin } from '../../src/plugin/index.ts';

describe('Regression: Pure user correction triggers review recommendation', () => {
  let tempRoot = '';
  let plugin: SkillEvolutionPlugin;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'skill-regression-correction-'));
    const config = getDefaultConfig();
    config.review.minEvidenceCount = 1;
    config.merge.requireHumanMerge = true;
    config.llm.inheritPrimaryConfig = false;
    plugin = new SkillEvolutionPlugin(config, tempRoot);
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('single user correction with no tool errors triggers isModificationRecommended=true', async () => {
    const sessionId = 'correction-only-session';
    const skillKey = 'skill.correction-test';

    await plugin.before_prompt_build(sessionId, skillKey, 'BASE');
    await plugin.message_received(sessionId, 'This is wrong, fix this immediately');

    const events = await plugin.feedbackCollector.getSessionFeedback(sessionId);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e.eventType !== 'tool_error')).toBe(true);

    const overlays = await plugin.overlayStore.listBySession(sessionId);
    expect(overlays.length).toBeGreaterThanOrEqual(1);

    const review = await plugin.reviewRunner.runReview({
      sessionId,
      skillKey,
      events,
      overlays,
      durationMs: 500,
      totalErrors: 0
    });

    expect(review.isModificationRecommended).toBe(true);
    expect(review.riskLevel).toBe('low');
    expect(review.metadata.mergeMode).toBe('manual');
  });

  it('multiple corrections increase risk level', async () => {
    const sessionId = 'multi-correction-session';
    const skillKey = 'skill.multi-correction';

    await plugin.before_prompt_build(sessionId, skillKey, 'BASE');
    await plugin.message_received(sessionId, 'This is wrong, should have used another approach');
    await plugin.message_received(sessionId, 'Still incorrect, fix this please');
    await plugin.message_received(sessionId, "don't do that, not that way");

    const events = await plugin.feedbackCollector.getSessionFeedback(sessionId);
    const correctionCount = events.filter((e) => e.eventType === 'user_correction').length;
    expect(correctionCount).toBeGreaterThanOrEqual(3);

    const overlays = await plugin.overlayStore.listBySession(sessionId);

    const review = await plugin.reviewRunner.runReview({
      sessionId,
      skillKey,
      events,
      overlays,
      durationMs: 1000,
      totalErrors: 0
    });

    expect(review.isModificationRecommended).toBe(true);
    expect(review.riskLevel).not.toBe('low');
  });
});
