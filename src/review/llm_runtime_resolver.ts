import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import type { LlmResolver, Logger, ParsedProvidersConfig, ResolvedProvider } from '../shared/types.js';
import { ConsoleLogger } from '../shared/logger.js';

/**
 * Resolves LLM provider configuration with strict priority:
 *   1. Environment variables (key-only sufficient for OpenRouter/OpenAI/Anthropic)
 *   2. openclaw.json file (based on bound workspace path)
 *   3. Error with structured diagnostics
 */
export class LlmRuntimeResolver implements LlmResolver {
  private readonly logger: Logger;
  private readonly workspaceDir: string;

  public constructor(workspaceDir: string, logger?: Logger) {
    this.workspaceDir = workspaceDir;
    this.logger = logger ?? new ConsoleLogger('llm_runtime_resolver');
  }

  public resolve(model: string, explicitProvider?: string | null): ResolvedProvider {
    let routingProviderId: string | null = null;
    let apiModelId: string = model;

    if (explicitProvider) {
      // Explicit provider: use it for routing, model string goes verbatim to API
      routingProviderId = explicitProvider;
    } else if (model.includes('/')) {
      // Legacy behavior: split on first slash
      const parts = model.split('/');
      routingProviderId = parts[0];
      apiModelId = parts.slice(1).join('/');
    }

    this.logger.debug('Resolving LLM provider', {
      model,
      routingProviderId,
      apiModelId,
      explicitProvider: explicitProvider ?? null,
      workspaceDir: this.workspaceDir
    });

    // Priority 1: Environment variables
    const env = this.tryEnvironment(apiModelId);
    if (env) return env;

    // Priority 2: openclaw.json file
    const file = this.tryOpenClawConfigFile(routingProviderId, apiModelId);
    if (file) return file;

    // All sources exhausted — structured error
    const configCandidates = this.getConfigCandidatePaths();
    const attemptedSources: string[] = [
      'env: OPENCLAW_ANYROUTER_BASE_URL + OPENCLAW_ANYROUTER_API_KEY',
      'env: OPENROUTER_API_KEY (+ optional OPENROUTER_BASE_URL)',
      'env: OPENAI_API_KEY (+ optional OPENAI_BASE_URL)',
      'env: ANTHROPIC_API_KEY',
      ...configCandidates.map(p => `file: ${p} (exists: ${existsSync(p)})`)
    ];

    const message = [
      `LLM provider not configured for model "${model}".`,
      `Workspace: ${this.workspaceDir}`,
      'Attempted sources:',
      ...attemptedSources.map(s => `  - ${s}`)
    ].join('\n');

    this.logger.error('LLM provider resolution failed', {
      model,
      routingProviderId,
      workspaceDir: this.workspaceDir,
      attemptedSources,
      attemptedConfigPaths: configCandidates
    });
    throw new Error(message);
  }

