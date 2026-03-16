/**
 * Shared domain types and module interfaces for the skill evolution plugin.
 */

export interface SkillEvolutionConfig {
  enabled: boolean;
  workspaceDir?: string;
  merge: {
    requireHumanMerge: boolean;
    maxRollbackVersions: number;
  };
  sessionOverlay: {
    enabled: boolean;
    storageDir: string;
    injectMode: 'system-context' | 'tool-description';
    clearOnSessionEnd: boolean;
  };
  triggers: {
    onToolError: boolean;
    onUserCorrection: boolean;
    onSessionEndReview: boolean;
    onPositiveFeedback: boolean;
  };
  llm: {
    inheritPrimaryConfig: boolean;
    modelOverride: string | null;
    thinkingOverride: boolean | null;
    provider: string | null;
  };
  review: {
    minEvidenceCount: number;
    allowAutoMergeOnLowRiskOnly: boolean;
  };

  // === v2 basic fields ===
  reviewMode?: 'off' | 'queue-only' | 'assisted' | 'auto-low-risk';
  notify?: {
    enabled: boolean;
    mode: 'off' | 'per-session' | 'digest';
    channel: string;
  };

  // === v2 advanced fields ===
  agents?: {
    review: {
      enabled: boolean;
      agentId: string;
      spawnMode: 'run' | 'session';
      thread: boolean;
      model: string | null;
      thinking: string | null;
      runTimeoutSeconds: number;
    };
    notify: {
      enabled: boolean;
      agentId: string;
      spawnMode: 'run' | 'session';
      thread: boolean;
      model: string | null;
      thinking: string | null;
    };
  };
  queue?: {
    storageDir: string;
    metadataFile: string;
    dedupeWindowMinutes: number;
    maxPendingPerSkill: number;
  };
  notifications?: {
    debounceSeconds: number;
    digestCron: string;
    minRiskToInterrupt: RiskLevel;
  };
  risk?: {
    autoApplyMaxRisk: RiskLevel;
    notifyMinRisk: RiskLevel;
  };
}

export interface FeedbackEvent {
  sessionId: string;
  skillKey: string;
  timestamp: number;
  eventType: 'tool_error' | 'user_correction' | 'positive_feedback' | 'retry_pattern';
  severity: 'low' | 'medium' | 'high';
  toolName?: string;
  messageExcerpt?: string;
  proposedOverlay?: string;
}

export interface PatchMetadata {
  skillKey: string;
  patchId: string;
  baseVersion: string;
  sourceSessionId: string;
  mergeMode: 'auto' | 'manual';
  riskLevel: 'low' | 'medium' | 'high';
  rollbackChainDepth: number;
}

// ── Patch State Machine (v2) ─────────────────────────────────────

export type PatchStatus =
  | 'queued'
  | 'reviewing'
  | 'ready'
  | 'notified'
  | 'approved'
  | 'rejected'
  | 'applied'
  | 'superseded'
  | 'failed';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface PatchCandidate {
  id: string;
  skillKey: string;
  status: PatchStatus;
  risk: RiskLevel;
  sourceSessionIds: string[];
  createdAt: string;
  updatedAt: string;
  summary: string;
  justification: string;
  proposedDiff: string;
  originalContent: string;
  supersedes?: string[];
  supersededBy?: string;
  proposalPath?: string;
  artifactVersion?: number;
  reviewOutput?: ReviewProposal;
}

export interface ReviewProposal {
  reviewedAt: string;
  reviewerAgentId?: string;
  riskAssessment: RiskLevel;
  suggestedAction: 'apply' | 'reject' | 'revise';
  rationale: string;
  revisedDiff?: string;
}

export interface PatchQueueIndex {
  version: 1;
  updatedAt: string;
  patches: PatchIndexEntry[];
}

export interface PatchIndexEntry {
  id: string;
  skillKey: string;
  status: PatchStatus;
  risk: RiskLevel;
  createdAt: string;
  updatedAt: string;
  summary: string;
}

