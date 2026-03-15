import { describe, expect, it } from 'vitest';
import { FeedbackClassifierImpl } from '../../../src/plugin/feedback/classifiers.ts';
import type { FeedbackEvent } from '../../../src/shared/types.ts';

describe('plugin/feedback/classifiers', () => {
  it('classifies as tool_error when isError flag is true regardless of text', () => {
    const classifier = new FeedbackClassifierImpl();
    expect(classifier.classify('great job', true)).toBe('tool_error');
  });

  it('classifies user correction phrases as user_correction', () => {
    const classifier = new FeedbackClassifierImpl();
    expect(classifier.classify('This is wrong, fix this please', false)).toBe('user_correction');
    expect(classifier.classify("you should have used another approach", false)).toBe('user_correction');
  });

  it('classifies Chinese correction phrases as user_correction', () => {
    const classifier = new FeedbackClassifierImpl();
    expect(classifier.classify('不对，你这里理解错了', false)).toBe('user_correction');
    expect(classifier.classify('应该改成这样', false)).toBe('user_correction');
    expect(classifier.classify('错了，不是这个', false)).toBe('user_correction');
  });

  it('classifies positive feedback phrases as positive_feedback', () => {
    const classifier = new FeedbackClassifierImpl();
    expect(classifier.classify('great work, thanks', false)).toBe('positive_feedback');
  });

  it('classifies Chinese positive phrases as positive_feedback', () => {
    const classifier = new FeedbackClassifierImpl();
    expect(classifier.classify('很好，这样可以', false)).toBe('positive_feedback');
    expect(classifier.classify('对的，没问题', false)).toBe('positive_feedback');
    expect(classifier.classify('谢谢', false)).toBe('positive_feedback');
  });

  it('returns null when input has no matching correction or positive signal', () => {
    const classifier = new FeedbackClassifierImpl();
    expect(classifier.classify('continue to next step', false)).toBeNull();
  });

  it('assesses low severity when there are no tool_error or user_correction events', () => {
    const classifier = new FeedbackClassifierImpl();
    const events: FeedbackEvent[] = [
      {
        sessionId: 's1',
        skillKey: 'a',
        timestamp: 1,
        eventType: 'positive_feedback',
        severity: 'low'
      }
    ];
    expect(classifier.assessSeverity(events)).toBe('low');
    expect(classifier.assessSeverity([])).toBe('low');
  });

  it('assesses medium severity for 1 user_correction (no tool_errors)', () => {
    const classifier = new FeedbackClassifierImpl();
    const events: FeedbackEvent[] = [
      {
        sessionId: 's1',
        skillKey: 'a',
        timestamp: 1,
        eventType: 'user_correction',
        severity: 'medium'
      }
    ];
    expect(classifier.assessSeverity(events)).toBe('medium');
  });

  it('assesses medium severity when tool_error count is 1 or 2', () => {
    const classifier = new FeedbackClassifierImpl();
    const oneError: FeedbackEvent[] = [
      {
        sessionId: 's1',
        skillKey: 'a',
        timestamp: 1,
        eventType: 'tool_error',
        severity: 'high'
      }
    ];
    const twoErrors: FeedbackEvent[] = [
      ...oneError,
      {
        sessionId: 's1',
        skillKey: 'a',
        timestamp: 2,
        eventType: 'tool_error',
        severity: 'high'
      }
    ];

    expect(classifier.assessSeverity(oneError)).toBe('medium');
    expect(classifier.assessSeverity(twoErrors)).toBe('medium');
  });

  it('assesses high severity when tool_error count is 3 or more', () => {
    const classifier = new FeedbackClassifierImpl();
    const events: FeedbackEvent[] = [1, 2, 3].map((idx) => ({
      sessionId: 's1',
      skillKey: 'a',
      timestamp: idx,
      eventType: 'tool_error',
      severity: 'high'
    }));
    expect(classifier.assessSeverity(events)).toBe('high');
  });

  it('assesses high severity when user_correction count is 2 or more', () => {
    const classifier = new FeedbackClassifierImpl();
    const events: FeedbackEvent[] = [1, 2].map((idx) => ({
      sessionId: 's1',
      skillKey: 'a',
      timestamp: idx,
      eventType: 'user_correction',
      severity: 'medium'
    }));
    expect(classifier.assessSeverity(events)).toBe('high');
  });
});
