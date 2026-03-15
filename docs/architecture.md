# OpenClaw Skill Evolution Plugin - Runtime Architecture

This document defines the runtime architecture, module boundaries, data flows, and interface contracts for the OpenClaw Skill Evolution Plugin. 

## 1. Module Diagram

The system is designed with strictly one-directional dependencies to prevent circular imports and ensure clear responsibility boundaries. Session-local overlays are strictly ephemeral and isolated from the global shared `SKILL.md` state until formal review and merge.

```text
┌─────────────────────────────────────────────────────────┐
│                     OpenClaw Core                       │
└────┬──────────────────────┬───────────────────────┬─────┘
     │ Hooks                │ Tool/Msg context      │ Agent lifecycle
     ▼                      ▼                       ▼
┌───────────────┐     ┌────────────────┐      ┌───────────────┐
│ OverlayInjector│◄────┤ Plugin Hooks   ├─────►│FeedbackCollector│
└──────┬────────┘     └────────────────┘      └───────┬───────┘
       │                      │                       │
       │                      ▼                       ▼
       │               ┌────────────────┐      ┌───────────────┐
       └──────────────►│  OverlayStore  │◄─────┤FeedbackClassif.│
                       └──────┬─────────┘      └───────────────┘
                              │
                              ▼
                       ┌────────────────┐
                       │  ReviewRunner  │
                       └──────┬─────────┘
                              │
                              ▼
                       ┌────────────────┐
                       │ PatchGenerator │
                       └──────┬─────────┘
                              │
                              ▼
                       ┌────────────────┐
                       │  MergeManager  │
                       └──────┬─────────┘
                              │
                              ▼
                       ┌────────────────┐
                       │ RollbackManager│
                       └────────────────┘
```

**Dependency Rules:**
1. Hooks depend on Injector, Collector, and Store.
2. Injector depends on Store.
3. Collector depends on Classifier.
4. ReviewRunner depends on Store and Collector (to summarize the session). Collector persists events to `.skill-feedback/` on disk.
5. PatchGenerator depends on ReviewRunner output.
6. MergeManager depends on PatchGenerator output.
7. RollbackManager operates independently but is invoked by MergeManager or CLI.

## 2. Data Flow

The lifecycle of skill evolution follows a strict 5-step workflow:

1. **Session Start & Context Injection**:
   - Hook `before_prompt_build` triggers.
   - `OverlayInjector` queries `OverlayStore` for existing active overlays for the current session/skill.
   - Temporary skill adjustments are injected into the agent's system prompt.
2. **Feedback Collection**:
   - Hooks `after_tool_call` and `message_received` trigger.
   - `FeedbackCollector` captures errors, corrections, and successes.
   - `FeedbackClassifier` evaluates severity and categorizes the event.
3. **Feedback Persistence**:
   - Events are persisted to `.skill-feedback/<sessionId>.jsonl` as JSONL. This survives gateway restarts.
4. **Overlay Generation (Session-Local)**:
   - If feedback dictates a tactical adjustment, an overlay is generated and saved to `OverlayStore`.
   - **Invariant:** The global `SKILL.md` is NOT modified.
4. **Session-End Review**:
   - `agent_end` fires per-turn: logs run-level stats only (duration, event count). Does NOT trigger review or clear session state.
   - `session_end` fires once at session end: aggregates all session feedback and overlays, triggers ReviewRunner, PatchGenerator, MergeManager, and clears overlays/session state.
5. **Merge & Rollback**:
   - `MergeManager` evaluates the patch against the merge policy (`requireHumanMerge`).
   - If auto-merge is permitted, `RollbackManager` creates a backup.
   - The patch is applied to the global `SKILL.md`. Rollbacks are capped at 5 versions.

## 3. State Machine

The plugin operates on a session-scoped state machine, handling normal flows and error states gracefully.

