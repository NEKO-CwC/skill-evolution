# Gap Analysis: Current Implementation vs OpenClaw Plugin Spec

## Summary

This document tracks gaps between the plugin implementation and the OpenClaw plugin specification. Originally written during v1 (business-logic only), it has been updated through v2 (plugin wrapper) and v3 (API compatibility with OpenClaw 2026.3.11).

**Current status**: All gaps resolved. Plugin is fully compatible with OpenClaw 2026.3.11.

## Resolution History

### v2 — Plugin Wrapper (all original gaps resolved)

| Gap | Description | Resolution |
|-----|-------------|------------|
| 1. Missing manifest | No `openclaw.plugin.json` | Created with `id`, `configSchema` |
| 2. Missing `openclaw.extensions` | `package.json` had no plugin entry | Added `openclaw.extensions` field |
| 3. Missing entry point | No `src/openclaw.ts` adapter | Created thin adapter with `register(api)` |
| 4. Hook signature mismatch | Internal methods vs OpenClaw `(event, ctx)` | Adapter maps between signatures |
| 5. Config source mismatch | Only YAML file loading | Added `fromOpenClawPluginConfig()` adapter |
| 6. Missing API types | No OpenClaw types in project | Added to `src/shared/types.ts` |
| 7. `allowPromptInjection` degradation | Not handled | Logged at registration time |
| 8. README targeting | Developer-focused only | Rewritten for end-user plugin installation |

### v3 — OpenClaw 2026.3.11 API Compatibility

The v2 types were based on documentation and assumptions. After comparing against the **real OpenClaw 2026.3.11 source** (`src/plugins/types.ts`, commit `f2e28fc`), 10 incompatibilities were found and fixed:

| # | Incompatibility | Old (v2) | New (v3) | Files Changed |
|---|----------------|----------|----------|---------------|
| 1 | Type name | `OpenClawPluginAPI` | `OpenClawPluginApi` | types.ts, openclaw.ts, tests |
| 2 | Config access | `api.getConfig()` method | `api.pluginConfig` property | types.ts, openclaw.ts, tests |
| 3 | API shape | Only `on()` + `getConfig()` | Added `id`, `name`, `logger`, `pluginConfig?` | types.ts, tests |
| 4 | Agent context | `sessionId` required | `sessionId` optional, added `sessionKey?`, `workspaceDir?`, etc. | types.ts, openclaw.ts, tests |
| 5 | Tool call event | `{ tool, result: string, isError? }` | `{ toolName, params, result?: unknown, error?: string, durationMs? }` | types.ts, openclaw.ts, tests |
| 6 | Tool call context | `PluginHookAgentContext` | `PluginHookToolContext` (new type) | types.ts, openclaw.ts, tests |
| 7 | Message event | `{ message, role? }` | `{ from, content, timestamp?, metadata? }` | types.ts, openclaw.ts, tests |
| 8 | Message context | `PluginHookAgentContext` | `PluginHookMessageContext` (new type: `channelId`, `accountId?`, `conversationId?`) | types.ts, openclaw.ts, tests |
| 9 | Agent end event | `{ summary? }` | `{ messages, success, error?, durationMs? }` | types.ts, tests |
| 10 | Prompt event | Had `modelId?`, `provider?`, index signature | Only `{ prompt, messages }` | types.ts |

### Session ID Resolution Strategy (v3)

Since `sessionId` is optional or absent in some contexts, the adapter uses fallback chains:

| Hook | Context Type | Session ID Resolution |
|------|-------------|----------------------|
| `before_prompt_build` | `PluginHookAgentContext` | `ctx.sessionId ?? ctx.sessionKey ?? 'unknown-session'` |
| `after_tool_call` | `PluginHookToolContext` | `ctx.sessionId ?? 'unknown-session'` |
| `message_received` | `PluginHookMessageContext` | `ctx.conversationId ?? ctx.channelId ?? 'unknown-session'` |
| `agent_end` | `PluginHookAgentContext` | `ctx.sessionId ?? ctx.sessionKey ?? 'unknown-session'` |

## Current State

| Aspect | Status | Notes |
|--------|--------|-------|
| Business logic (5-step workflow) | ✅ Complete | Unchanged since v1 |
| Plugin manifest | ✅ Complete | `openclaw.plugin.json` with `configSchema` |
| Plugin entry point | ✅ Complete | `src/openclaw.ts` thin adapter |
| OpenClaw API types | ✅ Complete | Matches real 2026.3.11 source |
| Hook signature mapping | ✅ Complete | All 4 hooks with correct event/context types |
| Config adapter | ✅ Complete | `fromOpenClawPluginConfig()` from `api.pluginConfig` |
| Degradation handling | ✅ Complete | `allowPromptInjection` warning logged |
| README | ✅ Complete | End-user plugin installation guide |
| Tests | ✅ Complete | 88 tests passing (15 files) |
| TypeScript build | ✅ Complete | ESM, strict mode, clean lint |

## Evidence Sources (v3)

- **OpenClaw source**: [`src/plugins/types.ts`](https://github.com/openclaw/openclaw/blob/f2e28fc30fe88cb4816a883f3a4c2e6d06cbeaf9/src/plugins/types.ts) (892 lines)
- **Real plugin examples**: `extensions/acpx/index.ts`, `extensions/voice-call/index.ts`, `extensions/diffs/index.ts`
- **Pattern confirmed**: All real plugins use `api.pluginConfig` (property), not `api.getConfig()` (method)

## Non-Goals (Explicitly Out of Scope)

- Rewriting business logic — all existing modules stay as-is
- Adding LLM-based review — v1 stays deterministic
- Per-skill merge policy — global switch only
- Complex integration test platform — mock-based tests only
- Publishing to npm — local install only for now
