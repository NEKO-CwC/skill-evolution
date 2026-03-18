/**
 * Configuration loading, defaults, and schema validation for the plugin.
 */

import { parse as parseYaml } from 'yaml';
import { InvalidConfigError } from '../shared/errors.js';
import { fileExists, readFile } from '../shared/fs.js';
import type { SkillEvolutionConfig, SkillEvolutionConfigFile, UnknownRecord } from '../shared/types.js';

/**
 * Returns the default plugin configuration.
 */
export function getDefaultConfig(): SkillEvolutionConfig {
  return {
    enabled: true,
    merge: {
      requireHumanMerge: true,
      maxRollbackVersions: 5
    },
    sessionOverlay: {
      enabled: true,
      storageDir: '.skill-overlays',
      injectMode: 'system-context',
      clearOnSessionEnd: true,
      maxInjectionChars: 2000,
    },
    triggers: {
      onToolError: true,
      onUserCorrection: true,
      onSessionEndReview: true,
      onPositiveFeedback: true
    },
    llm: {
      inheritPrimaryConfig: true,
      modelOverride: null,
      thinkingOverride: null,
      provider: null
    },
    review: {
      minEvidenceCount: 2,
      allowAutoMergeOnLowRiskOnly: false
    },
    // v2 basic fields
    reviewMode: 'queue-only',
    notify: {
      enabled: false,
      mode: 'off',
      channel: 'same-thread',
    },
    // v2 advanced fields
    agents: {
      review: {
        enabled: true,
        agentId: 'skill-evolution-review',
        spawnMode: 'session',
        thread: true,
        model: null,
        thinking: null,
        runTimeoutSeconds: 180,
      },
      notify: {
        enabled: false,
        agentId: 'skill-evolution-notify',
        spawnMode: 'run',
        thread: false,
        model: null,
        thinking: null,
      },
    },
    agent: {
      enabled: true,
      id: 'skill-evolution',
      model: null,
    },
    sessions: {
      review: {
        enabled: true,
        reuse: true,
        thread: true,
        timeoutSeconds: 180,
      },
      notify: {
        enabled: true,
        reuse: true,
        thread: true,
        timeoutSeconds: 60,
      },
    },
    queue: {
      storageDir: '.skill-patches',
      metadataFile: '.skill-patches/index.json',
      dedupeWindowMinutes: 60,
      maxPendingPerSkill: 20,
    },
    notifications: {
      debounceSeconds: 300,
      digestCron: '',
      minRiskToInterrupt: 'medium',
    },
    risk: {
      autoApplyMaxRisk: 'low',
      notifyMinRisk: 'low',
    },
  };
}

/**
 * Loads YAML config from disk, applies defaults, and validates required fields.
 */
export async function loadConfig(configPath: string): Promise<SkillEvolutionConfig> {
  if (!(await fileExists(configPath))) {
    throw new InvalidConfigError(`Config file does not exist: ${configPath}`);
  }

  const rawContent = await readFile(configPath);
  const parsed = parseYaml(rawContent) as unknown;

  if (!isRecord(parsed) || !('skillEvolution' in parsed)) {
    throw new InvalidConfigError('Config must contain top-level "skillEvolution" object.');
  }

  const configFile = parsed as unknown as SkillEvolutionConfigFile;
  const hasExplicitReviewMode = 'reviewMode' in configFile.skillEvolution &&
    configFile.skillEvolution.reviewMode !== undefined;

  const defaultConfig = getDefaultConfig();
  const merged = deepMerge(defaultConfig, configFile.skillEvolution);

  if (!hasExplicitReviewMode) {
    deriveReviewModeCompat(merged);
  }

  migrateAgentsCompat(merged);
  validateConfig(merged);
  return merged;
}

/**
 * Adapts raw config from OpenClaw's plugins.entries.<id>.config to SkillEvolutionConfig.
 * Applies defaults and validates.
 */
export function fromOpenClawPluginConfig(raw: Record<string, unknown>): SkillEvolutionConfig {
  const defaults = getDefaultConfig();
  const source = (raw && typeof raw === 'object' && 'skillEvolution' in raw)
    ? (raw as unknown as SkillEvolutionConfigFile).skillEvolution
    : raw as unknown as Partial<SkillEvolutionConfig>;

  // Track whether reviewMode was explicitly provided by user
  const hasExplicitReviewMode = 'reviewMode' in source && source.reviewMode !== undefined;

  const merged = deepMerge(defaults, source as SkillEvolutionConfig);

  if (!hasExplicitReviewMode) {
    deriveReviewModeCompat(merged);
  }

  migrateAgentsCompat(merged);
  validateConfig(merged);
  return merged;
}

