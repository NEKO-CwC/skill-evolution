# Acceptance Checklist (v1)

1. ✅ **当前 session 的修正能立即影响后续行为**
   - **Description**: Real-time feedback collection creates session-local overlays that are injected into subsequent prompts within the same session.
   - **Verification**: `tests/workflows/test_workflows.ts` (Workflow 1: collects tool_error, writes overlay, and injects overlay into next prompt).

2. ✅ **临时修正不会自动污染其他 session**
   - **Description**: Overlays are isolated by session ID in storage and only injected into prompts for the matching session.
   - **Verification**: `tests/plugin/overlay/test_overlay_store.ts` (keeps overlays isolated across sessions for same skill key) and `clearSession` only affects the target session.

3. ✅ **session 结束后可稳定生成 patch**
   - **Description**: The `agent_end` hook triggers the `ReviewRunner`, `PatchGenerator`, and `MergeManager` chain to create a formal patch.
   - **Verification**: `tests/workflows/test_workflows.ts` (Workflow 2: agent_end triggers review, patch generation, and merge).

4. ✅ **支持全局人工 merge 开关**
   - **Description**: A global `requireHumanMerge` setting determines whether patches are auto-merged or queued for human review.
   - **Verification**: `tests/workflows/test_workflows.ts` (Workflow 3: Manual merge blocks auto-write, patch queued under .skill-patches).

5. ✅ **每个 skill 支持最近 5 个历史版本回滚**
   - **Description**: Every successful merge creates a backup, and history is capped at a configurable limit (default 5).
   - **Verification**: `tests/review/test_rollback_manager.ts` (pruneOldVersions caps rollback history) and `tests/workflows/test_workflows.ts` (Workflow 4: Auto merge writes + backs up + prunes to cap).

6. ✅ **有最基本的 README、示例配置、单元测试**
   - **Description**: Project includes comprehensive documentation, a copy-pasteable configuration example, and 71 unit tests across 13 files.
   - **Verification**: `README.md` created, `examples/config.example.yaml` exists, 71 tests in 13 files pass via `npm run test`.
