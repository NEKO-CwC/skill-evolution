import { describe, expect, it } from 'vitest';
import { InvalidConfigError } from '../../src/shared/errors.ts';
import { fromOpenClawPluginConfig, getDefaultConfig } from '../../src/plugin/config.ts';

describe('plugin/config adapter (fromOpenClawPluginConfig)', () => {
  it('accepts flat config without wrapper', () => {
    const config = fromOpenClawPluginConfig({
      enabled: true,
      merge: {
        requireHumanMerge: false,
        maxRollbackVersions: 3
      }
    });

    const defaults = getDefaultConfig();
    expect(config.enabled).toBe(true);
    expect(config.merge.requireHumanMerge).toBe(false);
    expect(config.merge.maxRollbackVersions).toBe(3);
    expect(config.sessionOverlay).toEqual(defaults.sessionOverlay);
    expect(config.triggers).toEqual(defaults.triggers);
    expect(config.llm).toEqual(defaults.llm);
    expect(config.review).toEqual(defaults.review);
  });

  it('accepts wrapped config with skillEvolution key', () => {
    const config = fromOpenClawPluginConfig({
      skillEvolution: {
        enabled: false
      }
    });

    expect(config.enabled).toBe(false);
  });

  it('returns all defaults for empty object', () => {
    const config = fromOpenClawPluginConfig({});
    expect(config).toEqual(getDefaultConfig());
  });

  it('merges partial config with defaults', () => {
    const config = fromOpenClawPluginConfig({
      triggers: {
        onToolError: false
      }
    });

    expect(config.triggers.onToolError).toBe(false);
    expect(config.triggers.onUserCorrection).toBe(true);
    expect(config.triggers.onSessionEndReview).toBe(true);
    expect(config.triggers.onPositiveFeedback).toBe(true);
  });

  it('throws InvalidConfigError for invalid values', () => {
    expect(() => fromOpenClawPluginConfig({
      merge: {
        maxRollbackVersions: -1
      }
    })).toThrow(InvalidConfigError);
  });
});
