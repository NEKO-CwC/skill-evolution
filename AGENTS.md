# AGENTS.md -- Agent Contract Rules

Rules and invariants that any agent (human or AI) working on this codebase must follow.

## LLM Review Handling

- **LLM review is the primary review path.** `LLMReviewRunner` builds a prompt from session evidence (errors, corrections, overlays) and calls an LLM to generate proposed skill modifications.
- **LLM provider is resolved at runtime** via `LlmRuntimeResolver` with strict priority: env vars → `openclaw.json` file → structured error. The resolver is injected into the review runner when the workspace binds.
- **Model ID resolution uses explicit provider when available.** When `config.llm.provider` is set (e.g. `"openrouter"`), it is used for routing and the model string is passed **verbatim** to the API. When `provider` is null, the resolver falls back to splitting on the first `/` (e.g. `openrouter/anthropic/claude-3.5-sonnet` → provider=`openrouter`, modelId=`anthropic/claude-3.5-sonnet`).
- **`readPrimaryModel()` reads from `openclaw.json`.** When `inheritPrimaryConfig=true` and no `modelOverride` is set, the review runner reads `agents.defaults.model.primary` from `openclaw.json` instead of using a hardcoded model ID. Returns null if no config is found.
- **If the LLM call fails, the runner falls back to overlay-based diffs.** The fallback produces a patch prefixed with `# LLM Unavailable - Using Fallback` containing raw overlay content. This is not a bug — it ensures a patch is always generated even when the LLM is unreachable.
- **`review.engine=llm` does not guarantee LLM execution.** It only means "attempt LLM review." The actual execution depends on provider resolution succeeding and the LLM endpoint being reachable.
- **Provider API type normalization:** The `api` field from `openclaw.json` is normalized — `openai`, `openai-completions`, and `openai-chat-completions` all map to OpenAI-compatible endpoints. `anthropic` and `anthropic-messages` map to Anthropic Messages API. Unsupported values throw immediately (not silently swallowed).

## Patch vs. Mergeable Document

- **Report patches and mergeable documents are separate outputs.** `PatchGenerator.generateSplit()` returns `PatchOutput { reportPatch, mergeableDocument }`.
- **Report patch** (audit trail) always goes to `.skill-patches/<storage-key>/<patch-id>.md`. This is never written into the target skill document.
- **Mergeable document** (candidate content) goes to the target path only when merge policy allows it (`mergeMode=auto` and `requireHumanMerge=false`). Otherwise it is included in the patch file for human review.
- Never confuse these two outputs. Auto-merge must never write the report patch into `SKILL.md` or any target document.

## Target Routing

- **Builtin and global learnings go to `.skill-global/`, not `skills/`.** Builtin tools (Bash, Read, Write, etc.) route to `.skill-global/tools/<tool>.md`. Global defaults route to `.skill-global/DEFAULT_SKILL.md`.
- **Unresolved targets are queue-only.** They produce patches at `.skill-patches/` but are never auto-merged.
- **`TargetResolver.resolve()` must return a valid `EvolutionTarget`** for every input. The `unresolved` kind exists as the catch-all.

## Configuration Contract

- **New config fields must be added in three places:**
  1. `openclaw.plugin.json` -- the JSON Schema under `configSchema`
  2. `src/plugin/config.ts` -- `getDefaultConfig()` return value and `validateConfig()` checks
  3. Documentation (`docs/config.md` and this file if it affects agent behavior)
- **All config fields must have defaults** in `getDefaultConfig()`. The plugin must function correctly with zero user-provided config.
- **Validation is strict.** `validateConfig()` throws `InvalidConfigError` for any out-of-range or wrong-type value. Do not add config fields without adding validation.

## Path Resolution

- **Paths are derived from `workspaceRoot` formulas, not hardcoded.** Use `resolvePaths()` from `src/shared/paths.ts`. The workspace root is resolved at runtime from hook context (`ctx.workspaceDir`), falling back to `process.cwd()`.
- **Never construct storage paths manually.** Always use `ResolvedPaths` properties: `overlaysDir`, `patchesDir`, `backupsDir`, `skillsDir`, `feedbackDir`.
- **Plugin must be told workspace directory at runtime.** `ensureWorkspaceDir()` is called on first hook invocation. Before that, paths use `process.cwd()` as fallback.
- **`session_end` guards against unbound workspace.** If workspace is not bound when `session_end` fires, the hook returns early with a structured skip log. No review, no file writes, no crash.

## Session Overlay Invariant

- **Session-local overlays never directly edit SKILL.md.** Overlays are ephemeral JSON files stored at `.skill-overlays/<session-id>/<skill-key>.json`. They are injected into prompts via `before_prompt_build` and cleared when the session ends (if `clearOnSessionEnd=true`).
- **The only path from feedback to SKILL.md is: review -> patch -> merge.** No shortcutting.

## Merge and Rollback

- **`requireHumanMerge=true` must block auto-merge.** When this flag is set, all patches go to `.skill-patches/` for human review, regardless of risk level.
- **Rollback chain is capped at 5 versions per skill** (configurable via `merge.maxRollbackVersions`). Oldest version is dropped on overflow.
- **Backups are created before every auto-merge write.** The rollback manager snapshots the current content before any target document is overwritten.

## Code Conventions

- ESM only. All imports use `.js` extensions.
- All interfaces live in `src/shared/types.ts`. No `any` in public APIs.
- Custom error classes from `src/shared/errors.ts`. No empty catch blocks.
- Files use `snake_case.ts`. Tests use `test_` prefix.
- Run `npm run test` after any change.
