import type {
  AgentEndEvent,
  AfterToolCallEvent,
  BeforePromptBuildEvent,
  BeforePromptBuildResult,
  MessageReceivedEvent,
  OpenClawPluginApi,
  PluginHookAgentContext,
  PluginHookMessageContext,
  PluginHookToolContext,
  SessionEndEvent,
  SkillEvolutionConfig
} from './shared/types.js';
import { fromOpenClawPluginConfig } from './plugin/config.js';
import { SkillEvolutionPlugin } from './plugin/index.js';
import { ConsoleLogger } from './shared/logger.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';

const HOOK_PRIORITY = 50;

/**
 * Resolves workspace directory from available sources at plugin startup.
 * Priority: config.workspaceDir → OPENCLAW_WORKSPACE env → agents.defaults.workspace from openclaw.json → process.cwd()
 */
function resolveInitialWorkspaceDir(config: SkillEvolutionConfig | undefined, logger: ConsoleLogger): { dir: string; isFallback: boolean } {
  // 1. Explicit config (set in openclaw.json plugins.entries.skill-evolution.config.workspaceDir)
  if (config?.workspaceDir) {
    logger.debug('Workspace resolved from plugin config', { workspaceDir: config.workspaceDir });
    return { dir: config.workspaceDir, isFallback: false };
  }

  // 2. Environment variable
  const envWorkspace = process.env.OPENCLAW_WORKSPACE;
  if (typeof envWorkspace === 'string' && envWorkspace.length > 0) {
    logger.debug('Workspace resolved from OPENCLAW_WORKSPACE env', { workspaceDir: envWorkspace });
    return { dir: envWorkspace, isFallback: false };
  }

  // 3. Read agents.defaults.workspace from openclaw.json (same file the LLM resolver uses)
  const stateDir = process.env.OPENCLAW_STATE_DIR ?? join(homedir(), '.openclaw');
  const openclawConfigPath = join(stateDir, 'openclaw.json');
  try {
    if (existsSync(openclawConfigPath)) {
      const raw = JSON.parse(readFileSync(openclawConfigPath, 'utf8')) as Record<string, unknown>;
      const agents = raw?.agents as Record<string, unknown> | undefined;
      const defaults = agents?.defaults as Record<string, unknown> | undefined;
      const workspace = defaults?.workspace;
      if (typeof workspace === 'string' && workspace.length > 0) {
        logger.debug('Workspace resolved from openclaw.json agents.defaults.workspace', {
          workspaceDir: workspace,
          configPath: openclawConfigPath
        });
        return { dir: workspace, isFallback: false };
      }
    }
  } catch {
    // Ignore read/parse errors — fall through to cwd()
  }

  // 4. Fallback to cwd
  logger.debug('Workspace falling back to process.cwd()', { cwd: process.cwd() });
  return { dir: process.cwd(), isFallback: true };
}

/**
 * Resolves session ID from any hook context type with a consistent priority chain.
 * Priority: sessionId → sessionKey → conversationId → channelId → 'unknown-session'
 */
function resolveSessionId(ctx: Record<string, unknown>): string {
  if (typeof ctx.sessionId === 'string' && ctx.sessionId) return ctx.sessionId;
  if (typeof ctx.sessionKey === 'string' && ctx.sessionKey) return ctx.sessionKey;
  if (typeof ctx.conversationId === 'string' && ctx.conversationId) return ctx.conversationId;
  if (typeof ctx.channelId === 'string' && ctx.channelId) return ctx.channelId;
  return 'unknown-session';
}

/**
 * Captures workspace directory from hook context if available.
 * Used to bind the plugin to the real workspace on first hook invocation.
 */
function captureWorkspaceDir(plugin: SkillEvolutionPlugin, ctx: Record<string, unknown>): void {
  if (typeof ctx.workspaceDir === 'string' && ctx.workspaceDir) {
    plugin.logger.debug('captureWorkspaceDir called', { 
      workspaceDir: ctx.workspaceDir, 
      cwd: process.cwd()
    });
    plugin.ensureWorkspaceDir(ctx.workspaceDir);
  } else {
    plugin.logger.debug('captureWorkspaceDir called but no workspaceDir in context', { 
      ctxKeys: Object.keys(ctx)
    });
  }
}

/**
 * Registers the Skill Evolution plugin hooks with OpenClaw.
 */