const VALID_REVIEW_MODES = ['off', 'queue-only', 'assisted', 'auto-low-risk'] as const;
const VALID_NOTIFY_MODES = ['off', 'per-session', 'digest'] as const;
const VALID_RISK_LEVELS = ['low', 'medium', 'high'] as const;
const VALID_SPAWN_MODES = ['run', 'session'] as const;

/**
 * Validates the full plugin configuration schema.
 */
export function validateConfig(config: SkillEvolutionConfig): void {
  // === existing v1 validation ===
  if (typeof config.enabled !== 'boolean') {
    throw new InvalidConfigError('skillEvolution.enabled must be a boolean.');
  }
  if (typeof config.merge.requireHumanMerge !== 'boolean') {
    throw new InvalidConfigError('skillEvolution.merge.requireHumanMerge must be a boolean.');
  }
  if (!Number.isInteger(config.merge.maxRollbackVersions) || config.merge.maxRollbackVersions < 1) {
    throw new InvalidConfigError('skillEvolution.merge.maxRollbackVersions must be an integer >= 1.');
  }
  if (typeof config.sessionOverlay.enabled !== 'boolean') {
    throw new InvalidConfigError('skillEvolution.sessionOverlay.enabled must be a boolean.');
  }
  if (typeof config.sessionOverlay.storageDir !== 'string' || config.sessionOverlay.storageDir.length === 0) {
    throw new InvalidConfigError('skillEvolution.sessionOverlay.storageDir must be a non-empty string.');
  }
  if (config.sessionOverlay.injectMode !== 'system-context' && config.sessionOverlay.injectMode !== 'tool-description') {
    throw new InvalidConfigError('skillEvolution.sessionOverlay.injectMode must be "system-context" or "tool-description".');
  }
  if (typeof config.sessionOverlay.clearOnSessionEnd !== 'boolean') {
    throw new InvalidConfigError('skillEvolution.sessionOverlay.clearOnSessionEnd must be a boolean.');
  }
  if (config.sessionOverlay.maxInjectionChars !== undefined) {
    if (!Number.isInteger(config.sessionOverlay.maxInjectionChars) || config.sessionOverlay.maxInjectionChars < 1) {
      throw new InvalidConfigError('skillEvolution.sessionOverlay.maxInjectionChars must be a positive integer.');
    }
  }
  if (typeof config.triggers.onToolError !== 'boolean') {
    throw new InvalidConfigError('skillEvolution.triggers.onToolError must be a boolean.');
  }
  if (typeof config.triggers.onUserCorrection !== 'boolean') {
    throw new InvalidConfigError('skillEvolution.triggers.onUserCorrection must be a boolean.');
  }
  if (typeof config.triggers.onSessionEndReview !== 'boolean') {
    throw new InvalidConfigError('skillEvolution.triggers.onSessionEndReview must be a boolean.');
  }
  if (typeof config.triggers.onPositiveFeedback !== 'boolean') {
    throw new InvalidConfigError('skillEvolution.triggers.onPositiveFeedback must be a boolean.');
  }
  if (typeof config.llm.inheritPrimaryConfig !== 'boolean') {
    throw new InvalidConfigError('skillEvolution.llm.inheritPrimaryConfig must be a boolean.');
  }
  if (config.llm.modelOverride !== null && typeof config.llm.modelOverride !== 'string') {
    throw new InvalidConfigError('skillEvolution.llm.modelOverride must be string or null.');
  }
  if (config.llm.thinkingOverride !== null && typeof config.llm.thinkingOverride !== 'boolean') {
    throw new InvalidConfigError('skillEvolution.llm.thinkingOverride must be boolean or null.');
  }
  if (config.llm.provider !== null && typeof config.llm.provider !== 'string') {
    throw new InvalidConfigError('skillEvolution.llm.provider must be string or null.');
  }
  if (!Number.isInteger(config.review.minEvidenceCount) || config.review.minEvidenceCount < 0) {
    throw new InvalidConfigError('skillEvolution.review.minEvidenceCount must be an integer >= 0.');
  }
  if (typeof config.review.allowAutoMergeOnLowRiskOnly !== 'boolean') {
    throw new InvalidConfigError('skillEvolution.review.allowAutoMergeOnLowRiskOnly must be a boolean.');
  }

  // === v2 field validation ===
  if (config.reviewMode !== undefined) {
    if (!VALID_REVIEW_MODES.includes(config.reviewMode as typeof VALID_REVIEW_MODES[number])) {
      throw new InvalidConfigError(
        `skillEvolution.reviewMode must be one of: ${VALID_REVIEW_MODES.join(', ')}`
      );
    }
  }

  if (config.notify) {
    if (typeof config.notify.enabled !== 'boolean') {
      throw new InvalidConfigError('skillEvolution.notify.enabled must be a boolean.');
    }
    if (!VALID_NOTIFY_MODES.includes(config.notify.mode as typeof VALID_NOTIFY_MODES[number])) {
      throw new InvalidConfigError(
        `skillEvolution.notify.mode must be one of: ${VALID_NOTIFY_MODES.join(', ')}`
      );
    }
    if (typeof config.notify.channel !== 'string') {
      throw new InvalidConfigError('skillEvolution.notify.channel must be a string.');
    }
  }

  if (config.agents) {
    validateAgentConfig(config.agents.review, 'agents.review');
    validateAgentConfig(config.agents.notify, 'agents.notify');
  }

  if (config.agent) {
    if (typeof config.agent.enabled !== 'boolean') {
      throw new InvalidConfigError('skillEvolution.agent.enabled must be a boolean.');
    }
    if (typeof config.agent.id !== 'string' || config.agent.id.length === 0) {
      throw new InvalidConfigError('skillEvolution.agent.id must be a non-empty string.');
    }
  }

  if (config.sessions) {
    validateSessionConfig(config.sessions.review, 'sessions.review');
    validateSessionConfig(config.sessions.notify, 'sessions.notify');
  }

  if (config.queue) {
    if (typeof config.queue.storageDir !== 'string' || config.queue.storageDir.length === 0) {
      throw new InvalidConfigError('skillEvolution.queue.storageDir must be a non-empty string.');
    }
    if (!Number.isInteger(config.queue.dedupeWindowMinutes) || config.queue.dedupeWindowMinutes < 0) {
      throw new InvalidConfigError('skillEvolution.queue.dedupeWindowMinutes must be an integer >= 0.');
    }
    if (!Number.isInteger(config.queue.maxPendingPerSkill) || config.queue.maxPendingPerSkill < 1) {
      throw new InvalidConfigError('skillEvolution.queue.maxPendingPerSkill must be an integer >= 1.');
    }
  }

  if (config.notifications) {
    if (!Number.isInteger(config.notifications.debounceSeconds) || config.notifications.debounceSeconds < 0) {
      throw new InvalidConfigError('skillEvolution.notifications.debounceSeconds must be an integer >= 0.');
    }
    if (typeof config.notifications.digestCron !== 'string') {
      throw new InvalidConfigError('skillEvolution.notifications.digestCron must be a string.');
    }
    if (!VALID_RISK_LEVELS.includes(config.notifications.minRiskToInterrupt as typeof VALID_RISK_LEVELS[number])) {
      throw new InvalidConfigError(
        `skillEvolution.notifications.minRiskToInterrupt must be one of: ${VALID_RISK_LEVELS.join(', ')}`
      );
    }
  }

  if (config.risk) {
    if (!VALID_RISK_LEVELS.includes(config.risk.autoApplyMaxRisk as typeof VALID_RISK_LEVELS[number])) {
      throw new InvalidConfigError(
        `skillEvolution.risk.autoApplyMaxRisk must be one of: ${VALID_RISK_LEVELS.join(', ')}`
      );
    }
    if (!VALID_RISK_LEVELS.includes(config.risk.notifyMinRisk as typeof VALID_RISK_LEVELS[number])) {
      throw new InvalidConfigError(
        `skillEvolution.risk.notifyMinRisk must be one of: ${VALID_RISK_LEVELS.join(', ')}`
      );
    }
  }
}

