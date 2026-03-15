/**
 * Feedback signal classifier implementing event-type and severity logic contract.
 */

import type { FeedbackClassifier, FeedbackEvent } from '../../shared/types.js';

export class FeedbackClassifierImpl implements FeedbackClassifier {
  private readonly correctionPattern: RegExp;

  private readonly positivePattern: RegExp;

  public constructor() {
    this.correctionPattern =
      /\b(don't|wrong|incorrect|instead|not that|should have|fix this)\b|不对|错了|应该|改成|不是这个|上一句有问题|你这里理解错了/i;
    this.positivePattern =
      /\b(good|great|perfect|thanks|correct|nice)\b|这样可以|对的|很好|没问题|谢谢|这个版本可以/i;
  }

  public classify(rawInput: string, isError: boolean): FeedbackEvent['eventType'] | null {
    if (isError) {
      return 'tool_error';
    }

    if (this.correctionPattern.test(rawInput)) {
      return 'user_correction';
    }

    if (this.positivePattern.test(rawInput)) {
      return 'positive_feedback';
    }

    return null;
  }

  public assessSeverity(events: FeedbackEvent[]): FeedbackEvent['severity'] {
    const errorCount = events.filter((event) => event.eventType === 'tool_error').length;
    const correctionCount = events.filter((event) => event.eventType === 'user_correction').length;
    const signalCount = errorCount + correctionCount;

    if (signalCount === 0) {
      return 'low';
    }
    if (correctionCount >= 2 || errorCount >= 3) {
      return 'high';
    }
    return 'medium';
  }
}

export default FeedbackClassifierImpl;
