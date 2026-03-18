/**
 * Tests for overlay injection cap (maxInjectionChars) and LIFO ordering.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chdir, cwd } from 'node:process';
import { getDefaultConfig, validateConfig } from '../../src/plugin/config.ts';
import { SkillEvolutionPlugin } from '../../src/plugin/index.ts';
import type { OverlayEntry } from '../../src/shared/types.ts';

describe('Regression: overlay injection cap + LIFO', () => {
  let tempRoot = '';
  let previousCwd = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'overlay-cap-'));
    previousCwd = cwd();
    chdir(tempRoot);
  });

  afterEach(async () => {
    chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('preserves newest overlays when cap is hit (LIFO)', async () => {
    const config = getDefaultConfig();
    // Cap allows ~1 overlay content (~20 chars)
    config.sessionOverlay.maxInjectionChars = 30;

    const plugin = new SkillEvolutionPlugin(config, tempRoot);
    const sessionId = 'lifo-session';

    const overlayOld: OverlayEntry = {
      sessionId, skillKey: 'skill_old',
      content: 'OLD_OVERLAY_CONTENT',
      createdAt: 1000, updatedAt: 1000,
      reasoning: 'old',
    };
    const overlayNew: OverlayEntry = {
      sessionId, skillKey: 'skill_new',
      content: 'NEW_OVERLAY_CONTENT',
      createdAt: 5000, updatedAt: 5000,
      reasoning: 'new',
    };

    await plugin.overlayStore.create(overlayOld);
    await plugin.overlayStore.create(overlayNew);

    plugin.ensureSessionStarted(sessionId);
    const prompt = await plugin.before_prompt_build(sessionId, 'main_skill', 'BASE');

    // Newest overlay should be injected (LIFO: newest first)
    expect(prompt).toContain('NEW_OVERLAY_CONTENT');
    // Oldest overlay should be skipped (cap exceeded)
    expect(prompt).not.toContain('OLD_OVERLAY_CONTENT');
  });

  it('injects all overlays when within cap', async () => {
    const config = getDefaultConfig();
    config.sessionOverlay.maxInjectionChars = 10_000;

    const plugin = new SkillEvolutionPlugin(config, tempRoot);
    const sessionId = 'full-session';

    for (let i = 0; i < 3; i++) {
      await plugin.overlayStore.create({
        sessionId, skillKey: `skill_${i}`,
        content: `content_${i}`,
        createdAt: i * 1000, updatedAt: i * 1000,
        reasoning: `reason_${i}`,
      });
    }

    plugin.ensureSessionStarted(sessionId);
    const prompt = await plugin.before_prompt_build(sessionId, 'main_skill', 'BASE');

    expect(prompt).toContain('content_0');
    expect(prompt).toContain('content_1');
    expect(prompt).toContain('content_2');
  });

  it('caps injection at maxInjectionChars', async () => {
    const config = getDefaultConfig();
    config.sessionOverlay.maxInjectionChars = 50;

    const plugin = new SkillEvolutionPlugin(config, tempRoot);
    const sessionId = 'cap-session';

    for (let i = 0; i < 5; i++) {
      await plugin.overlayStore.create({
        sessionId, skillKey: `skill_${i}`,
        content: `overlay_content_${i}_${'x'.repeat(30)}`,
        createdAt: i * 1000, updatedAt: i * 1000,
        reasoning: `reason_${i}`,
      });
    }

    plugin.ensureSessionStarted(sessionId);
    const prompt = await plugin.before_prompt_build(sessionId, 'main_skill', 'BASE');

    const overlayCount = (prompt.match(/--- SKILL OVERLAY/g) || []).length;
    expect(overlayCount).toBeLessThan(5);
    expect(overlayCount).toBeGreaterThanOrEqual(1);
  });

  it('injects nothing when single overlay exceeds cap', async () => {
    const config = getDefaultConfig();
    config.sessionOverlay.maxInjectionChars = 5;

    const plugin = new SkillEvolutionPlugin(config, tempRoot);
    const sessionId = 'zero-cap-session';

    await plugin.overlayStore.create({
      sessionId, skillKey: 'skill_big',
      content: 'This is way too long for the tiny cap',
      createdAt: 1000, updatedAt: 1000,
      reasoning: 'big',
    });

    plugin.ensureSessionStarted(sessionId);
    const prompt = await plugin.before_prompt_build(sessionId, 'main_skill', 'BASE');

    expect(prompt).toBe('BASE');
  });

  it('uses default cap of 2000 when not configured', () => {
    const config = getDefaultConfig();
    expect(config.sessionOverlay.maxInjectionChars).toBe(2000);
  });

  it('validates maxInjectionChars must be positive integer', () => {
    const config = getDefaultConfig();
    config.sessionOverlay.maxInjectionChars = 0;
    expect(() => validateConfig(config)).toThrow(/maxInjectionChars/);

    config.sessionOverlay.maxInjectionChars = -1;
    expect(() => validateConfig(config)).toThrow(/maxInjectionChars/);
  });
});
