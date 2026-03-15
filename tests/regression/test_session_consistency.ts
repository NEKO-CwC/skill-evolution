import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chdir, cwd } from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import register from '../../src/openclaw.ts';
import type {
  AfterToolCallHandler,
  BeforePromptBuildHandler,
  HookOptions,
  MessageReceivedHandler,
  AgentEndHandler,
  SessionEndHandler,
  OpenClawPluginApi,
  PluginHookAgentContext,
  PluginHookMessageContext,
  PluginHookToolContext
} from '../../src/shared/types.ts';

type HookName = 'before_prompt_build' | 'after_tool_call' | 'message_received' | 'agent_end' | 'session_end';

type HookHandlerMap = {
  before_prompt_build: BeforePromptBuildHandler;
  after_tool_call: AfterToolCallHandler;
  message_received: MessageReceivedHandler;
  agent_end: AgentEndHandler;
  session_end: SessionEndHandler;
};

type RegisteredHook = {
  name: HookName;
  handler: HookHandlerMap[HookName];
  opts?: HookOptions;
};

class MockOpenClawApi implements OpenClawPluginApi {
  public readonly id = 'skill-evolution';
  public readonly name = 'Skill Evolution';
  public readonly logger: unknown = {};
  public readonly pluginConfig?: Record<string, unknown>;
  public readonly hooks: RegisteredHook[] = [];

  public constructor(config: Record<string, unknown> | undefined = {}) {
    this.pluginConfig = config;
  }

  public on<K extends HookName>(hookName: K, handler: HookHandlerMap[K], opts?: HookOptions): void {
    this.hooks.push({ name: hookName, handler, opts } as RegisteredHook);
  }
}

function getHook<K extends HookName>(api: MockOpenClawApi, name: K): HookHandlerMap[K] {
  const hook = api.hooks.find((entry) => entry.name === name);
  if (!hook) throw new Error(`Missing hook: ${name}`);
  return hook.handler as HookHandlerMap[K];
}

describe('Regression: Session ID consistency across hooks', () => {
  let tempRoot = '';
  let previousCwd = '';
  let savedStateDir: string | undefined;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'skill-regression-sessid-'));
    previousCwd = cwd();
    chdir(tempRoot);
    savedStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tempRoot;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    chdir(previousCwd);
    if (savedStateDir !== undefined) {
      process.env.OPENCLAW_STATE_DIR = savedStateDir;
    } else {
      delete process.env.OPENCLAW_STATE_DIR;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('same session ID resolves consistently across before_prompt_build, message_received, and session_end', async () => {
    const api = new MockOpenClawApi({
      review: { minEvidenceCount: 1 },
      llm: { inheritPrimaryConfig: false }
    });
    register(api);

    const beforePromptBuild = getHook(api, 'before_prompt_build');
    const messageReceived = getHook(api, 'message_received');
    const afterToolCall = getHook(api, 'after_tool_call');
    const sessionEnd = getHook(api, 'session_end');

    const sharedSessionId = 'unified-session-123';

    await beforePromptBuild(
      { prompt: 'BASE', messages: [] },
      { sessionId: sharedSessionId, skillKey: 'session.test', workspaceDir: tempRoot } as PluginHookAgentContext & { skillKey: string }
    );

    await afterToolCall(
      { toolName: 'shell', params: {}, error: 'Error: tool failed' },
      { sessionId: sharedSessionId, toolName: 'shell' } as PluginHookToolContext
    );

    await messageReceived(
      { from: 'user', content: 'wrong, fix this' },
      { channelId: 'some-channel', conversationId: sharedSessionId } as PluginHookMessageContext
    );

    const overlayResult = await beforePromptBuild(
      { prompt: 'BASE', messages: [] },
      { sessionId: sharedSessionId }
    );
    expect(overlayResult?.prependSystemContext).toContain('--- SKILL OVERLAY (session-local) ---');

    await sessionEnd(
      { sessionId: sharedSessionId, reason: 'explicit' },
      { sessionId: sharedSessionId }
    );

    const afterCleanup = await beforePromptBuild(
      { prompt: 'BASE', messages: [] },
      { sessionId: sharedSessionId }
    );
    expect(afterCleanup).toBeUndefined();
  });

  it('resolveSessionId uses sessionKey fallback when sessionId is missing', async () => {
    const api = new MockOpenClawApi({});
    register(api);

    const beforePromptBuild = getHook(api, 'before_prompt_build');
    const afterToolCall = getHook(api, 'after_tool_call');

    await beforePromptBuild(
      { prompt: 'BASE', messages: [] },
      { sessionKey: 'key-fallback', skillKey: 'test.skill' } as PluginHookAgentContext & { skillKey: string }
    );

    await afterToolCall(
      { toolName: 'shell', params: {}, error: 'Error: failed' },
      { sessionKey: 'key-fallback', toolName: 'shell' } as PluginHookToolContext
    );

    const overlayResult = await beforePromptBuild(
      { prompt: 'BASE', messages: [] },
      { sessionKey: 'key-fallback' }
    );
    expect(overlayResult?.prependSystemContext).toContain('--- SKILL OVERLAY (session-local) ---');
  });

  it('message_received uses sessionId from conversationId when sessionId absent', async () => {
    const api = new MockOpenClawApi({});
    register(api);

    const beforePromptBuild = getHook(api, 'before_prompt_build');
    const messageReceived = getHook(api, 'message_received');

    await beforePromptBuild(
      { prompt: 'BASE', messages: [] },
      { sessionId: 'conv-123', skillKey: 'test.skill' } as PluginHookAgentContext & { skillKey: string }
    );

    await messageReceived(
      { from: 'user', content: 'This is wrong, fix this' },
      { channelId: 'ch-1', conversationId: 'conv-123' } as PluginHookMessageContext
    );

    const overlayResult = await beforePromptBuild(
      { prompt: 'BASE', messages: [] },
      { sessionId: 'conv-123' }
    );
    expect(overlayResult?.prependSystemContext).toContain('User correction received');
  });
});
