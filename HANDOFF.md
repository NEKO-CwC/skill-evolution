# Skill Evolution Plugin — Handoff Summary

**Date**: 2026-03-15
**Repo**: `skill-evolution` (OpenClaw Skill Evolution Plugin)
**Last commit**: `de76fe2` on `master`

---

## What This Plugin Does

A TypeScript plugin for OpenClaw that enables SKILL.md files to evolve based on real usage feedback. Skills improve through session-local overlays, deterministic review, and safe merge/rollback mechanisms.

**5-Step Data Flow:**
1. **Collect** — `after_tool_call` / `message_received` hooks capture errors, corrections, positive signals
2. **Overlay** — FeedbackCollector + FeedbackClassifier create session-local `.json` overlays
3. **Inject** — `before_prompt_build` prepends overlays into prompts (session-scoped only)
4. **Review** — `session_end` triggers LLM-based review → patch generation
5. **Merge/Rollback** — MergeManager applies patch (auto or manual per policy), RollbackManager maintains history

---

## Recent Fix History (Reverse Chronological)

| Commit    | Fix                                                     | Root Cause                                                                                            |
| --------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `de76fe2` | Normalize file permissions                              | Mode drift (644→755)                                                                                  |
| `844cfa4` | E2E verification log                                    | Documentation                                                                                         |
| `8903c6f` | Serialize tool result objects properly                  | `String(obj)` → `[object Object]` in messageExcerpt                                                   |
| `eccb823` | **Resolve workspace from config at startup**            | Gateway restart → `process.cwd()=/app` → wrong feedbackDir → session_end reads empty → review skipped |
| `aff92e4` | Add `~/.openclaw/` state dir to config candidate paths  | LlmRuntimeResolver couldn't find openclaw.json                                                        |
| `859b588` | Infer provider from openclaw.json                       | Model ID truncation (stripped provider prefix)                                                        |
| `6826914` | Allow fallback workspace to be upgraded by hook context | Workspace binding timing issue                                                                        |

---

## Current Status: All Systems Operational

### Verified Working (14/14 checks pass)
- Plugin resolves workspace from `openclaw.json` config, not `process.cwd()`
- Feedback collection writes to correct path
- `session_end` reads feedback from disk (eventCount > 0)
- LLM review pipeline runs (openrouter/hunter-alpha)
- Patch generation and merge queue work correctly
- All 168 unit tests pass
- Build clean

### Known Design Characteristic (Not a Bug)
`session_end` fires only when OpenClaw rotates sessions (via timeout or `/reset`), not after every agent turn. `agent_end` fires per-turn. Feedback accumulates across turns; review happens at session boundary.

---

## Key Configuration

The plugin requires this entry in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "skill-evolution": {
        "enabled": true,
        "source": "/path/to/skill-evolution/src/openclaw.ts",
        "config": {
          "enabled": true,
          "workspaceDir": "/home/node/.openclaw/workspace",
          "merge": { "requireHumanMerge": true, "maxRollbackVersions": 5 },
          "llm": {
            "inheritPrimaryConfig": true,
            "modelOverride": "openrouter/hunter-alpha",
            "provider": "openrouter"
          },
          "review": { "minEvidenceCount": 1 }
        }
      }
    }
  }
}
```

**Critical**: `workspaceDir` must be set explicitly. Without it, the plugin falls back to `process.cwd()` which is `/app` in the gateway container.

---

## Runtime Storage Layout

```
<workspace>/
├── .skill-overlays/<session-id>/<skill-key>.json   # Ephemeral session overlays
├── .skill-backups/<skill-key>/<version-id>.json     # Rollback history (max 5)
├── .skill-patches/<skill-key>/<patch-id>.md         # Pending patches for human review
├── .skill-feedback/<session-id>.jsonl               # Feedback audit trail
└── skills/<skill-key>/SKILL.md                      # The evolving skill documents
```

---

## Commands

```bash
npm run build        # TypeScript compilation to dist/
npm run test         # Run all tests (vitest, 168 tests)
npm run lint         # Type check only (tsc --noEmit)
```

---

## No Open Issues

All identified problems have been fixed and verified. The plugin is production-ready.
