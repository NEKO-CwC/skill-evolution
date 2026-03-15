# Implementation Specification: OpenClaw Skill Evolution Plugin

## Module Responsibilities

### 1. `src/plugin/hooks/` (Lifecycle Event Handling)
- **`before_prompt_build.ts`**: Injects current session overlays into the prompt.
- **`after_tool_call.ts`**: Captures tool results, errors, and performance signals.
- **`message_received.ts`**: Identifies user corrections and feedback patterns.
- **`agent_end.ts`**: Logs run-level statistics (event count, duration). Does not trigger review.
- **`session_end.ts`**: Triggers the full review→patch→merge→cleanup pipeline at session end.

### 2. `src/plugin/overlay/` (Session-Local Storage)
- **`overlay_store.ts`**: CRUD operations for session-local `.md` files in `.skill-overlays/`.
- **`overlay_injector.ts`**: Logic for merging overlays into OpenClaw's prompt structure.

### 3. `src/plugin/feedback/` (Feedback Logic)
- **`collector.ts`**: Persists feedback events to `.skill-feedback/<sessionId>.jsonl` (JSONL format) and buffers in memory for fast access.
- **`classifiers.ts`**: Logic for determining if a feedback signal warrants an overlay or permanent change.

### 4. `src/review/` (Evolution Management)
- **`review_runner.ts`**: Deterministic review fallback that generates skill modification suggestions from overlay content.
- **`llm_review_runner.ts`**: Primary LLM-based review runner that calls an LLM API to generate proposed skill modifications. Falls back to overlay-based diffs if the LLM is unavailable.
- **`llm_runtime_resolver.ts`**: Resolves LLM provider configuration from environment variables and `openclaw.json` file with strict priority ordering and structured error diagnostics.
- **`patch_generator.ts`**: Extracts structured skill updates from review responses.
- **`merge_manager.ts`**: Handles writing patches back to skill files and updating history.
- **`rollback_manager.ts`**: Manages the rolling 5-version backup system.

---

## Configuration Schema (TypeScript)

```typescript
export interface SkillEvolutionConfig {
  enabled: boolean;
  merge: {
    requireHumanMerge: boolean; // Global switch for manual approval
    maxRollbackVersions: number; // Default: 5
  };
  sessionOverlay: {
    enabled: boolean;
    storageDir: string; // Default: ".skill-overlays"
    injectMode: "system-context" | "user-context";
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
    modelOverride?: string;
    thinkingOverride?: boolean;
  };
  review: {
    minEvidenceCount: number; // Minimum events required to trigger review
    allowAutoMergeOnLowRiskOnly: boolean;
  };
}
```

---

## Data Structures (TypeScript)

### FeedbackEvent
Captured during a session to track issues and feedback.
```typescript
export interface FeedbackEvent {
  sessionId: string;
  skillKey: string;
  timestamp: string; // ISO 8601
  eventType: 'user_correction' | 'tool_error' | 'positive_feedback' | 'retry_loop';
  severity: 'low' | 'medium' | 'high';
  toolName?: string;
  messageExcerpt?: string;
  proposedOverlay?: string; // Auto-generated temporary fix
}
```

### PatchMetadata
Records the details of a generated patch.
```typescript
export interface PatchMetadata {
  skillKey: string;
  patchId: string;
  baseVersionHash: string;
  sourceSessionId: string;
  mergeMode: 'auto' | 'manual';
  riskLevel: 'low' | 'medium' | 'high';
  rollbackChainDepth: number;
  timestamp: string;
}
```

---

## Detailed Logic Flow

### A. Trigger Conditions (Feedback Identification)
The plugin must recognize feedback using mixed signals:
1. **Tool Error**: Direct failure from a tool execution (`onToolError`). Detected via:
   - `isError` flag from the hook caller
   - `rawResult.status === 'error'` (structured error object)
   - `rawResult.error` field existence (non-null, non-empty)
   - **String-based heuristic**: output text matching `/\b(error|failed|unauthorized|timeout|missing api key)\b/i`
2. **Explicit Correction (English)**: Regex-based detection of user correction patterns:
   - Matches: `don't`, `wrong`, `incorrect`, `instead`, `not that`, `should have`, `fix this`
3. **Explicit Correction (Chinese)**: Regex-based detection of Chinese correction patterns:
   - Matches: `不对`, `错了`, `应该`, `改成`, `不是这个`, `上一句有问题`, `你这里理解错了`
4. **Positive Feedback (English)**: `good`, `great`, `perfect`, `thanks`, `correct`, `nice`
5. **Positive Feedback (Chinese)**: `这样可以`, `对的`, `很好`, `没问题`, `谢谢`, `这个版本可以`
6. **Implicit Correction**: Repeating similar tool calls with different parameters after failure.

