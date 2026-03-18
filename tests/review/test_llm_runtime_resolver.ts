import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LlmRuntimeResolver } from '../../src/review/llm_runtime_resolver.ts';

describe('review/llm_runtime_resolver', () => {
  let tempRoot = '';
  const savedEnv: Record<string, string | undefined> = {};

  const ENV_KEYS = [
    'OPENCLAW_ANYROUTER_BASE_URL', 'OPENCLAW_ANYROUTER_API_KEY',
    'OPENROUTER_BASE_URL', 'OPENROUTER_API_KEY',
    'OPENAI_BASE_URL', 'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENCLAW_STATE_DIR'
  ];

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'skill-resolver-'));
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // Isolate from real ~/.openclaw/openclaw.json
    process.env.OPENCLAW_STATE_DIR = tempRoot;
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  // ── Env: AnyRouter (requires both base + key) ──

  it('env: OPENCLAW_ANYROUTER resolves when both base and key are set', () => {
    process.env.OPENCLAW_ANYROUTER_BASE_URL = 'https://anyrouter.example.com';
    process.env.OPENCLAW_ANYROUTER_API_KEY = 'anyrouter-key';

    const resolver = new LlmRuntimeResolver(tempRoot);
    const result = resolver.resolve('some/model');

    expect(result.resolvedFrom).toBe('env');
    expect(result.baseUrl).toBe('https://anyrouter.example.com');
    expect(result.apiKey).toBe('anyrouter-key');
    expect(result.api).toBe('anthropic-messages');
    expect(result.modelId).toBe('model');
  });

  // ── Env: OpenRouter (key only sufficient, base has default) ──

  it('env: OPENROUTER resolves with key only, using default base URL', () => {
    process.env.OPENROUTER_API_KEY = 'or-key';

    const resolver = new LlmRuntimeResolver(tempRoot);
    const result = resolver.resolve('some/model');

    expect(result.resolvedFrom).toBe('env');
    expect(result.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(result.apiKey).toBe('or-key');
    expect(result.api).toBe('openai');
  });

  it('env: OPENROUTER uses custom base URL when provided', () => {
    process.env.OPENROUTER_API_KEY = 'or-key';
    process.env.OPENROUTER_BASE_URL = 'https://custom-openrouter.example.com';

    const resolver = new LlmRuntimeResolver(tempRoot);
    const result = resolver.resolve('model');

    expect(result.baseUrl).toBe('https://custom-openrouter.example.com');
  });

  // ── Env: OpenAI (key only sufficient, base has default) ──

  it('env: OPENAI resolves with key only, using default base URL', () => {
    process.env.OPENAI_API_KEY = 'sk-test';

    const resolver = new LlmRuntimeResolver(tempRoot);
    const result = resolver.resolve('gpt-4');

    expect(result.resolvedFrom).toBe('env');
    expect(result.baseUrl).toBe('https://api.openai.com');
    expect(result.apiKey).toBe('sk-test');
    expect(result.api).toBe('openai');
    expect(result.modelId).toBe('gpt-4');
  });

  it('env: OPENAI uses custom base URL when provided', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_BASE_URL = 'https://custom-openai.example.com/v1';

    const resolver = new LlmRuntimeResolver(tempRoot);
    const result = resolver.resolve('model');

    expect(result.baseUrl).toBe('https://custom-openai.example.com/v1');
  });

  // ── Env: Anthropic (key only) ──

  it('env: ANTHROPIC_API_KEY resolves with default base URL', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

    const resolver = new LlmRuntimeResolver(tempRoot);
    const result = resolver.resolve('claude-3-opus');

    expect(result.resolvedFrom).toBe('env');
    expect(result.baseUrl).toBe('https://api.anthropic.com/v1');
    expect(result.apiKey).toBe('sk-ant-test');
    expect(result.api).toBe('anthropic-messages');
  });

  // ── Env priority ordering ──

  it('env priority: AnyRouter > OpenRouter > OpenAI > Anthropic', () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-key';
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-key';
    process.env.OPENCLAW_ANYROUTER_BASE_URL = 'https://anyrouter.example.com';
    process.env.OPENCLAW_ANYROUTER_API_KEY = 'anyrouter-key';

    const resolver = new LlmRuntimeResolver(tempRoot);
    const result = resolver.resolve('model');

    expect(result.baseUrl).toBe('https://anyrouter.example.com');
    expect(result.apiKey).toBe('anyrouter-key');
  });

  it('env priority: OpenRouter wins when AnyRouter not set', () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-key';
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-key';

    const resolver = new LlmRuntimeResolver(tempRoot);
    const result = resolver.resolve('model');

    expect(result.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(result.apiKey).toBe('openrouter-key');
  });

  // ── File fallback: openclaw.json ──

  it('file fallback: reads openclaw.json from workspace parent dir', async () => {
    const parentDir = join(tempRoot, 'parent');
    const workspaceDir = join(parentDir, 'workspace');
    await mkdir(workspaceDir, { recursive: true });

    const openclawConfig = {
      models: {
        providers: {
          openrouter: {
            baseUrl: 'https://file-openrouter.example.com',
            apiKey: 'file-key',
            api: 'openai'
          }
        }
      }
    };
    await writeFile(join(parentDir, 'openclaw.json'), JSON.stringify(openclawConfig));

    const resolver = new LlmRuntimeResolver(workspaceDir);
    const result = resolver.resolve('openrouter/some-model');

    expect(result.resolvedFrom).toBe('openclaw-config');
    expect(result.baseUrl).toBe('https://file-openrouter.example.com');
    expect(result.apiKey).toBe('file-key');
    expect(result.modelId).toBe('some-model');
  });

  it('file fallback: reads openclaw.json from workspace dir itself as second candidate', async () => {
    const workspaceDir = join(tempRoot, 'workspace');
    await mkdir(workspaceDir, { recursive: true });

    const openclawConfig = {
      models: {
        providers: {
          anyrouter: {
            baseUrl: 'https://ws-config.example.com',
            apiKey: 'ws-key',
            api: 'anthropic-messages'
          }
        }
      }
    };
    // Place config in workspace dir itself (second candidate)
    await writeFile(join(workspaceDir, 'openclaw.json'), JSON.stringify(openclawConfig));

    const resolver = new LlmRuntimeResolver(workspaceDir);
    const result = resolver.resolve('any/model');

    expect(result.resolvedFrom).toBe('openclaw-config');
    expect(result.baseUrl).toBe('https://ws-config.example.com');
  });

  it('file fallback: env takes priority over file', async () => {
    const parentDir = join(tempRoot, 'parent');
    const workspaceDir = join(parentDir, 'workspace');
    await mkdir(workspaceDir, { recursive: true });

    await writeFile(join(parentDir, 'openclaw.json'), JSON.stringify({
      models: { providers: { openrouter: { baseUrl: 'https://file.com', apiKey: 'file-key' } } }
    }));

    process.env.OPENROUTER_API_KEY = 'env-key';

    const resolver = new LlmRuntimeResolver(workspaceDir);
    const result = resolver.resolve('model');

    expect(result.resolvedFrom).toBe('env');
    expect(result.apiKey).toBe('env-key');
  });

  // ── Error diagnostics ──

  it('throws structured error with workspaceDir, attemptedSources, and configPaths', () => {
    const resolver = new LlmRuntimeResolver(tempRoot);

    expect(() => resolver.resolve('some/model')).toThrow(
      /LLM provider not configured for model "some\/model"/
    );

    try {
      resolver.resolve('test/model');
    } catch (err: unknown) {
      const message = (err as Error).message;
      expect(message).toContain(tempRoot);
      expect(message).toContain('OPENCLAW_ANYROUTER');
      expect(message).toContain('OPENROUTER_API_KEY');
      expect(message).toContain('OPENAI_API_KEY');
      expect(message).toContain('ANTHROPIC_API_KEY');
      expect(message).toContain('openclaw.json');
    }
  });

  // ── Model string parsing ──

  it('model string without slash uses full string as modelId', () => {
    process.env.OPENROUTER_API_KEY = 'key';

    const resolver = new LlmRuntimeResolver(tempRoot);
    const result = resolver.resolve('plain-model-name');

    expect(result.modelId).toBe('plain-model-name');
  });

  it('model string with slash extracts provider and model', () => {
    process.env.OPENROUTER_API_KEY = 'key';

    const resolver = new LlmRuntimeResolver(tempRoot);
    const result = resolver.resolve('openrouter/stepfun/step-3.5-flash:free');

    expect(result.modelId).toBe('stepfun/step-3.5-flash:free');
  });

  // ── Explicit provider parameter ──

  it('explicit provider: strips matching provider prefix from model ID', () => {
    process.env.OPENROUTER_API_KEY = 'key';

    const resolver = new LlmRuntimeResolver(tempRoot);
    const result = resolver.resolve('openrouter/hunter-alpha', 'openrouter');

    // Provider prefix should be stripped to avoid double-prefix in API calls
    expect(result.modelId).toBe('hunter-alpha');
  });

  it('explicit provider: preserves model ID when prefix does not match', () => {
    process.env.OPENROUTER_API_KEY = 'key';

    const resolver = new LlmRuntimeResolver(tempRoot);
    const result = resolver.resolve('anthropic/claude-3.5-sonnet', 'openrouter');

    // Different prefix: model sent verbatim
    expect(result.modelId).toBe('anthropic/claude-3.5-sonnet');
  });

  it('explicit provider: strips prefix and routes to correct file-based provider config', async () => {
    const parentDir = join(tempRoot, 'parent');
    const workspaceDir = join(parentDir, 'workspace');
    await mkdir(workspaceDir, { recursive: true });

    const openclawConfig = {
      models: {
        providers: {
          openrouter: {
            baseUrl: 'https://openrouter.ai/api/v1',
            apiKey: 'or-file-key',
            api: 'openai'
          }
        }
      }
    };
    await writeFile(join(parentDir, 'openclaw.json'), JSON.stringify(openclawConfig));

    const resolver = new LlmRuntimeResolver(workspaceDir);
    const result = resolver.resolve('openrouter/hunter-alpha', 'openrouter');

    expect(result.resolvedFrom).toBe('openclaw-config');
    expect(result.modelId).toBe('hunter-alpha');
    expect(result.apiKey).toBe('or-file-key');
  });

  // ── readPrimaryModel ──

  it('readPrimaryModel: returns model and inferred provider from openclaw.json', async () => {
    const parentDir = join(tempRoot, 'parent');
    const workspaceDir = join(parentDir, 'workspace');
    await mkdir(workspaceDir, { recursive: true });

    const openclawConfig = {
      agents: {
        defaults: {
          model: {
            primary: 'openrouter/anthropic/claude-3.5-sonnet'
          }
        }
      },
      models: {
        providers: {
          openrouter: {
            baseUrl: 'https://openrouter.ai/api/v1',
            apiKey: 'key'
          }
        }
      }
    };
    await writeFile(join(parentDir, 'openclaw.json'), JSON.stringify(openclawConfig));

    const resolver = new LlmRuntimeResolver(workspaceDir);
    const result = resolver.readPrimaryModel();
    expect(result).toEqual({
      model: 'openrouter/anthropic/claude-3.5-sonnet',
      provider: 'openrouter'
    });
  });

  it('readPrimaryModel: returns null provider when no matching provider in config', async () => {
    const parentDir = join(tempRoot, 'parent');
    const workspaceDir = join(parentDir, 'workspace');
    await mkdir(workspaceDir, { recursive: true });

    const openclawConfig = {
      agents: {
        defaults: {
          model: {
            primary: 'openrouter/hunter-alpha'
          }
        }
      }
      // No models.providers section
    };
    await writeFile(join(parentDir, 'openclaw.json'), JSON.stringify(openclawConfig));

    const resolver = new LlmRuntimeResolver(workspaceDir);
    const result = resolver.readPrimaryModel();
    expect(result).toEqual({
      model: 'openrouter/hunter-alpha',
      provider: null
    });
  });

  it('readPrimaryModel: infers openrouter provider for openrouter/hunter-alpha', async () => {
    const parentDir = join(tempRoot, 'parent');
    const workspaceDir = join(parentDir, 'workspace');
    await mkdir(workspaceDir, { recursive: true });

    const openclawConfig = {
      agents: {
        defaults: {
          model: {
            primary: 'openrouter/hunter-alpha'
          }
        }
      },
      models: {
        providers: {
          openrouter: {
            baseUrl: 'https://openrouter.ai/api/v1',
            apiKey: 'key'
          }
        }
      }
    };
    await writeFile(join(parentDir, 'openclaw.json'), JSON.stringify(openclawConfig));

    const resolver = new LlmRuntimeResolver(workspaceDir);
    const result = resolver.readPrimaryModel();
    expect(result).toEqual({
      model: 'openrouter/hunter-alpha',
      provider: 'openrouter'
    });
  });

  it('readPrimaryModel: returns null when no config exists', () => {
    const resolver = new LlmRuntimeResolver(tempRoot);
    expect(resolver.readPrimaryModel()).toBeNull();
  });

  it('readPrimaryModel: returns null when agents.defaults.model.primary is missing', async () => {
    const parentDir = join(tempRoot, 'parent');
    const workspaceDir = join(parentDir, 'workspace');
    await mkdir(workspaceDir, { recursive: true });

    await writeFile(join(parentDir, 'openclaw.json'), JSON.stringify({ agents: {} }));

    const resolver = new LlmRuntimeResolver(workspaceDir);
    expect(resolver.readPrimaryModel()).toBeNull();
  });

  // ── API normalization in file fallback ──

  it('file fallback: openai-completions api normalizes to openai', async () => {
    const parentDir = join(tempRoot, 'parent');
    const workspaceDir = join(parentDir, 'workspace');
    await mkdir(workspaceDir, { recursive: true });

    const openclawConfig = {
      models: {
        providers: {
          openrouter: {
            baseUrl: 'https://openrouter.ai/api/v1',
            apiKey: 'or-key',
            api: 'openai-completions'
          }
        }
      }
    };
    await writeFile(join(parentDir, 'openclaw.json'), JSON.stringify(openclawConfig));

    const resolver = new LlmRuntimeResolver(workspaceDir);
    const result = resolver.resolve('openrouter/model');

    expect(result.api).toBe('openai');
  });

  it('file fallback: openai-chat-completions api normalizes to openai', async () => {
    const parentDir = join(tempRoot, 'parent');
    const workspaceDir = join(parentDir, 'workspace');
    await mkdir(workspaceDir, { recursive: true });

    await writeFile(join(parentDir, 'openclaw.json'), JSON.stringify({
      models: {
        providers: {
          openrouter: {
            baseUrl: 'https://example.com',
            apiKey: 'key',
            api: 'openai-chat-completions'
          }
        }
      }
    }));

    const resolver = new LlmRuntimeResolver(workspaceDir);
    const result = resolver.resolve('openrouter/model');

    expect(result.api).toBe('openai');
  });

  it('file fallback: anthropic api normalizes to anthropic-messages', async () => {
    const parentDir = join(tempRoot, 'parent');
    const workspaceDir = join(parentDir, 'workspace');
    await mkdir(workspaceDir, { recursive: true });

    await writeFile(join(parentDir, 'openclaw.json'), JSON.stringify({
      models: {
        providers: {
          anthropic: {
            baseUrl: 'https://api.anthropic.com/v1',
            apiKey: 'key',
            api: 'anthropic'
          }
        }
      }
    }));

    const resolver = new LlmRuntimeResolver(workspaceDir);
    const result = resolver.resolve('anthropic/claude-3-opus');

    expect(result.api).toBe('anthropic-messages');
  });

  it('file fallback: missing api field defaults to openai', async () => {
    const parentDir = join(tempRoot, 'parent');
    const workspaceDir = join(parentDir, 'workspace');
    await mkdir(workspaceDir, { recursive: true });

    await writeFile(join(parentDir, 'openclaw.json'), JSON.stringify({
      models: {
        providers: {
          openrouter: {
            baseUrl: 'https://openrouter.ai/api/v1',
            apiKey: 'key'
          }
        }
      }
    }));

    const resolver = new LlmRuntimeResolver(workspaceDir);
    const result = resolver.resolve('openrouter/model');

    expect(result.api).toBe('openai');
  });

  it('file fallback: unsupported api value throws descriptive error', async () => {
    const parentDir = join(tempRoot, 'parent');
    const workspaceDir = join(parentDir, 'workspace');
    await mkdir(workspaceDir, { recursive: true });

    await writeFile(join(parentDir, 'openclaw.json'), JSON.stringify({
      models: {
        providers: {
          custom: {
            baseUrl: 'https://example.com',
            apiKey: 'key',
            api: 'graphql'
          }
        }
      }
    }));

    const resolver = new LlmRuntimeResolver(workspaceDir);

    expect(() => resolver.resolve('custom/model')).toThrow(/Unsupported provider api: graphql/);
  });
});
