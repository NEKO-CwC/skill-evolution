import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chdir, cwd } from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import register from '../../src/openclaw.ts';
import type {
  AgentEndHandler,
  AfterToolCallHandler,
  BeforePromptBuildEvent,
  BeforePromptBuildHandler,
  HookOptions,
  MessageReceivedHandler,
  OpenClawPluginApi,
  PluginHookAgentContext,
  PluginHookMessageContext,
  PluginHookToolContext,
  SessionEndHandler
} from '../../src/shared/types.ts';
import { SkillEvolutionPlugin } from '../../src/plugin/index.ts';

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

function getHook(api: MockOpenClawApi, name: 'before_prompt_build'): BeforePromptBuildHandler;
function getHook(api: MockOpenClawApi, name: 'after_tool_call'): AfterToolCallHandler;
function getHook(api: MockOpenClawApi, name: 'message_received'): MessageReceivedHandler;
function getHook(api: MockOpenClawApi, name: 'agent_end'): AgentEndHandler;
function getHook(api: MockOpenClawApi, name: 'session_end'): SessionEndHandler;
function getHook(api: MockOpenClawApi, name: HookName): HookHandlerMap[HookName] {
  const hook = api.hooks.find((entry) => entry.name === name);
  if (!hook) {
    throw new Error(`Missing hook: ${name}`);
  }
  return hook.handler;
}