| Current State    | Trigger Event              | Next State       | Actions / Handlers |
|------------------|----------------------------|------------------|--------------------|
| `INIT`           | Session starts             | `COLLECTING`     | Load existing overlays into context. |
| `COLLECTING`     | Significant feedback event | `OVERLAY_ACTIVE` | Classify event, generate & store local overlay. |
| `OVERLAY_ACTIVE` | Agent requires prompt      | `OVERLAY_ACTIVE` | Inject overlay into prompt. Continue collecting. |
| `COLLECTING` / `OVERLAY_ACTIVE` | `agent_end`                | `COLLECTING` / `OVERLAY_ACTIVE` | Logs run-level stats only. No state transition. |
| `COLLECTING` / `OVERLAY_ACTIVE` | `session_end`              | `REVIEWING`      | Aggregate feedback and overlays; begin review. |
| `REVIEWING`      | Review completes           | `MERGING`        | Generate patch from review. |
| `REVIEWING`      | Review fails               | `ERROR`          | Throw `ReviewFailedError`, log state. |
| `MERGING`        | Merge policy allows        | `CLOSED`         | Create backup, apply patch to `SKILL.md`. |
| `MERGING`        | `requireHumanMerge=true`   | `CLOSED`         | Queue patch for human review. Do not apply. |
| `MERGING`        | Merge conflict             | `ERROR`          | Throw `MergeConflictError`, log state. |
| `ERROR`          | Recovery triggered         | `ROLLBACK`       | Revert to last known good state if modified. |
| `ROLLBACK`       | Rollback completes         | `CLOSED`         | Restore previous version, drop invalid patch. |

## 4. Interface Definitions

### Base Types & Configuration

```typescript
/** Configuration schema matching the expected YAML definition. */
export interface SkillEvolutionConfig {
  enabled: boolean;
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
  };
  review: {
    minEvidenceCount: number;
    allowAutoMergeOnLowRiskOnly: boolean;
  };
}

/** Represents a single feedback signal collected during the session. */
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

/** Metadata for a generated skill patch. */
export interface PatchMetadata {
  skillKey: string;
  patchId: string;
  baseVersion: string;
  sourceSessionId: string;
  mergeMode: 'auto' | 'manual';
  riskLevel: 'low' | 'medium' | 'high';
  rollbackChainDepth: number;
}

/** Represents a temporary session-local skill modification. */
export interface OverlayEntry {
  sessionId: string;
  skillKey: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  reasoning: string;
}

/** Summary of all feedback and overlays for a session. */
export interface SessionSummary {
  sessionId: string;
  skillKey: string;
  events: FeedbackEvent[];
  overlays: OverlayEntry[];
  durationMs: number;
  totalErrors: number;
}

/** The output from the ReviewRunner. */
export interface ReviewResult {
  isModificationRecommended: boolean;
  justification: string;
  proposedDiff: string;
  riskLevel: 'low' | 'medium' | 'high';
  metadata: PatchMetadata;
}

/** Represents a backed-up version of a skill. */
export interface SkillVersion {
  skillKey: string;
  versionId: string;
  timestamp: number;
  content: string;
  restoredFrom?: string;
}
```

### Module Boundaries

