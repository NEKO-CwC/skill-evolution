import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDefaultConfig } from '../../src/plugin/config.ts';
import { SkillEvolutionPlugin } from '../../src/plugin/index.ts';

describe('Regression: Chinese correction without tool errors', () => {
  let tempRoot = '';
  let plugin: SkillEvolutionPlugin;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'skill-regression-zh-'));
    const config = getDefaultConfig();
    config.review.minEvidenceCount = 1;
    config.merge.requireHumanMerge = false;
    config.llm.inheritPrimaryConfig = false;
    plugin = new SkillEvolutionPlugin(config, tempRoot);
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('Chinese correction produces feedback, overlay, and review recommends modification', async () => {
    const sessionId = 'zh-correction-session';
    const skillKey = 'skill.zh-test';

    await plugin.before_prompt_build(sessionId, skillKey, 'BASE');
    await plugin.message_received(sessionId, '不对，你这里理解错了，应该改成另一种方式');

    const events = await plugin.feedbackCollector.getSessionFeedback(sessionId);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.eventType === 'user_correction')).toBe(true);

    const overlays = await plugin.overlayStore.listBySession(sessionId);
    expect(overlays.length).toBeGreaterThanOrEqual(1);
    expect(overlays[0]?.content).toContain('User correction received');

    const review = await plugin.reviewRunner.runReview({
      sessionId,
      skillKey,
      events,
      overlays,
      durationMs: 1000,
      totalErrors: 0
    });
    expect(review.isModificationRecommended).toBe(true);
    // LLM fallback justification contains both errors and corrections count
    expect(review.justification).toMatch(/corrections?:\s*1/);
  });

  it('Chinese positive feedback is classified correctly', async () => {
    const sessionId = 'zh-positive-session';
    const skillKey = 'skill.zh-positive';

    await plugin.before_prompt_build(sessionId, skillKey, 'BASE');
    await plugin.message_received(sessionId, '很好，这个版本可以');

    const events = await plugin.feedbackCollector.getSessionFeedback(sessionId);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.eventType === 'positive_feedback')).toBe(true);
  });
});
