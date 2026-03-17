# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenClaw Skill Evolution Plugin — a TypeScript plugin that enables SKILL.md files to evolve based on real usage feedback. Skills improve through session-local overlays, deterministic review, and safe merge/rollback mechanisms. v2 adds a structured patch queue with state machine, agent tools for programmatic patch operations, and a single top-level agent with internal review/notify sessions.

## Commands

```bash
npm run build        # TypeScript compilation to dist/
npm run test         # Run all tests (vitest)
npm run test:watch   # Run tests in watch mode
npm run lint         # Type check only (tsc --noEmit)
```

Run a single test file:
```bash
npx vitest run tests/plugin/test_config.ts
```

## Architecture

**Two-Layer Design:**
- **Plugin layer** — hooks, feedback collection, overlay, patch queue, tools, merge/rollback (runtime)
- **Agent layer** — single top-level `skill-evolution` agent visible in WebUI, with internal review/notify sessions (control plane)

**5-Step Data Flow:**
1. **Collect** — `after_tool_call` / `message_received` hooks capture errors, corrections, positive signals
2. **Overlay** — `FeedbackCollector` + `FeedbackClassifier` create session-local `.json` overlays
3. **Inject** — `before_prompt_build` prepends overlays into prompts (session-scoped only)
4. **Review** — `session_end` triggers review pipeline → patch generation → enqueue
5. **Merge/Rollback** — `MergeManager` applies patch (auto or manual per policy), `RollbackManager` maintains history (capped at 5 versions)

**v2 Additions:**
- **Patch Queue** — `PatchQueueManager` manages structured `PatchCandidate` objects with 8-state lifecycle, file-level locking, and `index.json` for fast queries
- **Agent Tools** — 7 tools registered via `api.registerTool()` for programmatic patch list/get/apply/reject/status/enqueue/notify
- **Top-Level Agent** — Single `skill-evolution` agent registered in `openclaw.json > agents.list`, manages review + notify as internal sessions
- **Review Orchestrator** — Delegates to agent session via gateway CLI, falls back to LLMReviewRunner
- **Notify Manager** — Debounced, digest-capable notifications with risk filtering and flood protection

**Module Hierarchy:**
```
src/openclaw.ts            ← OpenClaw entry point, registers hooks + agent tools
src/plugin/index.ts        ← Composition root (SkillEvolutionPlugin)
src/plugin/hooks/          ← 5 lifecycle hook handlers
src/plugin/overlay/        ← File-system backed overlay store + prompt injector
src/plugin/feedback/       ← In-memory collector + regex classifiers (EN + CN patterns)
src/plugin/tools/          ← 7 agent tool implementations + registration
src/plugin/notify/         ← NotifyManager (debounce, digest, dedupe, flood control)
src/plugin/config.ts       ← YAML loading, defaults, validation (basic + advanced tiers)
src/review/                ← review_runner, patch_generator, merge_manager, rollback_manager
src/review/patch_queue.ts  ← PatchQueueManager (state machine, index, locking)
src/review/review_orchestrator.ts ← Agent session delegation + LLM fallback
src/shared/types.ts        ← All interfaces centralized here
src/shared/errors.ts       ← Custom errors: PatchStateError, PatchNotFoundError, MergeConflictError, etc.
agents/skill-evolution.json ← Top-level agent definition (review + notify combined)
scripts/register-agent.sh  ← CLI script to register agent with OpenClaw
```

**Runtime Storage (workspace-relative dotfiles):**
- `.skill-overlays/<session-id>/<skill-key>.json` — ephemeral session overlays
- `.skill-backups/<skill-key>/<version-id>.json` — rollback history (max 5)
- `.skill-patches/<skill-key>/<patch-id>.json` — structured patch metadata (v2)
- `.skill-patches/<skill-key>/<patch-id>.md` — human-readable patch summary
- `.skill-patches/index.json` — queue index for fast queries
- `.skill-feedback/<session-id>.jsonl` — feedback audit trail

## Agent Architecture

Only **one top-level agent** (`skill-evolution`) appears in WebUI. Review and notify are **internal sessions** of this agent, not separate agents.

- `agents/skill-evolution.json` — unified agent definition
- `agents/_deprecated_*.json` — legacy separate agent definitions (kept for migration reference)

The agent interacts with patch lifecycle via 7 `skill_evolution_*` tools registered by the plugin.

## Code Conventions

- **ESM only** — `type: "module"` in package.json; all imports use `.js` extensions (NodeNext resolution)
- **Files:** `snake_case.ts` for source, `test_` prefix for tests (e.g., `test_config.ts`)
- **Naming:** `camelCase` functions, `PascalCase` classes, `UPPER_SNAKE_CASE` constants
- **Types:** all interfaces live in `src/shared/types.ts`; no `any` in public APIs
- **Imports:** group as node builtins → third-party → local; no wildcard imports
- **Errors:** always use custom error classes from `src/shared/errors.ts`; no empty catch blocks; all failures produce structured JSON logs via `ConsoleLogger`

## Critical Invariants

1. Session-local overlays **never** directly edit shared `SKILL.md` — overlays are ephemeral JSON scoped to session
2. Final skill changes only via patch review + merge — no shortcutting the review step
3. `requireHumanMerge=true` must block auto-merge
4. Rollback chain capped at 5 versions (oldest dropped on overflow)
5. Plugin must be told workspace directory at runtime via hook context — no direct workspace access without binding
6. Patch state machine is strict — invalid transitions throw `PatchStateError`
7. `reviewMode` defaults to `queue-only` — upgrading plugin changes zero behavior unless user opts in
8. Only one top-level agent — review/notify are internal sessions, not separate agents

## Config Modes

- `reviewMode: 'off'` — no review pipeline at session_end
- `reviewMode: 'queue-only'` — enqueue patch, no agent spawn (default, matches v1)
- `reviewMode: 'assisted'` — enqueue + delegate to agent session + optional notify
- `reviewMode: 'auto-low-risk'` — like assisted but auto-apply low-risk patches

## Config Structure

**Basic (user-facing):** `reviewMode`, `notify.enabled`, `notify.mode`, `merge.requireHumanMerge`, `review.minEvidenceCount`

**Advanced (agent/sessions):** `agent.enabled`, `agent.id`, `agent.model`, `sessions.review.*`, `sessions.notify.*`, `notifications.*`, `risk.*`

**Legacy compat:** `agents.review.*` / `agents.notify.*` auto-migrated to `agent` + `sessions` via `migrateAgentsCompat()`

## Testing

34 test files, 329+ tests. Tests use `mkdtemp` for isolated temp directories. Test categories: shared utilities, plugin config (v1 + v2 + migration), feedback, overlay, review pipeline, patch queue + state machine, agent tools, notify manager, regression (Chinese corrections, session consistency, queue-only compat, multi-session), and end-to-end workflows.