export interface OverlayEntry {
  sessionId: string;
  skillKey: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  reasoning: string;
}

export interface SessionSummary {
  sessionId: string;
  skillKey: string;
  events: FeedbackEvent[];
  overlays: OverlayEntry[];
  durationMs: number;
  totalErrors: number;
}

export interface ReviewResult {
  isModificationRecommended: boolean;
  justification: string;
  proposedDiff: string;
  riskLevel: 'low' | 'medium' | 'high';
  metadata: PatchMetadata;
}

export interface SkillVersion {
  skillKey: string;
  versionId: string;
  timestamp: number;
  content: string;
  restoredFrom?: string;
}

export interface OverlayStore {
  create(entry: OverlayEntry): Promise<void>;
  read(sessionId: string, skillKey: string): Promise<OverlayEntry | null>;
  update(sessionId: string, skillKey: string, partial: Partial<OverlayEntry>): Promise<void>;
  delete(sessionId: string, skillKey: string): Promise<void>;
  listBySession(sessionId: string): Promise<OverlayEntry[]>;
  clearSession(sessionId: string): Promise<void>;
}

export interface OverlayInjector {
  inject(baseContext: string, overlay: OverlayEntry): string;
}

export interface FeedbackCollector {
  collect(event: FeedbackEvent): Promise<void>;
  getSessionFeedback(sessionId: string): Promise<FeedbackEvent[]>;
}

export interface FeedbackClassifier {
  classify(rawInput: string, isError: boolean): FeedbackEvent['eventType'] | null;
  assessSeverity(events: FeedbackEvent[]): FeedbackEvent['severity'];
}

export interface ReviewRunner {
  runReview(summary: SessionSummary): Promise<ReviewResult>;
  paths?: ResolvedPaths | null;
}

/**
 * ReviewRunner that can be refreshed when workspace binding changes.
 * Clears stale caches and accepts a new LlmResolver instance.
 */
export interface RefreshableReviewRunner extends ReviewRunner {
  refreshRuntimeContext(ctx: {
    paths: ResolvedPaths;
    llmRuntimeResolver?: LlmResolver | null;
  }): void;
}

/**
 * Resolves LLM provider configuration from available sources.
 */
export interface LlmResolver {
  resolve(model: string, explicitProvider?: string | null): ResolvedProvider;
}

/**
 * Parsed provider map from openclaw.json file.
 * Used internally by the resolver for file-based fallback.
 */
export interface ParsedProvidersConfig {
  providers?: Record<string, {
    baseUrl: string;
    apiKey: string;
    api?: string;
  }>;
}

/**
 * Resolved LLM provider details with provenance tracking.
 */
export interface ResolvedProvider {
  baseUrl: string;
  apiKey: string;
  api: 'openai' | 'anthropic-messages';
  modelId: string;
  resolvedFrom: 'env' | 'openclaw-config';
}

export interface PatchGenerator {
  generate(result: ReviewResult, originalContent: string): string;
}

export interface PatchCandidateGenerator {
  generateCandidate(
    result: ReviewResult,
    originalContent: string,
    sessionIds: string[]
  ): PatchCandidate;
}

export interface PatchQueue {
  create(candidate: PatchCandidate): Promise<PatchCandidate>;
  get(patchId: string): Promise<PatchCandidate>;
  update(patchId: string, updates: Partial<PatchCandidate>): Promise<PatchCandidate>;
  transition(patchId: string, newStatus: PatchStatus): Promise<PatchCandidate>;
  list(filter?: { skillKey?: string; status?: PatchStatus; limit?: number }): Promise<PatchIndexEntry[]>;
  supersede(oldPatchId: string, newPatchId: string): Promise<void>;
  getIndex(): Promise<PatchQueueIndex>;
}

export interface MergeManager {
  merge(skillKey: string, patchContent: string, metadata: PatchMetadata): Promise<boolean>;
  checkMergePolicy(metadata: PatchMetadata): boolean;
  applyPatch(candidate: PatchCandidate): Promise<PatchCandidate>;
  rejectPatch(candidate: PatchCandidate, reason?: string): Promise<PatchCandidate>;
}