function validateAgentConfig(
  agent: { enabled: boolean; agentId: string; spawnMode: string; thread: boolean; model: string | null; thinking: string | null; runTimeoutSeconds?: number },
  prefix: string
): void {
  if (typeof agent.enabled !== 'boolean') {
    throw new InvalidConfigError(`skillEvolution.${prefix}.enabled must be a boolean.`);
  }
  if (typeof agent.agentId !== 'string' || agent.agentId.length === 0) {
    throw new InvalidConfigError(`skillEvolution.${prefix}.agentId must be a non-empty string.`);
  }
  if (!VALID_SPAWN_MODES.includes(agent.spawnMode as typeof VALID_SPAWN_MODES[number])) {
    throw new InvalidConfigError(
      `skillEvolution.${prefix}.spawnMode must be one of: ${VALID_SPAWN_MODES.join(', ')}`
    );
  }
  if (typeof agent.thread !== 'boolean') {
    throw new InvalidConfigError(`skillEvolution.${prefix}.thread must be a boolean.`);
  }
  if (agent.runTimeoutSeconds !== undefined) {
    if (!Number.isInteger(agent.runTimeoutSeconds) || agent.runTimeoutSeconds < 1) {
      throw new InvalidConfigError(`skillEvolution.${prefix}.runTimeoutSeconds must be an integer >= 1.`);
    }
  }
}