describe('openclaw adapter', () => {
  let tempRoot = '';
  let previousCwd = '';
  let savedStateDir: string | undefined;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'skill-openclaw-adapter-'));
    previousCwd = cwd();
    chdir(tempRoot);
    // Isolate from real ~/.openclaw/openclaw.json so resolveInitialWorkspaceDir
    // doesn't pick up agents.defaults.workspace from the host environment
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

  it('registers all five hooks when enabled', () => {
    const api = new MockOpenClawApi({ enabled: true });

    register(api);

    expect(api.hooks).toHaveLength(5);
    expect(api.hooks.map((entry) => entry.name)).toEqual([
      'before_prompt_build',
      'after_tool_call',
      'message_received',
      'agent_end',
      'session_end'
    ]);
    for (const hook of api.hooks) {
      expect(hook.opts?.priority).toBe(50);
    }
  });

  it('skips registration when enabled=false', () => {
    const api = new MockOpenClawApi({ enabled: false });

    register(api);

    expect(api.hooks).toHaveLength(0);
  });

  it('resolves wrapped OpenClaw config and skips hooks when wrapper sets enabled=false', () => {
    const api = new MockOpenClawApi({
      skillEvolution: {
        enabled: false
      }
    });

    register(api);

    expect(api.hooks).toHaveLength(0);
  });

  it('uses default config when pluginConfig is empty object', () => {
    const api = new MockOpenClawApi({});

    expect(() => register(api)).not.toThrow();
    expect(api.hooks).toHaveLength(5);
  });

  it('falls back to defaults on invalid config', () => {
    const api = new MockOpenClawApi({
      merge: {
        maxRollbackVersions: -1
      }
    });

    expect(() => register(api)).not.toThrow();
    expect(api.hooks).toHaveLength(5);
  });

  it('logs allowPromptInjection degradation notice at registration', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const api = new MockOpenClawApi({});

    register(api);

    const messages = infoSpy.mock.calls.map((call) => String(call[0]));
    expect(messages.some((line) => line.includes('allowPromptInjection'))).toBe(true);
  });

  it('before_prompt_build returns prependSystemContext with overlay', async () => {
    const api = new MockOpenClawApi({});
    register(api);

    const beforePromptBuild = getHook(api, 'before_prompt_build');
    const afterToolCall = getHook(api, 'after_tool_call');
    const sessionId = 'session-overlay';

    await beforePromptBuild(
      { prompt: 'BASE_PROMPT', messages: [] },
      { sessionId, channelId: 'channel', skillKey: 'adapter.skill' } as PluginHookAgentContext & { skillKey: string }
    );

    await afterToolCall(
      { toolName: 'shell', params: {}, error: 'Error: command failed', result: undefined },
      { sessionId, toolName: 'shell' } as PluginHookToolContext
    );

    const result = await beforePromptBuild(
      { prompt: 'BASE_PROMPT', messages: [] },
      { sessionId }
    );

    expect(result).toBeDefined();
    expect(result?.prependSystemContext).toContain('--- SKILL OVERLAY (session-local) ---');
    expect(result?.prependSystemContext).toContain('Tool error observed for shell');
    expect(result?.prependSystemContext).not.toContain('BASE_PROMPT');
  });

  it('before_prompt_build returns undefined when no overlays', async () => {
    const api = new MockOpenClawApi({});
    register(api);

    const beforePromptBuild = getHook(api, 'before_prompt_build');
    const result = await beforePromptBuild(
      { prompt: 'BASE_PROMPT', messages: [] },
      { sessionId: 'session-no-overlay', skillKey: 'adapter.skill' } as PluginHookAgentContext & { skillKey: string }
    );

    expect(result).toBeUndefined();
  });

  it('before_prompt_build resolves skillKey from ctx', async () => {
    const beforeSpy = vi.spyOn(SkillEvolutionPlugin.prototype, 'before_prompt_build');
    const api = new MockOpenClawApi({});
    register(api);

    const beforePromptBuild = getHook(api, 'before_prompt_build');
    await beforePromptBuild(
      { prompt: 'BASE_PROMPT', messages: [], skillKey: 'event-skill' } as BeforePromptBuildEvent & {
        skillKey: string;
      },
      { sessionId: 'session-skill-resolution', skillKey: 'my-skill' } as PluginHookAgentContext & {
        skillKey: string;
      }
    );

    expect(beforeSpy).toHaveBeenCalledWith('session-skill-resolution', 'my-skill', 'BASE_PROMPT');
  });

  it('after_tool_call maps event fields correctly', async () => {
    const afterSpy = vi.spyOn(SkillEvolutionPlugin.prototype, 'after_tool_call').mockResolvedValue();
    const api = new MockOpenClawApi({});
    register(api);

    const afterToolCall = getHook(api, 'after_tool_call');
    await afterToolCall(
      { toolName: 'build', params: {}, error: 'Error: unresolved symbol' },
      { sessionId: 'session-after-tool', toolName: 'build' } as PluginHookToolContext
    );

    expect(afterSpy).toHaveBeenCalledWith('session-after-tool', 'build', 'Error: unresolved symbol', true, undefined);
  });

  it('message_received maps event fields correctly', async () => {
    const messageSpy = vi.spyOn(SkillEvolutionPlugin.prototype, 'message_received').mockResolvedValue();
    const api = new MockOpenClawApi({});
    register(api);

    const messageReceived = getHook(api, 'message_received');
    await messageReceived(
      { from: 'user', content: 'you should have done this instead' },
      { channelId: 'session-message' } as PluginHookMessageContext
    );

    expect(messageSpy).toHaveBeenCalledWith('session-message', 'you should have done this instead');
  });

  it('agent_end calls plugin.agent_end and does not perform session cleanup', async () => {
    const api = new MockOpenClawApi({
      review: {
        minEvidenceCount: 999
      }
    });
    register(api);

    const beforePromptBuild = getHook(api, 'before_prompt_build');
    const afterToolCall = getHook(api, 'after_tool_call');
    const agentEnd = getHook(api, 'agent_end');
    const sessionEnd = getHook(api, 'session_end');
    const sessionId = 'session-end';

    await beforePromptBuild(
      { prompt: 'BASE_PROMPT', messages: [] },
      { sessionId, skillKey: 'adapter.skill.cleanup', workspaceDir: tempRoot } as PluginHookAgentContext & { skillKey: string }
    );

    await afterToolCall(
      { toolName: 'test', params: {}, error: 'Error: first failure' },
      { sessionId, toolName: 'test' } as PluginHookToolContext
    );

    const withOverlay = await beforePromptBuild(
      { prompt: 'BASE_PROMPT', messages: [] },
      { sessionId }
    );
    expect(withOverlay?.prependSystemContext).toContain('--- SKILL OVERLAY (session-local) ---');

    const agentEndSpy = vi.spyOn(SkillEvolutionPlugin.prototype, 'agent_end');
    await agentEnd({ messages: [], success: true }, { sessionId });
    expect(agentEndSpy).toHaveBeenCalledWith(sessionId);

    const afterAgentEnd = await beforePromptBuild(
      { prompt: 'BASE_PROMPT', messages: [] },
      { sessionId }
    );
    expect(afterAgentEnd?.prependSystemContext).toContain('--- SKILL OVERLAY (session-local) ---');

    await sessionEnd({ sessionId, reason: 'explicit' }, { sessionId });

    const afterSessionEnd = await beforePromptBuild(
      { prompt: 'BASE_PROMPT', messages: [] },
      { sessionId }
    );
    expect(afterSessionEnd).toBeUndefined();
  });

  it('session_end runs review pipeline even when ctx has no workspaceDir', async () => {
    // Regression test: register() now resolves workspace from process.cwd()
    // at startup, so session_end does NOT require ctx.workspaceDir to run.
    const api = new MockOpenClawApi({
      review: {
        minEvidenceCount: 999 // skip actual review, just verify the hook runs
      }
    });
    register(api);

    const afterToolCall = getHook(api, 'after_tool_call');
    const sessionEnd = getHook(api, 'session_end');
    const sessionId = 'session-no-ctx-workspace';

    // Feed a tool error so there is session data
    await afterToolCall(
      { toolName: 'build', params: {}, error: 'Error: compile failed' },
      { sessionId, toolName: 'build' } as PluginHookToolContext
    );

    // session_end with NO workspaceDir in context — should NOT skip
    const sessionEndSpy = vi.spyOn(SkillEvolutionPlugin.prototype, 'session_end');
    await sessionEnd({ sessionId, reason: 'explicit' }, { sessionId });
    expect(sessionEndSpy).toHaveBeenCalledWith(sessionId);
    // The key assertion: it should not have skipped early.
    // If it had skipped, the session would still have data (not cleaned up).
  });

  it('session_end calls plugin.session_end and performs cleanup', async () => {
    const api = new MockOpenClawApi({
      review: {
        minEvidenceCount: 999
      }
    });
    register(api);

    const beforePromptBuild = getHook(api, 'before_prompt_build');
    const afterToolCall = getHook(api, 'after_tool_call');
    const sessionEnd = getHook(api, 'session_end');
    const sessionId = 'session-cleanup-only';

    await beforePromptBuild(
      { prompt: 'BASE_PROMPT', messages: [] },
      { sessionId, skillKey: 'adapter.skill.cleanup', workspaceDir: tempRoot } as PluginHookAgentContext & { skillKey: string }
    );

    await afterToolCall(
      { toolName: 'test', params: {}, error: 'Error: first failure' },
      { sessionId, toolName: 'test' } as PluginHookToolContext
    );

    const withOverlay = await beforePromptBuild(
      { prompt: 'BASE_PROMPT', messages: [] },
      { sessionId }
    );
    expect(withOverlay?.prependSystemContext).toContain('--- SKILL OVERLAY (session-local) ---');

    const sessionEndSpy = vi.spyOn(SkillEvolutionPlugin.prototype, 'session_end');
    await sessionEnd({ sessionId, reason: 'explicit' }, { sessionId });
    expect(sessionEndSpy).toHaveBeenCalledWith(sessionId);

    const afterCleanup = await beforePromptBuild(
      { prompt: 'BASE_PROMPT', messages: [] },
      { sessionId }
    );
    expect(afterCleanup).toBeUndefined();
  });
});
