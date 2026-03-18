/**
 * Hook invoked before prompt construction to inject session overlays.
 */

import type { SkillEvolutionPlugin } from '../index.js';

/** Default max injection chars when not configured. */
const DEFAULT_MAX_INJECTION_CHARS = 2000;

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
  if (overlays.length === 0) {
    return currentPrompt;
  }

  // LIFO: sort newest-first so we keep the most recent corrections when hitting the cap
  const sorted = [...overlays].sort((a, b) => b.createdAt - a.createdAt);

  const maxChars = plugin.config.sessionOverlay.maxInjectionChars ?? DEFAULT_MAX_INJECTION_CHARS;
  let injectedChars = 0;
  let nextPrompt = currentPrompt;

  for (const overlay of sorted) {
    const overlayLen = overlay.content.length;
    if (injectedChars + overlayLen > maxChars) {
      plugin.logger.warn('Overlay injection cap reached, skipping remaining overlays', {
        sessionId,
        injectedChars,
        maxChars,
        skippedCount: sorted.length - sorted.indexOf(overlay),
      });
      break;
    }
    nextPrompt = plugin.overlayInjector.inject(nextPrompt, overlay);
    injectedChars += overlayLen;
  }

  return nextPrompt;
}

export default before_prompt_build;
