# dsh-preset-reference

两个可安装的 DeepSeek Harness agent preset，给每个新会话加一个纯 Minimal 的 warmup 轮，避免首个模型请求被 AGENTS.md/CLAUDE.md 和 skill 注入污染。

## 包含的 preset

| Preset | 说明 | 适用场景 |
|---|---|---|
| `warmupbetter` | 首轮由真实模型生成一次长 COT 热身，随后恢复正常任务 | 希望每次热身内容都新鲜生成 |
| `warmupbetter-replay` | 首轮重放一段预录制的 COT + 回复，不调用模型，随后恢复正常任务 | **推荐**：首轮固定、省一次调用、轨迹锚定稳定 |

推荐默认使用 `warmupbetter-replay`。它重放的 COT 和回复来自一次真实的 Warmup Better 会话，保存在 `warmupbetter-replay/replay.json`，完全公开；已在复杂 AGENTS.md/skill 注入下保持 minimal-like 轨迹（当前为单环境观察，尚未跑正式 benchmark）。

## 安装

```powershell
.\install-presets.ps1                          # 安装两个
.\install-presets.ps1 -Presets warmupbetter-replay
```

脚本会把 preset 复制到 `%USERPROFILE%\.dsh\.agent-presets\`，已存在同名目录时跳过、不覆盖。安装后重启 dsh，新建 session 并选择对应 preset。

## 工作机制

- 第一轮：固定 Minimal system prompt，只暴露两个工具（Windows 为 `pwsh` + `str_replace_editor`）；真实用户输入顺延到下一轮。
- 第二轮起：真实模型 + 完整 Standard 工具目录 + 正常上下文注入。

## 参考与许可

- Pristine 思路参考 [YeEeck/dsh-pristine](https://github.com/YeEeck/dsh-pristine)。
- Anchored Standard 思路参考 [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)。
- 基于 DeepSeek Harness 的 Standard/Minimal preset 修改，MIT 许可（各子目录内含 `LICENSE.deepseek-harness`）。
