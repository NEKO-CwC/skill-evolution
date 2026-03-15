/**
 * Hook invoked when inbound messages are received for classification.
 */

import type { FeedbackEvent, OverlayEntry } from '../../shared/types.js';
import type { SkillEvolutionPlugin } from '../index.js';

/**
 * Handles message-received classification flow.
 */
export async function message_received(plugin: SkillEvolutionPlugin, sessionId: string, message: string): Promise<void> {
  plugin.ensureSessionStarted(sessionId);
  const skillKey = plugin.getSessionSkillKey(sessionId);
  const eventType = plugin.feedbackClassifier.classify(message, false);

  if (eventType === null) {
    return;
  }

  const shouldCollectUserCorrection = eventType === 'user_correction' && plugin.config.triggers.onUserCorrection;
  const shouldCollectPositiveFeedback = eventType === 'positive_feedback' && plugin.config.triggers.onPositiveFeedback;
  if (!shouldCollectUserCorrection && !shouldCollectPositiveFeedback) {
    return;
  }

  const existingEvents = await plugin.feedbackCollector.getSessionFeedback(sessionId);
  const candidateEvent: FeedbackEvent = {
    sessionId,
    skillKey,
    timestamp: Date.now(),
    eventType,
    severity: 'low',
    messageExcerpt: message.slice(0, 280)
  };

  const severity = plugin.feedbackClassifier.assessSeverity([...existingEvents, candidateEvent]);
  const event: FeedbackEvent = {
    ...candidateEvent,
    severity
  };

  await plugin.feedbackCollector.collect(event);

  if (!plugin.config.sessionOverlay.enabled) {
    return;
  }

  if (eventType === 'user_correction') {
    const existing = await plugin.overlayStore.read(sessionId, skillKey);
    if (existing) {
      await plugin.overlayStore.update(sessionId, skillKey, {
        content: existing.content + `\nAdditional correction: ${message.slice(0, 400)}`,
        updatedAt: Date.now()
      });
    } else {
      const overlayEntry: OverlayEntry = {
        sessionId,
        skillKey,
        content: `User correction received. Apply corrected behavior in this session.\nCorrection excerpt: ${message.slice(0, 400)}`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        reasoning: `Generated from onUserCorrection trigger with ${severity} severity.`
      };
      await plugin.overlayStore.create(overlayEntry);
    }
  }
}

export default message_received;