export default function register(api: OpenClawPluginApi): void {
  const logger = new ConsoleLogger('openclaw.adapter');
  const rawConfig = api.pluginConfig;

  let config: SkillEvolutionConfig | undefined;
  try {
    config = fromOpenClawPluginConfig(rawConfig ?? {});
  } catch (err: unknown) {
    logger.warn('Failed to parse plugin config, using defaults', {
      error: err instanceof Error ? err.message : String(err)
    });
    config = undefined;
  }

  const initialWorkspace = resolveInitialWorkspaceDir(config, logger);
  const plugin = new SkillEvolutionPlugin(config, initialWorkspace.dir, initialWorkspace.isFallback);
  logger.info('Skill Evolution plugin registered', {
    enabled: plugin.config.enabled,
    workspaceBound: plugin.isWorkspaceBound(),
    workspaceDir: plugin.paths.workspaceDir,
    workspaceDirIsFallback: initialWorkspace.isFallback
  });

  if (!plugin.config.enabled) {
    logger.info('Plugin is disabled by config, skipping hook registration');
    return;
  }

  api.on(
    'before_prompt_build',
    async (
      event: BeforePromptBuildEvent,
      ctx: PluginHookAgentContext
    ): Promise<BeforePromptBuildResult | undefined> => {
      const ctxRecord = ctx as unknown as Record<string, unknown>;
      captureWorkspaceDir(plugin, ctxRecord);
      const sessionId = resolveSessionId(ctxRecord);
      const eventRecord = event as unknown as Record<string, unknown>;
      const ctxSkillKey = typeof ctxRecord.skillKey === 'string' ? ctxRecord.skillKey : undefined;
      const eventSkillKey = typeof eventRecord.skillKey === 'string' ? eventRecord.skillKey : undefined;
      const knownSkillKey = plugin.getSessionSkillKey(sessionId);
      const fallbackSkillKey = knownSkillKey === 'unknown-skill' ? 'default-skill' : knownSkillKey;
      const skillKey = ctxSkillKey ?? eventSkillKey ?? fallbackSkillKey;
      const currentPrompt = typeof event.prompt === 'string' ? event.prompt : '';

      const result = await plugin.before_prompt_build(sessionId, skillKey, currentPrompt);
      if (result === currentPrompt) {
        return undefined;
      }

      const overlayText = result.endsWith(currentPrompt)
        ? result.slice(0, result.length - currentPrompt.length)
        : result;

      return { prependSystemContext: overlayText };
    },
    { priority: HOOK_PRIORITY }
  );

  api.on(
    'after_tool_call',
    async (event: AfterToolCallEvent, ctx: PluginHookToolContext): Promise<void> => {
      const ctxRecord = ctx as unknown as Record<string, unknown>;
      captureWorkspaceDir(plugin, ctxRecord);
      const sessionId = resolveSessionId(ctxRecord);
      const toolName = event.toolName;
      const rawOutput = event.result ?? event.error ?? '';
      const output = typeof rawOutput === 'object'
        ? JSON.stringify(rawOutput)
        : String(rawOutput);
      const isError = !!event.error;

      await plugin.after_tool_call(sessionId, toolName, output, isError, event.result);
    },
    { priority: HOOK_PRIORITY }
  );

  api.on(
    'message_received',
    async (event: MessageReceivedEvent, ctx: PluginHookMessageContext): Promise<void> => {
      const ctxRecord = ctx as unknown as Record<string, unknown>;
      captureWorkspaceDir(plugin, ctxRecord);
      const sessionId = resolveSessionId(ctxRecord);
      const message = event.content;

      await plugin.message_received(sessionId, message);
    },
    { priority: HOOK_PRIORITY }
  );

  api.on(
    'agent_end',
    async (_event: AgentEndEvent, ctx: PluginHookAgentContext): Promise<void> => {
      const ctxRecord = ctx as unknown as Record<string, unknown>;
      captureWorkspaceDir(plugin, ctxRecord);
      const sessionId = resolveSessionId(ctxRecord);
      await plugin.agent_end(sessionId);
    },
    { priority: HOOK_PRIORITY }
  );

  api.on(
    'session_end',
    async (_event: SessionEndEvent, ctx: PluginHookAgentContext): Promise<void> => {
      const ctxRecord = ctx as unknown as Record<string, unknown>;
      captureWorkspaceDir(plugin, ctxRecord);
      const sessionId = resolveSessionId(ctxRecord);
      await plugin.session_end(sessionId);
    },
    { priority: HOOK_PRIORITY }
  );

  logger.info('Note: if allowPromptInjection is disabled in OpenClaw config (plugins.entries.skill-evolution.hooks.allowPromptInjection=false), overlay injection via before_prompt_build will be silently ignored by OpenClaw. The plugin will still collect feedback and run reviews, but session overlays will not appear in prompts.');
}
