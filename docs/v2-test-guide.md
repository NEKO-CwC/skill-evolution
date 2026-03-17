# Skill Evolution v2 — 测试指南

## 前置条件

- OpenClaw gateway 已启动且 skill-evolution 插件已加载
- 验证：`openclaw plugins info skill-evolution` 显示 `Status: loaded`，且 Tools 列表包含 7 个 `skill_evolution_*` 工具
- 顶层 agent 已注册：`openclaw agents list` 显示 `skill-evolution`
- 如未注册，运行：`./scripts/register-agent.sh` 或 `openclaw agents add skill-evolution --workspace ~/.openclaw/workspace --non-interactive`

---

## 一、基础功能验证（v1 兼容性）

### 1.1 反馈收集

在 OpenClaw 对话中触发以下场景，观察 `.skill-feedback/` 目录是否生成 `.jsonl` 文件：

| 场景 | 触发方式 | 预期 |
|------|----------|------|
| 工具报错 | 让 agent 执行一个必定失败的命令（如读取不存在的文件） | `tool_error` 类型反馈被记录 |
| 用户纠正 | 回复 "不对，应该用 xxx" 或 "错了" | `user_correction` 类型反馈被记录 |
| 正向反馈 | 回复 "对" / "很好" / "正确" | `positive_feedback` 类型反馈被记录 |
| 中文纠正 | 回复 "这样不行，改成 xxx" | `user_correction` 类型反馈被记录 |

验证命令：
```bash
ls -la /home/node/.openclaw/workspace/.skill-feedback/
cat /home/node/.openclaw/workspace/.skill-feedback/*.jsonl | tail -5
```

### 1.2 Session Overlay

在同一 session 中：
1. 触发一次纠正反馈
2. 观察 `.skill-overlays/<session-id>/` 下生成 overlay JSON
3. 验证后续 prompt 中包含 overlay 注入内容

验证命令：
```bash
ls -la /home/node/.openclaw/workspace/.skill-overlays/
find /home/node/.openclaw/workspace/.skill-overlays/ -name "*.json" -exec cat {} \;
```

### 1.3 Session 结束 Review（queue-only 模式）

默认 `reviewMode: queue-only`，session 结束时应：
- 生成 patch 文件到 `.skill-patches/`
- **不**启动 review agent
- **不**自动 apply patch

验证命令：
```bash
ls -la /home/node/.openclaw/workspace/.skill-patches/
cat /home/node/.openclaw/workspace/.skill-patches/index.json 2>/dev/null | python3 -m json.tool
```

---

## 二、v2 Agent Tools 验证

插件注册了 7 个 agent tool，可在 OpenClaw 对话中直接调用。

### 2.1 patch_list — 列出 patch

在对话中要求 agent 调用 `skill_evolution_patch_list`：

> "帮我列出当前所有的 skill evolution patch"

预期返回：
```json
{
  "patches": [...],
  "total": <number>
}
```

带过滤参数：
> "列出状态为 queued 的 patch"

### 2.2 patch_get — 获取详情

> "获取 patch <patch_id> 的详细信息"

预期返回完整 PatchCandidate 对象，包含 `id`, `status`, `risk`, `summary`, `proposedDiff` 等字段。

### 2.3 patch_status — 查询状态

> "查询 patch <patch_id> 的状态"

预期返回：
```json
{
  "id": "<patch_id>",
  "status": "queued",
  "risk": "medium",
  "updatedAt": "..."
}
```

### 2.4 patch_apply — 应用 patch

> "帮我应用 patch <patch_id>"

预期行为：
- Patch 状态变为 `applied`
- 对应 SKILL.md 文件被更新
- `.skill-backups/` 中生成备份

**注意**：如果 `requireHumanMerge: true` 且 patch 未被 approve，可能被拒绝。

### 2.5 patch_reject — 拒绝 patch

> "拒绝 patch <patch_id>，原因是修改范围太大"

预期行为：
- Patch 状态变为 `rejected`
- 再次 reject 同一 patch 返回幂等成功

### 2.6 review_enqueue — 提交 review

> "将 patch <patch_id> 提交 review"

预期行为：
- Patch 状态从 `queued` 变为 `reviewing`
- 在 `assisted` 模式下会触发 LLM review

### 2.7 patch_notify — 发送通知

> "为 patch <patch_id> 发送通知"

预期行为（通知关闭时）：
```json
{
  "notified": false,
  "reason": "notify disabled"
}
```

---

## 三、Patch 状态机验证

### 3.1 合法状态转换

