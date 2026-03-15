import type { SkillEvolutionPlugin } from '../index.js';

export async function agent_end(plugin: SkillEvolutionPlugin, sessionId: string): Promise<void> {
  plugin.ensureSessionStarted(sessionId);
  const skillKey = plugin.getSessionSkillKey(sessionId);
  const events = await plugin.feedbackCollector.getSessionFeedback(sessionId);

  const runErrors = events.filter((event) => event.eventType === 'tool_error').length;

  plugin.logger.info('Agent run completed', {
    sessionId,
    skillKey,
    eventCount: events.length,
    runErrors
  });
}

export default agent_end;
