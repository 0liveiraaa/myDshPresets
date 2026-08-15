# dsh-preset-reference

DeepSeek Harness 用户级 agent preset 的发布目录。里面直接包含两个可直接安装的自研 preset（`warmupbetter`、`warmupbetter-replay`），并记录两个上游参考仓库、相互关系与发布检查清单。

## 安装（给别人用）

```powershell
# 在本目录执行；已存在同名 preset 时跳过，不会覆盖
.\install-presets.ps1

# 只装其中一个
.\install-presets.ps1 -Presets warmupbetter
.\install-presets.ps1 -Presets warmupbetter-replay
```

安装后重启 dsh，新建 session，在 preset 选择器里选 **Warmup Better** 或 **Warmup Better Replay**。也可以手动把整个子目录复制到：

```text
%USERPROFILE%\.dsh\.agent-presets\
```

## 参考仓库

| 仓库 | 作用 |
|---|---|
| https://github.com/YeEeck/dsh-pristine | `warmup`（显示名 Pristine）的参考实现：保证首个 model request 处于纯 Minimal 状态 |
| https://github.com/xiaobright/dsh-anchored-standard | `anchored-standard`：首轮两工具锚定，首个 tool/call 后恢复完整 Standard 目录 |

## 本目录包含的 preset

| 子目录 | 显示名 | 机制 | 第一轮是否调用真实模型 |
|---|---|---|---|
| `./warmupbetter` | Warmup Better | 纯 Minimal 首请求 + 长 COT 热身消息 | 是 |
| `./warmupbetter-replay` | Warmup Better Replay | 首轮由 `replay.json` 重放录制好的 COT + 回复，短路 `llm/stream` | 否 |

每个子目录自带 `LICENSE.deepseek-harness`（MIT）。

## 相互关系的备忘

- `warmup` / `warmupbetter`：同一个“warmup 轮替换”机制，差别只在 warmup 消息文本。
- `warmupbetter-replay`：继承 `warmupbetter` 的全部组合，但第一轮不是生成，而是重放一次真实 `warmupbetter` session 记录下来的 `reasoning` 和可见回复；第二轮起恢复真实模型和完整工具目录。
- `anchored-standard`：思路不同——首个请求用两工具建立轨迹，第一次工具调用后**同一任务内**扩到 25 项工具；`warmupbetter-replay` 是**整个 warmup turn** 用两工具重放，下一 turn 才开始真实任务。
- 已验证：复杂 AGENTS.md/skill 注入后，`warmupbetter-replay` 仍能保持 minimal-like 轨迹（`let me=0`、`we` 主导）。该结论目前是单环境观察，尚未跑 Project2 V4.1b 计分。

## 发布 / 提 PR 前检查清单

- [x] 补 README：机制、与 Pristine / anchored-standard 的差异、安装方法。
- [x] 补许可证：每个 preset 子目录带 `LICENSE.deepseek-harness`（MIT）。
- [x] `replay.json` 隐私检查：无绝对路径、用户名、API key；**决定公开完整 COT**。
- [ ] 提 PR 前先看目标仓库 scope；不确定时先开 issue 说明设计再 PR。
- [ ] 证据口径写清楚：n=1 观察 ≠ 跨题普适；后续补一次 Project2 跑分作为硬证据。

## 相关评测上下文

- Project2 V4.1b：`modeltest` 本地评测套件
- anchored-standard 在 Project2 上：98 / 99，worst 98（见 modeltest 的 V4.1b 成绩榜）
- warmupbetter-replay：尚未进入 Project2 正式计分。
