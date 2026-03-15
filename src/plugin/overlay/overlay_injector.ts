/**
 * Prompt overlay injector implementing context concatenation contract.
 */

import type { OverlayEntry, OverlayInjector } from '../../shared/types.js';

/**
 * Default overlay injector placeholder implementation.
 */
export class OverlayInjectorImpl implements OverlayInjector {
  /**
   * Injects overlay content into the base context.
   */
  public inject(baseContext: string, overlay: OverlayEntry): string {
    return `\n--- SKILL OVERLAY (session-local) ---\n${overlay.content}\n--- END OVERLAY ---\n\n${baseContext}`;
  }
}

export default OverlayInjectorImpl;
