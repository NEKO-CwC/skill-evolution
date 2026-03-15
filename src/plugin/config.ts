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
      clearOnSessionEnd: true
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
    }
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
  const defaultConfig = getDefaultConfig();
  const merged = deepMerge(defaultConfig, configFile.skillEvolution);
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
  const merged = deepMerge(defaults, source as SkillEvolutionConfig);
  validateConfig(merged);
  return merged;
}

/**
 * Validates the full plugin configuration schema.
 */
export function validateConfig(config: SkillEvolutionConfig): void {
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
}

/**
 * Performs a recursive merge where source values override defaults.
 */
function deepMerge(defaultConfig: SkillEvolutionConfig, source: SkillEvolutionConfig): SkillEvolutionConfig {
  return {
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
    }
  };
}

/**
 * Checks if an unknown value is a non-null object record.
 */
function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}
