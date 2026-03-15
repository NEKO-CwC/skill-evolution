# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenClaw Skill Evolution Plugin — a TypeScript plugin that enables SKILL.md files to evolve based on real usage feedback. Skills improve through session-local overlays, deterministic review, and safe merge/rollback mechanisms.

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

**5-Step Data Flow:**
1. **Collect** — `after_tool_call` / `message_received` hooks capture errors, corrections, positive signals
2. **Overlay** — `FeedbackCollector` + `FeedbackClassifier` create session-local `.json` overlays
3. **Inject** — `before_prompt_build` prepends overlays into prompts (session-scoped only)
4. **Review** — `session_end` triggers deterministic rule-based review → patch generation
5. **Merge/Rollback** — `MergeManager` applies patch (auto or manual per policy), `RollbackManager` maintains history (capped at 5 versions)

**Module Hierarchy:**
```
src/openclaw.ts            ← OpenClaw entry point, registers 4 hooks via api.on()
src/plugin/index.ts        ← Composition root (SkillEvolutionPlugin)
src/plugin/hooks/          ← 5 lifecycle hook handlers
src/plugin/overlay/        ← File-system backed overlay store + prompt injector
src/plugin/feedback/       ← In-memory collector + regex classifiers (EN + CN patterns)
src/plugin/config.ts       ← YAML loading, defaults, validation
src/review/                ← review_runner, patch_generator, merge_manager, rollback_manager
src/shared/types.ts        ← All interfaces centralized here
src/shared/errors.ts       ← Custom errors: OverlayError, MergeConflictError, RollbackError, etc.
```

**Runtime Storage (workspace-relative dotfiles):**
- `.skill-overlays/<session-id>/<skill-key>.json` — ephemeral session overlays
- `.skill-backups/<skill-key>/<version-id>.json` — rollback history (max 5)
- `.skill-patches/<skill-key>/<patch-id>.md` — pending manual merge patches
- `.skill-feedback/<session-id>.jsonl` — feedback audit trail

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

## Testing

22 test files, 88+ tests. Tests use `mkdtemp` for isolated temp directories. Test categories: shared utilities, plugin config, feedback, overlay, review pipeline, regression (Chinese corrections, session consistency), and end-to-end workflows.