export interface RollbackManager {
  backup(skillKey: string, content: string): Promise<SkillVersion>;
  restore(skillKey: string, versionId: string): Promise<void>;
  listVersions(skillKey: string): Promise<SkillVersion[]>;
  pruneOldVersions(skillKey: string): Promise<void>;
}

export interface PluginHooks {
  before_prompt_build(sessionId: string, skillKey: string, currentPrompt: string): Promise<string>;
  after_tool_call(
    sessionId: string,
    toolName: string,
    output: string,
    isError: boolean,
    rawResult?: unknown
  ): Promise<void>;
  message_received(sessionId: string, message: string): Promise<void>;
  agent_end(sessionId: string): Promise<void>;
  session_end(sessionId: string): Promise<void>;
}

export interface SkillEvolutionConfigFile {
  skillEvolution: SkillEvolutionConfig;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type UnknownRecord = Record<string, unknown>;

export interface Logger {
  debug(message: string, context?: UnknownRecord): void;
  info(message: string, context?: UnknownRecord): void;
  warn(message: string, context?: UnknownRecord): void;
  error(message: string, context?: UnknownRecord): void;
}

export interface ResolvedPaths {
  workspaceDir: string;
  overlaysDir: string;
  patchesDir: string;
  backupsDir: string;
  skillsDir: string;
  feedbackDir: string;
}

// ── OpenClaw Plugin API Types ──────────────────────────────────────

export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

/** The API object passed to the plugin's register function by OpenClaw. */
export interface OpenClawPluginApi {
  id: string;
  name: string;
  pluginConfig?: Record<string, unknown>;
  logger: unknown;
  on<K extends PluginHookName>(hookName: K, handler: PluginHookHandlerMap[K], opts?: HookOptions): void;
  registerTool?(tool: AgentToolDefinition): void;
}

export type PluginHookName =
  | 'before_prompt_build'
  | 'after_tool_call'
  | 'message_received'
  | 'agent_end'
  | 'session_end';

export interface HookOptions {
  priority?: number;
}

export interface PluginHookAgentContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
}

export interface PluginHookToolContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
}

export interface PluginHookMessageContext {
  channelId: string;
  accountId?: string;
  conversationId?: string;
}

export interface BeforePromptBuildEvent {
  prompt: string;
  messages: unknown[];
}

export interface BeforePromptBuildResult {
  prependSystemContext?: string;
  appendSystemContext?: string;
  systemPrompt?: string;
  prependContext?: string;
}

export type BeforePromptBuildHandler = (
  event: BeforePromptBuildEvent,
  ctx: PluginHookAgentContext
) => BeforePromptBuildResult | undefined | Promise<BeforePromptBuildResult | undefined>;

export interface AfterToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export type AfterToolCallHandler = (
  event: AfterToolCallEvent,
  ctx: PluginHookToolContext
) => void | Promise<void>;

export interface MessageReceivedEvent {
  from: string;
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export type MessageReceivedHandler = (
  event: MessageReceivedEvent,
  ctx: PluginHookMessageContext
) => void | Promise<void>;

export interface AgentEndEvent {
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
}

export type AgentEndHandler = (
  event: AgentEndEvent,
  ctx: PluginHookAgentContext
) => void | Promise<void>;

export interface SessionEndEvent {
  sessionId?: string;
  reason?: 'user_reset' | 'timeout' | 'shutdown' | 'explicit';
  durationMs?: number;
}

export type SessionEndHandler = (
  event: SessionEndEvent,
  ctx: PluginHookAgentContext
) => void | Promise<void>;

export type PluginHookHandlerMap = {
  before_prompt_build: BeforePromptBuildHandler;
  after_tool_call: AfterToolCallHandler;
  message_received: MessageReceivedHandler;
  agent_end: AgentEndHandler;
  session_end: SessionEndHandler;
};
