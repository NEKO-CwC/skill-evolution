/**
 * Hook invoked after tool execution for feedback capture.
 */

import type { FeedbackEvent, OverlayEntry } from '../../shared/types.js';
import type { SkillEvolutionPlugin } from '../index.js';

function isToolError(isError: boolean, output: string, rawResult?: unknown): boolean {
  if (isError) {
    return true;
  }

  if (rawResult && typeof rawResult === 'object') {
    const record = rawResult as Record<string, unknown>;
    if (record.status === 'error') {
      return true;
    }

    if ('error' in record && record.error !== undefined && record.error !== null && record.error !== '') {
      return true;
    }
  }

  if (output && /\b(error|failed|unauthorized|timeout|missing api key)\b/i.test(output)) {
    return true;
  }

  return false;
}

/**
 * Serializes output or error for human-readable logging.
 * Handles objects by JSON.stringify, primitives by String().
 */
function serializeForExcerpt(value: unknown, maxLength: number): string {
  if (value === null || value === undefined) {
    return '';
  }

  let text: string;
  if (typeof value === 'object') {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  } else {
    text = String(value);
  }

  return text.length <= maxLength ? text : text.slice(0, maxLength) + '...';
}

export async function after_tool_call(
  plugin: SkillEvolutionPlugin,
  sessionId: string,
  toolName: string,
  output: string,
  isError: boolean,
  rawResult?: unknown
): Promise<void> {
  plugin.ensureSessionStarted(sessionId);
  const skillKey = plugin.getSessionSkillKey(sessionId);
  const detectedError = isToolError(isError, output, rawResult);
  const eventType = plugin.feedbackClassifier.classify(output, detectedError);

  if (eventType === null) {
    return;
  }

  const priorEvents = await plugin.feedbackCollector.getSessionFeedback(sessionId);
  const severity = plugin.feedbackClassifier.assessSeverity(priorEvents);

  const event: FeedbackEvent = {
    sessionId,
    skillKey,
    timestamp: Date.now(),
    eventType,
    severity,
    toolName,
    messageExcerpt: serializeForExcerpt(output, 280)
  };
  await plugin.feedbackCollector.collect(event);

  if (!detectedError || !plugin.config.triggers.onToolError || !plugin.config.sessionOverlay.enabled) {
    return;
  }

  const errorExcerpt = serializeForExcerpt(rawResult ?? output, 400);
  const overlayEntry: OverlayEntry = {
    sessionId,
    skillKey,
    content: `Tool error observed for ${toolName}. Avoid prior failure mode.\nError excerpt: ${errorExcerpt}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    reasoning: 'Generated from onToolError trigger after failed tool call.'
  };

  await plugin.overlayStore.create(overlayEntry);
}

export default after_tool_call;