  /**
   * Reads the primary model ID from openclaw.json at agents.defaults.model.primary.
   * Also infers the provider when the first segment of the model string matches
   * a key in models.providers from the same config file.
   * Returns null if no config file exists or the field is missing.
   */
  public readPrimaryModel(): { model: string; provider: string | null } | null {
    for (const configPath of this.getConfigCandidatePaths()) {
      if (!existsSync(configPath)) continue;
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
        const agents = config?.agents as Record<string, unknown> | undefined;
        const defaults = agents?.defaults as Record<string, unknown> | undefined;
        const modelSection = defaults?.model as Record<string, unknown> | undefined;
        const primary = modelSection?.primary;
        if (typeof primary !== 'string' || primary.length === 0) continue;

        // Infer provider: check if the first segment matches a configured provider key
        let inferredProvider: string | null = null;
        if (primary.includes('/')) {
          const providers = (config?.models as Record<string, unknown> | undefined)
            ?.providers as Record<string, unknown> | undefined;
          if (providers && typeof providers === 'object') {
            const firstSegment = primary.split('/')[0];
            if (firstSegment in providers) {
              inferredProvider = firstSegment;
            }
          }
        }

        return { model: primary, provider: inferredProvider };
      } catch { continue; }
    }
    return null;
  }

  private tryEnvironment(modelId: string): ResolvedProvider | null {
    // AnyRouter: requires both base URL and API key
    const anyrouterUrl = process.env.OPENCLAW_ANYROUTER_BASE_URL;
    const anyrouterKey = process.env.OPENCLAW_ANYROUTER_API_KEY;
    if (anyrouterUrl && anyrouterKey) {
      this.logger.debug('Resolved from env OPENCLAW_ANYROUTER', { baseUrl: anyrouterUrl.substring(0, 30) });
      return { baseUrl: anyrouterUrl, apiKey: anyrouterKey, api: 'anthropic-messages', modelId, resolvedFrom: 'env' };
    }

    // OpenRouter: key required, base URL optional (default: https://openrouter.ai/api/v1)
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    if (openrouterKey) {
      const openrouterUrl = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';
      this.logger.debug('Resolved from env OPENROUTER', { baseUrl: openrouterUrl.substring(0, 30) });
      return { baseUrl: openrouterUrl, apiKey: openrouterKey, api: 'openai', modelId, resolvedFrom: 'env' };
    }

    // OpenAI: key required, base URL optional (default: https://api.openai.com)
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      const openaiUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com';
      this.logger.debug('Resolved from env OPENAI', { baseUrl: openaiUrl.substring(0, 30) });
      return { baseUrl: openaiUrl, apiKey: openaiKey, api: 'openai', modelId, resolvedFrom: 'env' };
    }

    // Anthropic: key required, base URL fixed
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      this.logger.debug('Resolved from env ANTHROPIC_API_KEY');
      return { baseUrl: 'https://api.anthropic.com/v1', apiKey: anthropicKey, api: 'anthropic-messages', modelId, resolvedFrom: 'env' };
    }

    return null;
  }

  private normalizeApi(matchApi: string | undefined): 'openai' | 'anthropic-messages' {
    const api = (matchApi ?? 'openai').toLowerCase().trim();
    const openaiVariants = ['openai', 'openai-completions', 'openai-chat-completions'];
    if (openaiVariants.includes(api)) {
      return 'openai';
    }
    if (api === 'anthropic-messages' || api === 'anthropic') {
      return 'anthropic-messages';
    }
    throw new Error(`Unsupported provider api: ${matchApi}. Supported: openai, openai-completions, openai-chat-completions, anthropic-messages`);
  }

  private tryOpenClawConfigFile(providerId: string | null, modelId: string): ResolvedProvider | null {
    const candidates = this.getConfigCandidatePaths();

    for (const configPath of candidates) {
      this.logger.debug('Trying openclaw.json candidate', { configPath, exists: existsSync(configPath) });

      if (!existsSync(configPath)) {
        continue;
      }

      let config: Record<string, unknown>;
      try {
        const configContent = readFileSync(configPath, 'utf8');
        config = JSON.parse(configContent) as Record<string, unknown>;
      } catch (err: unknown) {
        this.logger.warn('Failed to read/parse openclaw.json', {
          configPath,
          error: err instanceof Error ? err.message : String(err)
        });
        continue;
      }

      const models = config?.models as Record<string, unknown> | undefined;
      const providers = models?.providers as ParsedProvidersConfig['providers'] | undefined;

      if (!providers) {
        this.logger.debug('openclaw.json found but no models.providers section', { configPath });
        continue;
      }

      let match: { baseUrl?: string; apiKey?: string; api?: string } | undefined;
      let matchedProvider: string | null = null;

      if (providerId && providers[providerId]) {
        match = providers[providerId];
        matchedProvider = providerId;
      } else if (providers['anyrouter']) {
        match = providers['anyrouter'];
        matchedProvider = 'anyrouter';
      } else if (providers['openrouter']) {
        match = providers['openrouter'];
        matchedProvider = 'openrouter';
      }

      if (match?.baseUrl && match?.apiKey) {
        this.logger.info('Resolved from openclaw.json file', {
          configPath,
          matchedProvider
        });
        return {
          baseUrl: match.baseUrl,
          apiKey: match.apiKey,
          api: this.normalizeApi(match.api),
          modelId,
          resolvedFrom: 'openclaw-config'
        };
      }

      this.logger.debug('openclaw.json provider found but missing baseUrl or apiKey', {
        configPath,
        matchedProvider,
        hasBaseUrl: !!match?.baseUrl,
        hasApiKey: !!match?.apiKey
      });
    }

    return null;
  }

  /**
   * Returns candidate paths for openclaw.json, ordered by preference.
   * Checks workspace parent, workspace itself, and the standard OpenClaw
   * state directory (~/.openclaw/ or OPENCLAW_STATE_DIR).
   */
  private getConfigCandidatePaths(): string[] {
    const stateDir = process.env.OPENCLAW_STATE_DIR
      ?? join(homedir(), '.openclaw');
    return [
      join(this.workspaceDir, '..', 'openclaw.json'),
      join(this.workspaceDir, 'openclaw.json'),
      join(stateDir, 'openclaw.json')
    ];
  }
}

export default LlmRuntimeResolver;
