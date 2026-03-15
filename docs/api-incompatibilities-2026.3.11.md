# OpenClaw 2026.3.11 Plugin API Incompatibilities

**Date**: 2026-03-12  
**Commit SHA**: [`f2e28fc`](https://github.com/openclaw/openclaw/blob/f2e28fc30fe88cb4816a883f3a4c2e6d06cbeaf9/src/plugins/types.ts)  
**Status**: ❌ Multiple breaking incompatibilities found

---

## Executive Summary

The OpenClaw plugin API after v2026.3.11 has **4 critical breaking changes** compared to the current `skill-generation` plugin implementation:

1. **Config access method changed**: `api.getConfig()` → `api.pluginConfig`
2. **Hook event field renamed**: `event.tool` → `event.toolName`
3. **Hook event field renamed**: `event.result` → `event.result` (unchanged, but context differs)
4. **Hook context type changed**: `PluginHookAgentContext` now requires different fields

---

## 1. Config Access: `getConfig()` → `pluginConfig`

### Current Implementation (WRONG)
**Evidence** ([src/openclaw.ts#L25](https://github.com/NEKO-CwC/skill-generation/blob/master/src/openclaw.ts#L25)):
```typescript
export default function register(api: OpenClawPluginAPI): void {
  const rawConfig = api.getConfig();  // ❌ WRONG
  config = fromOpenClawPluginConfig(rawConfig ?? {});
}
```

**Evidence** ([src/shared/types.ts#L162](https://github.com/NEKO-CwC/skill-generation/blob/master/src/shared/types.ts#L162)):
```typescript
export interface OpenClawPluginAPI {
  getConfig(): Record<string, unknown>;  // ❌ WRONG
}
```

### Actual API (CORRECT)
**Evidence** ([openclaw/src/plugins/types.ts#L263-L270](https://github.com/openclaw/openclaw/blob/f2e28fc30fe88cb4816a883f3a4c2e6d06cbeaf9/src/plugins/types.ts#L263-L270)):
```typescript
export type OpenClawPluginApi = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  config: OpenClawConfig;              // ✅ Full OpenClaw config
  pluginConfig?: Record<string, unknown>;  // ✅ Plugin-specific config
  runtime: PluginRuntime;
  logger: PluginLogger;
  // ... other methods
};
```

**Real-world usage** ([openclaw/extensions/diffs/index.ts#L20](https://github.com/openclaw/openclaw/blob/f2e28fc30fe88cb4816a883f3a4c2e6d06cbeaf9/extensions/diffs/index.ts#L20)):
```typescript
register(api: OpenClawPluginApi) {
  const defaults = resolveDiffsPluginDefaults(api.pluginConfig);  // ✅ CORRECT
  const security = resolveDiffsPluginSecurity(api.pluginConfig);
}
```

**Real-world usage** ([openclaw/extensions/acpx/index.ts#L10-L14](https://github.com/openclaw/openclaw/blob/f2e28fc30fe88cb4816a883f3a4c2e6d06cbeaf9/extensions/acpx/index.ts#L10-L14)):
```typescript
register(api: OpenClawPluginApi) {
  api.registerService(
    createAcpxRuntimeService({
      pluginConfig: api.pluginConfig,  // ✅ CORRECT
    }),
  );
}
```

### Fix Required
```typescript
// OLD
const rawConfig = api.getConfig();

// NEW
const rawConfig = api.pluginConfig;
```

---

## 2. `after_tool_call` Event Shape: `event.tool` → `event.toolName`

### Current Implementation (WRONG)
**Evidence** ([src/openclaw.ts#L74](https://github.com/NEKO-CwC/skill-generation/blob/master/src/openclaw.ts#L74)):
```typescript
api.on('after_tool_call', async (event: AfterToolCallEvent) => {
  const toolName = event.tool ?? 'unknown';  // ❌ WRONG: uses `event.tool`
});
```

**Evidence** ([src/shared/types.ts#L195-L200](https://github.com/NEKO-CwC/skill-generation/blob/master/src/shared/types.ts#L195-L200)):
```typescript
export interface AfterToolCallEvent {
  tool: string;  // ❌ WRONG: field name is `tool`
  result: string;
  isError?: boolean;
}
```

### Actual API (CORRECT)
**Evidence** ([openclaw/src/plugins/types.ts#L622-L633](https://github.com/openclaw/openclaw/blob/f2e28fc30fe88cb4816a883f3a4c2e6d06cbeaf9/src/plugins/types.ts#L622-L633)):
```typescript
export type PluginHookAfterToolCallEvent = {
  toolName: string;  // ✅ CORRECT: field is `toolName`
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  result?: unknown;  // ✅ `result` is `unknown`, not `string`
  error?: string;
  durationMs?: number;
};
```

**Real-world usage** ([comet-ml/opik-openclaw/src/service/hooks/tool.ts#L93](https://github.com/comet-ml/opik-openclaw/blob/main/src/service/hooks/tool.ts#L93)):
```typescript
deps.api.on("after_tool_call", (event, toolCtx) => {
  // event.toolName is the correct field  ✅
});
```

**Real-world usage** ([knostic/openclaw-telemetry/index.ts#L17](https://github.com/knostic/openclaw-telemetry/blob/main/index.ts#L17)):
```typescript
api.on("after_tool_call", (evt, ctx) => {
  svc.write({
    type: "tool.end",
    toolName: evt.toolName,  // ✅ CORRECT
    durationMs: evt.durationMs,
    success: !evt.error,
  });
});
```

### Fix Required
```typescript
// OLD
const toolName = event.tool ?? 'unknown';

// NEW
const toolName = event.toolName ?? 'unknown';
```

---

## 3. `after_tool_call` Context Type: `PluginHookToolContext`

### Current Implementation (WRONG)
**Evidence** ([src/shared/types.ts#L169-L173](https://github.com/NEKO-CwC/skill-generation/blob/master/src/shared/types.ts#L169-L173)):
```typescript
export interface PluginHookAgentContext {
  sessionId: string;  // Used for all hooks
  agentId?: string;
  [key: string]: unknown;
}
```

### Actual API (CORRECT)
**Evidence** ([openclaw/src/plugins/types.ts#L593-L604](https://github.com/openclaw/openclaw/blob/f2e28fc30fe88cb4816a883f3a4c2e6d06cbeaf9/src/plugins/types.ts#L593-L604)):
```typescript
export type PluginHookToolContext = {
  agentId?: string;
  sessionKey?: string;  // ✅ NOTE: It's `sessionKey`, not `sessionId`
  sessionId?: string;   // ✅ Also present (ephemeral UUID)
  runId?: string;
  toolName: string;
  toolCallId?: string;
};
```

**Handler signature** ([openclaw/src/plugins/types.ts#L837-L840](https://github.com/openclaw/openclaw/blob/f2e28fc30fe88cb4816a883f3a4c2e6d06cbeaf9/src/plugins/types.ts#L837-L840)):
```typescript
after_tool_call: (
  event: PluginHookAfterToolCallEvent,
  ctx: PluginHookToolContext,  // ✅ CORRECT: uses PluginHookToolContext
) => Promise<void> | void;
```

### Fix Required
The context for `after_tool_call` should use `PluginHookToolContext`, not `PluginHookAgentContext`. However, since your plugin only reads `ctx.sessionId`, and both `sessionKey` and `sessionId` are available, this is **not immediately breaking** — but should be updated for correctness.

```typescript
// Import the correct type
import type { PluginHookToolContext } from './shared/types.js';

api.on('after_tool_call', async (
  event: AfterToolCallEvent,
  ctx: PluginHookToolContext  // ✅ More accurate type
) => {
  const sessionId = ctx.sessionId ?? ctx.sessionKey ?? 'unknown';
});
```

---

## 4. `message_received` Event Shape

### Current Implementation (POSSIBLY WRONG)
**Evidence** ([src/shared/types.ts#L207-L211](https://github.com/NEKO-CwC/skill-generation/blob/master/src/shared/types.ts#L207-L211)):
```typescript
export interface MessageReceivedEvent {
  message: string;  // ❌ Unclear if this field exists
  role?: string;
}
```

### Actual API (CORRECT)
**Evidence** ([openclaw/src/plugins/types.ts#L565-L571](https://github.com/openclaw/openclaw/blob/f2e28fc30fe88cb4816a883f3a4c2e6d06cbeaf9/src/plugins/types.ts#L565-L571)):
```typescript
export type PluginHookMessageReceivedEvent = {
  from: string;
  content: string;  // ✅ CORRECT: field is `content`, not `message`
  timestamp?: number;
  metadata?: Record<string, unknown>;
};
```

**Handler signature** ([openclaw/src/plugins/types.ts#L821-L824](https://github.com/openclaw/openclaw/blob/f2e28fc30fe88cb4816a883f3a4c2e6d06cbeaf9/src/plugins/types.ts#L821-L824)):
```typescript
message_received: (
  event: PluginHookMessageReceivedEvent,
  ctx: PluginHookMessageContext,  // ✅ Uses PluginHookMessageContext
) => Promise<void> | void;
```

**Context type** ([openclaw/src/plugins/types.ts#L558-L563](https://github.com/openclaw/openclaw/blob/f2e28fc30fe88cb4816a883f3a4c2e6d06cbeaf9/src/plugins/types.ts#L558-L563)):
```typescript
export type PluginHookMessageContext = {
  channelId: string;
  accountId?: string;
  conversationId?: string;
};
```

### Fix Required
```typescript
// OLD
const message = event.message ?? '';

// NEW
const message = event.content ?? '';
```

---

## 5. `agent_end` Event Shape

### Current Implementation (POSSIBLY WRONG)
**Evidence** ([src/shared/types.ts#L218-L221](https://github.com/NEKO-CwC/skill-generation/blob/master/src/shared/types.ts#L218-L221)):
```typescript
export interface AgentEndEvent {
  summary?: string;  // ❌ Unverified field
  [key: string]: unknown;
}
```

### Actual API (CORRECT)
**Evidence** ([openclaw/src/plugins/types.ts#L519-L525](https://github.com/openclaw/openclaw/blob/f2e28fc30fe88cb4816a883f3a4c2e6d06cbeaf9/src/plugins/types.ts#L519-L525)):
```typescript
export type PluginHookAgentEndEvent = {
  messages: unknown[];  // ✅ Session messages
  success: boolean;
  error?: string;
  durationMs?: number;
};
```

**Handler signature** ([openclaw/src/plugins/types.ts#L808](https://github.com/openclaw/openclaw/blob/f2e28fc30fe88cb4816a883f3a4c2e6d06cbeaf9/src/plugins/types.ts#L808)):
```typescript
agent_end: (
  event: PluginHookAgentEndEvent,
  ctx: PluginHookAgentContext
) => Promise<void> | void;
```

### Impact
Your plugin doesn't read any fields from `agent_end` event — you only use `ctx.sessionId`:

**Evidence** ([src/openclaw.ts#L95-L99](https://github.com/NEKO-CwC/skill-generation/blob/master/src/openclaw.ts#L95-L99)):
```typescript
api.on('agent_end', async (_event: AgentEndEvent, ctx: PluginHookAgentContext) => {
  const sessionId = ctx.sessionId;
  await plugin.agent_end(sessionId);
});
```

This will continue to work because `ctx.sessionId` is present in `PluginHookAgentContext`.

---

## 6. `before_prompt_build` Return Type (CORRECT ✅)

### Current Implementation (CORRECT ✅)
**Evidence** ([src/openclaw.ts#L65](https://github.com/NEKO-CwC/skill-generation/blob/master/src/openclaw.ts#L65)):
```typescript
return { prependSystemContext: overlayText };  // ✅ CORRECT
```

**Evidence** ([src/shared/types.ts#L183-L188](https://github.com/NEKO-CwC/skill-generation/blob/master/src/shared/types.ts#L183-L188)):
```typescript
export interface BeforePromptBuildResult {
  prependSystemContext?: string;  // ✅ CORRECT
  appendSystemContext?: string;
  systemPrompt?: string;
  prependContext?: string;
}
```

### Actual API (MATCHES ✅)
**Evidence** ([openclaw/src/plugins/types.ts#L429-L442](https://github.com/openclaw/openclaw/blob/f2e28fc30fe88cb4816a883f3a4c2e6d06cbeaf9/src/plugins/types.ts#L429-L442)):
```typescript
export type PluginHookBeforePromptBuildResult = {
  systemPrompt?: string;
  prependContext?: string;
  prependSystemContext?: string;  // ✅ CORRECT
  appendSystemContext?: string;
};
```

**Real-world usage** ([openclaw/extensions/diffs/index.ts#L38-L40](https://github.com/openclaw/openclaw/blob/f2e28fc30fe88cb4816a883f3a4c2e6d06cbeaf9/extensions/diffs/index.ts#L38-L40)):
```typescript
api.on("before_prompt_build", async () => ({
  prependSystemContext: DIFFS_AGENT_GUIDANCE,  // ✅ CORRECT
}));
```

**Status**: ✅ No change needed. Your implementation is correct.

---

## Summary: Required Changes

| Area | Current | Correct | Breaking? |
|------|---------|---------|-----------|
| Config access | `api.getConfig()` | `api.pluginConfig` | ✅ **YES** |
| `after_tool_call` event | `event.tool` | `event.toolName` | ✅ **YES** |
| `after_tool_call` result | `event.result: string` | `event.result: unknown` | ⚠️ Minor |
| `message_received` event | `event.message` | `event.content` | ✅ **YES** |
| `agent_end` event | `event.summary?` | `event.messages, success, error, durationMs` | ⚠️ Minor (you don't use it) |
| `before_prompt_build` return | `prependSystemContext` | `prependSystemContext` | ✅ **CORRECT** |

---

## Recommended Action Plan

1. **Update `src/shared/types.ts`** to match actual OpenClaw API signatures
2. **Update `src/openclaw.ts`** to use correct field names
3. **Run tests** to verify no regressions
4. **Test with real OpenClaw 2026.3.11+**

---

## Additional Notes

### `sessionId` vs `sessionKey`
OpenClaw uses two different identifiers:
- `sessionKey`: Stable session identifier (e.g., `"agent-name"`)
- `sessionId`: Ephemeral UUID regenerated on `/new` and `/reset`

**Evidence** ([openclaw/src/plugins/types.ts#L64-L65](https://github.com/openclaw/openclaw/blob/f2e28fc30fe88cb4816a883f3a4c2e6d06cbeaf9/src/plugins/types.ts#L64-L65)):
```typescript
sessionKey?: string;
/** Ephemeral session UUID — regenerated on /new and /reset. Use for per-conversation isolation. */
sessionId?: string;
```

Your plugin uses `sessionId` everywhere, which is correct for session-local overlays that should be cleared on reset.

---

## References

- [OpenClaw official repo](https://github.com/openclaw/openclaw)
- [Commit f2e28fc (2026-03-12)](https://github.com/openclaw/openclaw/blob/f2e28fc30fe88cb4816a883f3a4c2e6d06cbeaf9/src/plugins/types.ts)
- [Official diffs plugin (reference implementation)](https://github.com/openclaw/openclaw/blob/f2e28fc30fe88cb4816a883f3a4c2e6d06cbeaf9/extensions/diffs/index.ts)
- [Official acpx plugin (reference implementation)](https://github.com/openclaw/openclaw/blob/f2e28fc30fe88cb4816a883f3a4c2e6d06cbeaf9/extensions/acpx/index.ts)