### A.1 Severity Assessment
Severity is assessed by counting **both** `tool_error` and `user_correction` events:

| Condition | Severity |
|-----------|----------|
| 0 errors + 0 corrections | `low` |
| ≥2 corrections OR ≥3 errors | `high` |
| All other combinations (≥1 signal) | `medium` |

### B. Session Overlay Lifecycle
1. **Creation from tool errors**: Triggered by detected tool errors (via `after_tool_call`) when `triggers.onToolError` is enabled.
2. **Creation from user corrections**: Triggered on the **first** `user_correction` event in a session (via `message_received`) regardless of severity level, when `triggers.onUserCorrection` is enabled. No minimum severity threshold required.
3. **Update on subsequent corrections**: If an overlay already exists for the session/skill, subsequent user corrections **append** to the existing overlay content rather than creating a new one.
4. **Injection**: `before_prompt_build` reads available overlays for the current session and returns `{ prependSystemContext }` for OpenClaw to prepend to the prompt.
5. **Cleanup**: If `clearOnSessionEnd` is true, the session overlay directory is deleted after the review pipeline completes (triggered by `session_end`).

### C. Review & Merge Flow (Triggered by `session_end`)
1. **Evidence Gathering**: Summarize all `FeedbackEvent` objects for the session, including error count, correction count, positive feedback count, and overlay count.
2. **Recommendation Decision**: Modification is recommended if ANY of the following is true:
   - `totalErrors > 0`
   - `correctionCount > 0` (user corrections alone are sufficient to trigger review)
   - `overlayCount > 0`
3. **Risk Assessment**: Risk level is based on combined `totalErrors + correctionCount`:
   - `combined ≤ 1` → `low`
   - `combined ≤ 3` → `medium`
   - `combined > 3` → `high`
4. **Justification**: Includes error count, correction count, positive signal count, and overlay count.
5. **Draft Generation**: Produces a text-format patch from accumulated overlay content.
6. **Merge Decision**:
    - If `requireHumanMerge` is true: Queue patch to `.skill-patches/` for human review.
    - If `requireHumanMerge` is false: Apply patch automatically.
7. **Finalization**: Update the skill file, save a backup of the previous version, prune rollback chain to cap.

### D. Rollback Management (Cap at 5)
- Every permanent change triggers a backup of the current `SKILL.md` to `.backups/${skillKey}/v1...v5`.
- If backups exceed 5, the oldest (v1) is deleted, and others are shifted.
- Rollback replaces the active `SKILL.md` with the most recent backup.

---

## Plugin Hooks Interface (OpenClaw)

```typescript
export interface PluginHooks {
  before_prompt_build(sessionId: string, skillKey: string, currentPrompt: string): Promise<string>;
  after_tool_call(sessionId: string, toolName: string, output: string, isError: boolean, rawResult?: unknown): Promise<void>;
  message_received(sessionId: string, message: string): Promise<void>;
  agent_end(sessionId: string): Promise<void>;
  session_end(sessionId: string): Promise<void>;
}
```

---

## Error Handling Requirements
- **Overlay Failure**: If an overlay file cannot be read/written, log a warning but do not crash the session.
- **Review Failure**: If the subagent fails to respond or produces invalid JSON/Markdown, retry once; if it fails again, abort the evolution for that session.
- **Merge Conflict**: If a skill file was manually edited during a session, detect the hash mismatch and mark the patch for manual review (ignoring the auto-merge setting).

---

## Acceptance Criteria per Module

### Plugin Hooks & Feedback
- [ ] Successfully captures tool failures as `FeedbackEvent`.
- [ ] Correctly identifies user corrections in messages.
- [ ] Correctly builds the evidence list for the review runner.

### Overlay System
- [ ] Overlays are isolated per session ID.
- [ ] Overlays are correctly injected into OpenClaw's prompt build process.
- [ ] No pollution occurs between concurrent sessions.

### Review & Patching
- [ ] Subagent generates a valid, non-empty `PATCH.md` based on session evidence.
- [ ] `merge_manager` correctly handles the `requireHumanMerge` flag.
- [ ] Skill files are updated only when intended.

### Rollback & History
- [ ] Backups are created *before* every merge.
- [ ] Version chain is strictly capped at 5.
- [ ] Rollback successfully restores the previous version and increments the version chain correctly.

---

## ⚠️ To Be Verified
- **Injection Priority**: Should overlays be placed at the start or end of the system prompt?
- **Subagent Context Window**: Ensure the session summary doesn't exceed the subagent's token limit.
- **Backup File Format**: Decide whether to store full copies or incremental diffs (full copies are safer for v1).