| 当前状态 | 可转换到 |
|----------|----------|
| `queued` | `reviewing`, `superseded`, `failed` |
| `reviewing` | `ready`, `superseded`, `failed` |
| `ready` | `notified`, `approved`, `rejected`, `superseded`, `failed` |
| `notified` | `approved`, `rejected`, `failed` |
| `approved` | `applied`, `failed` |
| `rejected` | （终态） |
| `applied` | （终态） |
| `superseded` | （终态） |
| `failed` | （终态） |

### 3.2 非法转换测试

尝试将 `applied` 状态的 patch 再次 apply：
> "再次应用 patch <已 applied 的 patch_id>"

预期：返回幂等成功（不重复写入文件），或抛出 `PatchStateError`。

---

## 四、Review Mode 切换测试

### 4.1 升级到 assisted 模式

编辑 `openclaw.json` 中的插件配置：

```json
"config": {
  "enabled": true,
  "reviewMode": "assisted",
  "notify": {
    "enabled": true,
    "mode": "per-session",
    "channel": "same-thread"
  }
}
```

重启 gateway 后，session 结束时预期：
- Patch 入队
- 委派到 `skill-evolution` agent 的 review session（或 LLM fallback）
- 通知被发送

### 4.2 auto-low-risk 模式

```json
"reviewMode": "auto-low-risk"
```

预期：低风险 patch 在 review 后自动 apply，无需人工干预。

---

## 五、回滚测试

1. 应用一个 patch（SKILL.md 被修改）
2. 检查 `.skill-backups/<skill-key>/` 有备份文件
3. 备份最多保留 5 个版本

```bash
ls -la /home/node/.openclaw/workspace/.skill-backups/
```

---

## 六、运行单元测试

```bash
# 全部测试（318 tests / 34 files）
cd /home/node/.openclaw/workspace/skill-evolution
npm test

# 只跑 v2 相关测试
npx vitest run tests/review/test_patch_queue.ts           # patch 队列 + 状态机
npx vitest run tests/regression/test_patch_state_machine.ts  # 状态转换回归
npx vitest run tests/plugin/tools/test_patch_tools.ts      # 7 个 agent tools
npx vitest run tests/plugin/config/test_config_v2.ts       # v2 配置
npx vitest run tests/review/test_review_orchestrator.ts    # review 编排
npx vitest run tests/plugin/notify/test_notify_manager.ts  # 通知管理
npx vitest run tests/regression/test_queue_only_compat.ts  # queue-only 兼容
npx vitest run tests/regression/test_multi_session.ts      # 多 session
npx vitest run tests/workflows/test_assisted_review.ts     # 端到端流程
```

---

## 七、常见问题

### Q: 升级后现有行为会变吗？
**不会。** `reviewMode` 默认为 `queue-only`，与 v1 完全一致。只有显式设置为 `assisted` 或 `auto-low-risk` 才会启用新功能。

### Q: Agent tools 没出现？
检查 `openclaw plugins info skill-evolution`，确认 Tools 行包含 7 个工具。如果缺失，确认 `openclaw.json` 中 `plugins.entries.skill-evolution.enabled: true`。

### Q: Patch 文件在哪？
默认存储在 `<workspace>/.skill-patches/` 目录。每个 patch 有两个文件：
- `<patch-id>.json` — 结构化元数据
- `<patch-id>.md` — 人类可读摘要

索引文件：`.skill-patches/index.json`

### Q: 通知不工作？
检查配置中 `notify.enabled: true` 且 `notify.mode` 不为 `off`。同时确认 `notifications.minRiskToInterrupt` 不高于 patch 的风险等级。

### Q: WebUI 中看不到 agent？
运行 `openclaw agents list`。如果没有 `skill-evolution`，注册它：
```bash
openclaw agents add skill-evolution --workspace ~/.openclaw/workspace --non-interactive
```
然后重启 gateway。

### Q: 之前注册了 skill-evolution-review / skill-evolution-notify 怎么办？
这些已弃用。新架构只需一个顶层 agent `skill-evolution`。review 和 notify 是其内部 session。
建议删除旧 agent 并注册新的：
```bash
openclaw agents delete skill-evolution-review
openclaw agents delete skill-evolution-notify
openclaw agents add skill-evolution --workspace ~/.openclaw/workspace --non-interactive
```

### Q: 旧的 agents.review / agents.notify 配置还能用吗？
可以。插件会自动将旧配置迁移到新的 `agent` + `sessions` 格式。但建议更新到新格式。