function validateSessionConfig(
  session: { enabled: boolean; reuse: boolean; thread: boolean; timeoutSeconds: number },
  prefix: string
): void {
  if (typeof session.enabled !== 'boolean') {
    throw new InvalidConfigError(`skillEvolution.${prefix}.enabled must be a boolean.`);
  }
  if (typeof session.reuse !== 'boolean') {
    throw new InvalidConfigError(`skillEvolution.${prefix}.reuse must be a boolean.`);
  }
  if (typeof session.thread !== 'boolean') {
    throw new InvalidConfigError(`skillEvolution.${prefix}.thread must be a boolean.`);
  }
  if (!Number.isInteger(session.timeoutSeconds) || session.timeoutSeconds < 1) {
    throw new InvalidConfigError(`skillEvolution.${prefix}.timeoutSeconds must be an integer >= 1.`);
  }
}

/**
 * Migrates legacy `agents.review/notify` config to `agent` + `sessions`.
 * Called after deepMerge when old-style `agents` field is detected.
 */
export function migrateAgentsCompat(config: SkillEvolutionConfig): void {
  if (!config.agents) return;

  // Only migrate if new fields are not explicitly set
  if (!config.agent || config.agent.id === 'skill-evolution') {
    config.agent = {
      enabled: config.agents.review.enabled || config.agents.notify.enabled,
      id: 'skill-evolution',
      model: config.agents.review.model ?? config.agents.notify.model ?? null,
    };
  }

  if (!config.sessions) {
    config.sessions = {
      review: {
        enabled: config.agents.review.enabled,
        reuse: config.agents.review.spawnMode === 'session',
        thread: config.agents.review.thread,
        timeoutSeconds: config.agents.review.runTimeoutSeconds ?? 180,
      },
      notify: {
        enabled: config.agents.notify.enabled,
        reuse: config.agents.notify.spawnMode === 'session',
        thread: config.agents.notify.thread,
        timeoutSeconds: 60,
      },
    };
  }
}

/**
 * Backward-compat derivation: derives reviewMode from v1 fields
 * when no explicit reviewMode was set by the user.
 */
function deriveReviewModeCompat(config: SkillEvolutionConfig): void {
  if (!config.triggers.onSessionEndReview) {
    config.reviewMode = 'off';
  } else {
    config.reviewMode = 'queue-only';
  }
}

/**
 * Performs a recursive merge where source values override defaults.
 */
export function deepMerge(defaultConfig: SkillEvolutionConfig, source: SkillEvolutionConfig): SkillEvolutionConfig {
  const result = {
    ...defaultConfig,
    ...source,
    merge: {
      ...defaultConfig.merge,
      ...source.merge
    },
    sessionOverlay: {
      ...defaultConfig.sessionOverlay,
      ...source.sessionOverlay
    },
    triggers: {
      ...defaultConfig.triggers,
      ...source.triggers
    },
    llm: {
      ...defaultConfig.llm,
      ...source.llm
    },
    review: {
      ...defaultConfig.review,
      ...source.review
    },
  };

  // Deep merge v2 nested fields only when source provides them
  if (source.notify) {
    result.notify = { ...defaultConfig.notify!, ...source.notify };
  }
  if (source.agents) {
    result.agents = {
      review: { ...defaultConfig.agents!.review, ...source.agents.review },
      notify: { ...defaultConfig.agents!.notify, ...source.agents.notify },
    };
  }
  if (source.agent) {
    result.agent = { ...defaultConfig.agent!, ...source.agent };
  }
  if (source.sessions) {
    result.sessions = {
      review: { ...defaultConfig.sessions!.review, ...source.sessions.review },
      notify: { ...defaultConfig.sessions!.notify, ...source.sessions.notify },
    };
  }
  if (source.queue) {
    result.queue = { ...defaultConfig.queue!, ...source.queue };
  }
  if (source.notifications) {
    result.notifications = { ...defaultConfig.notifications!, ...source.notifications };
  }
  if (source.risk) {
    result.risk = { ...defaultConfig.risk!, ...source.risk };
  }

  return result;
}

/**
 * Checks if an unknown value is a non-null object record.
 */
function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}