```typescript
/** 
 * Entry points for OpenClaw core to interact with the plugin.
 */
export interface PluginHooks {
  /**
   * Called before building the system prompt. Injects session overlays.
   * @param sessionId The current session ID.
   * @param skillKey The active skill identifier.
   * @param currentPrompt The base prompt string.
   * @returns A modified prompt containing overlay context.
   */
  before_prompt_build(sessionId: string, skillKey: string, currentPrompt: string): Promise<string>;

  /**
   * Called after a tool executes to collect potential error or success feedback.
   * @param sessionId The current session ID.
   * @param toolName The name of the tool executed.
   * @param output The raw output or error string.
   * @param isError Whether the tool execution threw an error.
   * @param rawResult The raw result object from the tool execution.
   */
  after_tool_call(sessionId: string, toolName: string, output: string, isError: boolean, rawResult?: unknown): Promise<void>;

  /**
   * Called when a user message is received to detect corrections or clarifications.
   * @param sessionId The current session ID.
   * @param message The text content of the user message.
   */
  message_received(sessionId: string, message: string): Promise<void>;

  /**
   * Logs run-level statistics. Does NOT trigger review.
   * @param sessionId The current session ID.
   */
  agent_end(sessionId: string): Promise<void>;

  /**
   * Triggers the review and patch generation workflow when the session terminates.
   * @param sessionId The current session ID.
   */
  session_end(sessionId: string): Promise<void>;
}

/** 
 * Manages session-scoped ephemeral skill modifications.
 * Storage path convention: `.skill-overlays/<session-id>/<skill-key>.md`
 */
export interface OverlayStore {
  /** Creates or overwrites an overlay for a session/skill. */
  create(entry: OverlayEntry): Promise<void>;
  
  /** Reads the current overlay if it exists. */
  read(sessionId: string, skillKey: string): Promise<OverlayEntry | null>;
  
  /** Updates an existing overlay. Throws OverlayNotFoundError if missing. */
  update(sessionId: string, skillKey: string, partial: Partial<OverlayEntry>): Promise<void>;
  
  /** Deletes an overlay explicitly. */
  delete(sessionId: string, skillKey: string): Promise<void>;
  
  /** Lists all overlays active for a particular session. */
  listBySession(sessionId: string): Promise<OverlayEntry[]>;
  
  /** Clears all overlays associated with a session (used during cleanup). */
  clearSession(sessionId: string): Promise<void>;
}

/** 
 * Responsible for formatting and injecting overlays into prompts.
 */
export interface OverlayInjector {
  /** Formats and prepends/appends the overlay text based on configuration. */
  inject(baseContext: string, overlay: OverlayEntry): string;
}

/**
 * Collects and manages feedback signals during a session.
 * Persists feedback events to JSONL files on disk.
 */
export interface FeedbackCollector {
  /** Stores a new feedback event. */
  collect(event: FeedbackEvent): Promise<void>;
  
  /** Retrieves all feedback events for a specific session. */
  getSessionFeedback(sessionId: string): Promise<FeedbackEvent[]>;
}

/**
 * Analyzes raw events to classify their type and severity.
 */
export interface FeedbackClassifier {
  /** Evaluates a raw input and generates a structured feedback classification. */
  classify(rawInput: string, isError: boolean): FeedbackEvent['eventType'] | null;
  
  /** Determines the severity level based on repetition and content. */
  assessSeverity(events: FeedbackEvent[]): FeedbackEvent['severity'];
}

/**
 * Reviews session activity using an LLM to determine if a skill should evolve.
 */
export interface ReviewRunner {
  /** Analyzes the session summary and proposes global modifications. */
  runReview(summary: SessionSummary): Promise<ReviewResult>;
}

/**
 * Converts abstract review recommendations into concrete file diffs/patches.
 */
export interface PatchGenerator {
  /** Generates a standard patch/diff string based on review output. */
  generate(result: ReviewResult, originalContent: string): string;
}

/**
 * Applies patches to the global shared SKILL.md state enforcing merge policies.
 */
export interface MergeManager {
  /** 
   * Attempts to merge a patch. 
   * If `requireHumanMerge` is true, queues the patch instead of applying.
   */
  merge(skillKey: string, patchContent: string, metadata: PatchMetadata): Promise<boolean>;
  
  /** Checks if the current configuration allows auto-merging this specific patch. */
  checkMergePolicy(metadata: PatchMetadata): boolean;
}

/**
 * Maintains a capped chain of historical skill versions for safety.
 * Storage path convention: `.skill-backups/<skill-key>/<version-id>.md`
 */
export interface RollbackManager {
  /** Creates a snapshot of the current skill content before modification. */
  backup(skillKey: string, content: string): Promise<SkillVersion>;
  
  /** Restores a specific version of a skill. */
  restore(skillKey: string, versionId: string): Promise<void>;
  
  /** Lists available backup versions for a skill, ordered newest to oldest. */
  listVersions(skillKey: string): Promise<SkillVersion[]>;
  
  /** Ensures the rollback chain does not exceed `maxRollbackVersions` (default 5). */
  pruneOldVersions(skillKey: string): Promise<void>;
}
```

## 5. Error Handling Strategy

The system uses domain-specific Error extensions to ensure failure modes are precisely handled and never swallowed silently. All modules are required to log structured details on failure.

| Error Type | Trigger Condition | Recovery Behavior |
|------------|-------------------|-------------------|
| `MergeConflictError` | The generated patch cannot be cleanly applied to the current `SKILL.md` (e.g., skill changed mid-session). | Abort merge, log diff, keep original file intact. Delegate to human review. |
| `RollbackLimitExceeded` | The `maxRollbackVersions` configuration is invalid (e.g., negative). | Fallback to default (5), log warning, continue. |
| `OverlayNotFoundError` | An attempt was made to update/inject an overlay that does not exist. | Treat as no-op. Return base context. Log at debug level. |
| `ReviewFailedError` | The review subagent failed to produce a valid `ReviewResult` (e.g., LLM parsing error). | Abort the review pipeline. Do not generate patch. The session overlays remain unmerged. |
| `InvalidConfigError` | The YAML configuration violates the schema. | Halt initialization. Plugin disables itself until config is corrected. |

## 6. File-to-Module Mapping

This table maps the repository structure to the interfaces defined in this architecture document.

