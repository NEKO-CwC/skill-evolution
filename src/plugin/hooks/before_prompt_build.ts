/**
 * Hook invoked before prompt construction to inject session overlays.
 */

import type { SkillEvolutionPlugin } from '../index.js';

/**
 * Handles pre-prompt mutation hook.
 */
export async function before_prompt_build(
  plugin: SkillEvolutionPlugin,
  sessionId: string,
  skillKey: string,
  currentPrompt: string
): Promise<string> {
  plugin.ensureSessionStarted(sessionId);
  plugin.setSessionSkillKey(sessionId, skillKey);

  if (!plugin.config.sessionOverlay.enabled) {
    return currentPrompt;
  }

  const overlays = await plugin.overlayStore.listBySession(sessionId);
  let nextPrompt = currentPrompt;

  for (const overlay of overlays) {
    nextPrompt = plugin.overlayInjector.inject(nextPrompt, overlay);
  }

  return nextPrompt;
}

export default before_prompt_build;
