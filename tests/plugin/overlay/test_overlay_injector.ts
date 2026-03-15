import { describe, expect, it } from 'vitest';
import { OverlayInjectorImpl } from '../../../src/plugin/overlay/overlay_injector.ts';
import type { OverlayEntry } from '../../../src/shared/types.ts';

describe('plugin/overlay/overlay_injector', () => {
  it('prepends overlay content with delimiters before base context', () => {
    const injector = new OverlayInjectorImpl();
    const overlay: OverlayEntry = {
      sessionId: 's1',
      skillKey: 'skill.a',
      content: 'Use shorter explanations.',
      createdAt: 1,
      updatedAt: 1,
      reasoning: 'optimize readability'
    };

    const result = injector.inject('ORIGINAL CONTEXT', overlay);
    expect(result).toContain('--- SKILL OVERLAY (session-local) ---');
    expect(result).toContain('Use shorter explanations.');
    expect(result).toContain('--- END OVERLAY ---');
    expect(result.indexOf('--- SKILL OVERLAY (session-local) ---')).toBeLessThan(result.indexOf('ORIGINAL CONTEXT'));
  });
});
