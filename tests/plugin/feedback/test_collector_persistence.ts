import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FeedbackCollectorImpl } from '../../../src/plugin/feedback/collector.ts';
import type { FeedbackEvent } from '../../../src/shared/types.ts';

describe('plugin/feedback/collector persistence', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skill-generation-feedback-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('persists events to JSONL file on disk', async () => {
    const collector = new FeedbackCollectorImpl(tempDir);
    const event: FeedbackEvent = {
      sessionId: 'session-a',
      skillKey: 'skill.a',
      timestamp: 100,
      eventType: 'tool_error',
      severity: 'high',
      messageExcerpt: 'tool failed'
    };

    await collector.collect(event);

    const filePath = join(tempDir, 'session-a.jsonl');
    const content = await readFile(filePath, { encoding: 'utf8' });
    const lines = content.split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!) as FeedbackEvent).toEqual(event);
  });

  it('survives "restart" — new collector reads existing JSONL', async () => {
    const collectorA = new FeedbackCollectorImpl(tempDir);
    const eventA: FeedbackEvent = {
      sessionId: 'session-a',
      skillKey: 'skill.a',
      timestamp: 101,
      eventType: 'user_correction',
      severity: 'medium',
      messageExcerpt: 'fix this'
    };
    const eventB: FeedbackEvent = {
      sessionId: 'session-a',
      skillKey: 'skill.a',
      timestamp: 102,
      eventType: 'positive_feedback',
      severity: 'low',
      messageExcerpt: 'great now'
    };

    await collectorA.collect(eventA);
    await collectorA.collect(eventB);

    const collectorB = new FeedbackCollectorImpl(tempDir);
    await expect(collectorB.getSessionFeedback('session-a')).resolves.toEqual([eventA, eventB]);
  });

  it('merges disk and in-memory events correctly', async () => {
    const collectorA = new FeedbackCollectorImpl(tempDir);
    const event1: FeedbackEvent = {
      sessionId: 'session-a',
      skillKey: 'skill.a',
      timestamp: 103,
      eventType: 'tool_error',
      severity: 'high'
    };
    await collectorA.collect(event1);

    const collectorB = new FeedbackCollectorImpl(tempDir);
    const event2: FeedbackEvent = {
      sessionId: 'session-a',
      skillKey: 'skill.a',
      timestamp: 104,
      eventType: 'retry_pattern',
      severity: 'medium'
    };

    await collectorB.collect(event2);

    await expect(collectorB.getSessionFeedback('session-a')).resolves.toEqual([event1, event2]);
  });

  it('returns empty array for non-existent session file', async () => {
    const collector = new FeedbackCollectorImpl(tempDir);
    await expect(collector.getSessionFeedback('nonexistent')).resolves.toEqual([]);
  });

  it('handles concurrent sessions without cross-contamination', async () => {
    const collector = new FeedbackCollectorImpl(tempDir);
    const sessionAEvent: FeedbackEvent = {
      sessionId: 'session-a',
      skillKey: 'skill.a',
      timestamp: 105,
      eventType: 'tool_error',
      severity: 'high'
    };
    const sessionBEvent: FeedbackEvent = {
      sessionId: 'session-b',
      skillKey: 'skill.b',
      timestamp: 106,
      eventType: 'positive_feedback',
      severity: 'low'
    };

    await collector.collect(sessionAEvent);
    await collector.collect(sessionBEvent);

    await expect(collector.getSessionFeedback('session-a')).resolves.toEqual([sessionAEvent]);
    await expect(collector.getSessionFeedback('session-b')).resolves.toEqual([sessionBEvent]);

    await expect(access(join(tempDir, 'session-a.jsonl'))).resolves.toBeUndefined();
    await expect(access(join(tempDir, 'session-b.jsonl'))).resolves.toBeUndefined();
  });
});