| Source File | Interfaces / Responsibilities Implemented |
|-------------|-------------------------------------------|
| `src/openclaw.ts` | OpenClaw adapter: unified `resolveSessionId()`, runtime workspace capture via `captureWorkspaceDir()` |
| `src/plugin/index.ts` | Plugin lifecycle orchestration, `ensureWorkspaceDir()` late binding |
| `src/plugin/hooks/agent_end.ts` | Run-level stats logging (no review, no cleanup) |
| `src/plugin/hooks/session_end.ts` | Full review→patch→merge→cleanup pipeline |
| `src/plugin/overlay/overlay_store.ts` | `OverlayStore` |
| `src/plugin/overlay/overlay_injector.ts` | `OverlayInjector` |
| `src/plugin/feedback/collector.ts` | `FeedbackCollector` |
| `src/plugin/feedback/classifiers.ts` | `FeedbackClassifier` (English + Chinese patterns) |
| `src/plugin/config.ts` | `SkillEvolutionConfig` |
| `src/review/review_runner.ts` | `ReviewRunner` (deterministic fallback: considers errors + corrections + overlays) |
| `src/review/llm_review_runner.ts` | `LLMReviewRunner` (primary: LLM-based review with overlay fallback) |
| `src/review/llm_runtime_resolver.ts` | `LlmRuntimeResolver` (env → openclaw.json → error provider resolution) |
| `src/review/patch_generator.ts` | `PatchGenerator` |
| `src/review/merge_manager.ts` | `MergeManager` |
| `src/review/rollback_manager.ts` | `RollbackManager` |
| `src/shared/types.ts` | `FeedbackEvent`, `PatchMetadata`, `OverlayEntry`, etc. |
| `src/shared/paths.ts` | Unified workspace-relative path resolution (optional `skillsDir` override) |

## 7. Session ID Resolution Contract

All hooks use a unified `resolveSessionId()` function (defined in `src/openclaw.ts`) to derive the session identifier from OpenClaw hook context objects. This ensures that feedback, overlays, and review data are consistently keyed to the same session regardless of which context fields OpenClaw provides.

**Priority chain** (first non-empty string wins):
1. `ctx.sessionId`
2. `ctx.sessionKey`
3. `ctx.conversationId`
4. `ctx.channelId`
5. `'unknown-session'` (fallback)

This resolution is applied identically to all five hooks (`before_prompt_build`, `after_tool_call`, `message_received`, `agent_end`, `session_end`). No hook uses a different strategy.

## 8. Workspace Late-Binding

The plugin does **not** read `workspaceDir` from the plugin config schema. Instead, workspace directory is resolved at runtime from OpenClaw hook context:

1. **Initialization**: Plugin starts with `process.cwd()` as the workspace directory.
2. **First hook invocation**: `captureWorkspaceDir()` checks each hook context for `ctx.workspaceDir`. If present, it calls `plugin.ensureWorkspaceDir(workspaceDir)`.
3. **Binding**: `ensureWorkspaceDir()` is idempotent — once bound, subsequent calls are no-ops. On first bind, it reconstructs all path-dependent modules (`OverlayStore`, `FeedbackCollector`, `RollbackManager`, `MergeManager`) with workspace-relative paths.
4. **Rationale**: OpenClaw determines the actual workspace at runtime; hardcoding it in config would create a mismatch when the plugin is used across different projects.

## 9. Feedback Classification & Severity

### Classification
`FeedbackClassifierImpl` uses regex-based pattern matching for both English and Chinese:

| Event Type | English Patterns | Chinese Patterns |
|------------|-----------------|-----------------|
| `user_correction` | `don't`, `wrong`, `incorrect`, `instead`, `not that`, `should have`, `fix this` | `不对`, `错了`, `应该`, `改成`, `不是这个`, `上一句有问题`, `你这里理解错了` |
| `positive_feedback` | `good`, `great`, `perfect`, `thanks`, `correct`, `nice` | `这样可以`, `对的`, `很好`, `没问题`, `谢谢`, `这个版本可以` |
| `tool_error` | N/A (determined by `isError` flag + structural checks + string heuristic) | N/A |

### Tool Error Detection (String Heuristic)
In addition to the `isError` flag and structured `rawResult` checks, `after_tool_call` also applies a string-based heuristic on the output text: `/\b(error|failed|unauthorized|timeout|missing api key)\b/i`.

### Severity Assessment
Severity counts **both** `tool_error` and `user_correction` events:

| Condition | Severity |
|-----------|----------|
| 0 errors + 0 corrections | `low` |
| ≥2 corrections OR ≥3 errors | `high` |
| All other combinations (≥1 signal) | `medium` |
