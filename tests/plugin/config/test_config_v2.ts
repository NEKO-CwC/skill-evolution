import { describe, expect, it } from 'vitest';
import { getDefaultConfig, fromOpenClawPluginConfig, validateConfig, deepMerge, migrateAgentsCompat } from '../../../src/plugin/config.ts';
import { InvalidConfigError } from '../../../src/shared/errors.ts';
import type { SkillEvolutionConfig } from '../../../src/shared/types.ts';

describe('plugin/config v2 fields', () => {
  describe('getDefaultConfig', () => {
    it('includes reviewMode with queue-only default', () => {
      const config = getDefaultConfig();
      expect(config.reviewMode).toBe('queue-only');
    });

    it('includes notify defaults', () => {
      const config = getDefaultConfig();
      expect(config.notify).toEqual({
        enabled: false,
        mode: 'off',
        channel: 'same-thread',
      });
    });

    it('includes agents defaults', () => {
      const config = getDefaultConfig();
      expect(config.agents!.review.enabled).toBe(true);
      expect(config.agents!.review.agentId).toBe('skill-evolution-review');
      expect(config.agents!.review.runTimeoutSeconds).toBe(180);
      expect(config.agents!.notify.enabled).toBe(false);
      expect(config.agents!.notify.agentId).toBe('skill-evolution-notify');
    });

    it('includes queue defaults', () => {
      const config = getDefaultConfig();
      expect(config.queue!.storageDir).toBe('.skill-patches');
      expect(config.queue!.dedupeWindowMinutes).toBe(60);
      expect(config.queue!.maxPendingPerSkill).toBe(20);
    });

    it('includes notifications defaults', () => {
      const config = getDefaultConfig();
      expect(config.notifications!.debounceSeconds).toBe(300);
      expect(config.notifications!.digestCron).toBe('');
      expect(config.notifications!.minRiskToInterrupt).toBe('medium');
    });

    it('includes risk defaults', () => {
      const config = getDefaultConfig();
      expect(config.risk!.autoApplyMaxRisk).toBe('low');
      expect(config.risk!.notifyMinRisk).toBe('low');
    });
  });

  describe('validateConfig', () => {
    it('accepts valid reviewMode values', () => {
      for (const mode of ['off', 'queue-only', 'assisted', 'auto-low-risk'] as const) {
        const config = getDefaultConfig();
        config.reviewMode = mode;
        expect(() => validateConfig(config)).not.toThrow();
      }
    });

    it('rejects invalid reviewMode', () => {
      const config = getDefaultConfig();
      (config as Record<string, unknown>).reviewMode = 'invalid';
      expect(() => validateConfig(config)).toThrow(InvalidConfigError);
    });

    it('accepts valid notify.mode values', () => {
      for (const mode of ['off', 'per-session', 'digest'] as const) {
        const config = getDefaultConfig();
        config.notify!.mode = mode;
        expect(() => validateConfig(config)).not.toThrow();
      }
    });

    it('rejects invalid notify.mode', () => {
      const config = getDefaultConfig();
      (config.notify as Record<string, unknown>).mode = 'invalid';
      expect(() => validateConfig(config)).toThrow(InvalidConfigError);
    });

    it('rejects invalid risk.autoApplyMaxRisk', () => {
      const config = getDefaultConfig();
      (config.risk as Record<string, unknown>).autoApplyMaxRisk = 'critical';
      expect(() => validateConfig(config)).toThrow(InvalidConfigError);
    });

    it('rejects invalid agents.review.spawnMode', () => {
      const config = getDefaultConfig();
      (config.agents!.review as Record<string, unknown>).spawnMode = 'fork';
      expect(() => validateConfig(config)).toThrow(InvalidConfigError);
    });

    it('rejects zero runTimeoutSeconds', () => {
      const config = getDefaultConfig();
      config.agents!.review.runTimeoutSeconds = 0;
      expect(() => validateConfig(config)).toThrow(InvalidConfigError);
    });

    it('rejects negative dedupeWindowMinutes', () => {
      const config = getDefaultConfig();
      config.queue!.dedupeWindowMinutes = -1;
      expect(() => validateConfig(config)).toThrow(InvalidConfigError);
    });

    it('rejects zero maxPendingPerSkill', () => {
      const config = getDefaultConfig();
      config.queue!.maxPendingPerSkill = 0;
      expect(() => validateConfig(config)).toThrow(InvalidConfigError);
    });
  });

  describe('backward compatibility derivation', () => {
    it('derives reviewMode=off when onSessionEndReview=false', () => {
      const config = fromOpenClawPluginConfig({
        triggers: { onSessionEndReview: false },
      });
      expect(config.reviewMode).toBe('off');
    });

    it('derives reviewMode=queue-only when onSessionEndReview=true and requireHumanMerge=true', () => {
      const config = fromOpenClawPluginConfig({
        triggers: { onSessionEndReview: true },
        merge: { requireHumanMerge: true },
      });
      expect(config.reviewMode).toBe('queue-only');
    });

    it('preserves explicit reviewMode over derivation', () => {
      const config = fromOpenClawPluginConfig({
        reviewMode: 'assisted',
        triggers: { onSessionEndReview: false },
      });
      expect(config.reviewMode).toBe('assisted');
    });
  });

  describe('deepMerge v2 fields', () => {
    it('merges notify partial', () => {
      const defaults = getDefaultConfig();
      const source = { notify: { enabled: true } } as SkillEvolutionConfig;
      const merged = deepMerge(defaults, source);
      expect(merged.notify!.enabled).toBe(true);
      expect(merged.notify!.mode).toBe('off');
      expect(merged.notify!.channel).toBe('same-thread');
    });

    it('merges agents.review partial', () => {
      const defaults = getDefaultConfig();
      const source = {
        agents: {
          review: { runTimeoutSeconds: 60 },
          notify: {},
        },
      } as SkillEvolutionConfig;
      const merged = deepMerge(defaults, source);
      expect(merged.agents!.review.runTimeoutSeconds).toBe(60);
      expect(merged.agents!.review.agentId).toBe('skill-evolution-review');
    });

    it('merges risk partial', () => {
      const defaults = getDefaultConfig();
      const source = { risk: { autoApplyMaxRisk: 'medium' } } as SkillEvolutionConfig;
      const merged = deepMerge(defaults, source);
      expect(merged.risk!.autoApplyMaxRisk).toBe('medium');
      expect(merged.risk!.notifyMinRisk).toBe('low');
    });

    it('preserves existing v1 fields through merge', () => {
      const defaults = getDefaultConfig();
      const source = {
        merge: { requireHumanMerge: false },
        reviewMode: 'assisted',
      } as SkillEvolutionConfig;
      const merged = deepMerge(defaults, source);
      expect(merged.merge.requireHumanMerge).toBe(false);
      expect(merged.merge.maxRollbackVersions).toBe(5);
      expect(merged.reviewMode).toBe('assisted');
    });

    it('does not add v2 fields when source omits them', () => {
      const defaults = getDefaultConfig();
      const source = { enabled: true } as SkillEvolutionConfig;
      const merged = deepMerge(defaults, source);
      // v2 fields come from defaults
      expect(merged.reviewMode).toBe('queue-only');
      expect(merged.notify!.enabled).toBe(false);
    });
  });

  describe('config field interactions', () => {
    it('reviewMode=off: triggers.onSessionEndReview irrelevant', () => {
      const config = fromOpenClawPluginConfig({
        reviewMode: 'off',
        triggers: { onSessionEndReview: true },
      });
      expect(config.reviewMode).toBe('off');
    });

    it('notify.enabled=false overrides notify.mode', () => {
      const config = fromOpenClawPluginConfig({
        notify: { enabled: false, mode: 'per-session' },
      });
      expect(config.notify!.enabled).toBe(false);
      expect(config.notify!.mode).toBe('per-session');
    });

    it('agents config is optional and gets defaults', () => {
      const config = fromOpenClawPluginConfig({});
      expect(config.agents!.review.enabled).toBe(true);
      expect(config.agents!.notify.enabled).toBe(false);
    });
  });

  describe('agent + sessions (new config)', () => {
    it('getDefaultConfig includes agent defaults', () => {
      const config = getDefaultConfig();
      expect(config.agent).toEqual({
        enabled: true,
        id: 'skill-evolution',
        model: null,
      });
    });

    it('getDefaultConfig includes sessions defaults', () => {
      const config = getDefaultConfig();
      expect(config.sessions!.review).toEqual({
        enabled: true,
        reuse: true,
        thread: true,
        timeoutSeconds: 180,
      });
      expect(config.sessions!.notify).toEqual({
        enabled: true,
        reuse: true,
        thread: true,
        timeoutSeconds: 60,
      });
    });

    it('validates agent.id must be non-empty', () => {
      const config = getDefaultConfig();
      config.agent!.id = '';
      expect(() => validateConfig(config)).toThrow(InvalidConfigError);
    });

    it('validates sessions.review.timeoutSeconds must be >= 1', () => {
      const config = getDefaultConfig();
      config.sessions!.review.timeoutSeconds = 0;
      expect(() => validateConfig(config)).toThrow(InvalidConfigError);
    });

    it('validates sessions.notify.reuse must be boolean', () => {
      const config = getDefaultConfig();
      (config.sessions!.notify as Record<string, unknown>).reuse = 'yes';
      expect(() => validateConfig(config)).toThrow(InvalidConfigError);
    });

    it('deepMerge handles agent partial', () => {
      const defaults = getDefaultConfig();
      const source = { agent: { model: 'custom-model' } } as SkillEvolutionConfig;
      const merged = deepMerge(defaults, source);
      expect(merged.agent!.model).toBe('custom-model');
      expect(merged.agent!.id).toBe('skill-evolution');
      expect(merged.agent!.enabled).toBe(true);
    });

    it('deepMerge handles sessions partial', () => {
      const defaults = getDefaultConfig();
      const source = {
        sessions: {
          review: { timeoutSeconds: 60 },
          notify: {},
        },
      } as SkillEvolutionConfig;
      const merged = deepMerge(defaults, source);
      expect(merged.sessions!.review.timeoutSeconds).toBe(60);
      expect(merged.sessions!.review.reuse).toBe(true);
      expect(merged.sessions!.notify.timeoutSeconds).toBe(60);
    });
  });

  describe('migrateAgentsCompat', () => {
    it('migrates legacy agents config to agent + sessions', () => {
      const config = getDefaultConfig();
      // Clear new fields to simulate legacy-only config
      delete (config as Record<string, unknown>).agent;
      delete (config as Record<string, unknown>).sessions;
      migrateAgentsCompat(config);
      expect(config.agent).toBeDefined();
      expect(config.agent!.id).toBe('skill-evolution');
      expect(config.agent!.enabled).toBe(true);
      expect(config.sessions).toBeDefined();
      expect(config.sessions!.review.enabled).toBe(true);
      expect(config.sessions!.review.reuse).toBe(true); // spawnMode=session → reuse=true
      expect(config.sessions!.review.timeoutSeconds).toBe(180);
      expect(config.sessions!.notify.enabled).toBe(false); // notify agent was disabled
    });

    it('does not overwrite explicit sessions config', () => {
      const config = getDefaultConfig();
      config.sessions = {
        review: { enabled: false, reuse: false, thread: false, timeoutSeconds: 30 },
        notify: { enabled: false, reuse: false, thread: false, timeoutSeconds: 10 },
      };
      migrateAgentsCompat(config);
      expect(config.sessions.review.timeoutSeconds).toBe(30);
    });

    it('no-ops when agents is undefined', () => {
      const config = getDefaultConfig();
      delete (config as Record<string, unknown>).agents;
      const before = JSON.stringify(config);
      migrateAgentsCompat(config);
      // agent and sessions already have defaults, so they shouldn't change
      expect(JSON.stringify(config)).toBe(before);
    });

    it('fromOpenClawPluginConfig auto-migrates legacy agents', () => {
      const config = fromOpenClawPluginConfig({
        agents: {
          review: { enabled: true, runTimeoutSeconds: 120 },
          notify: { enabled: true },
        },
      });
      expect(config.agent).toBeDefined();
      expect(config.agent!.id).toBe('skill-evolution');
      expect(config.sessions).toBeDefined();
    });
  });
});
