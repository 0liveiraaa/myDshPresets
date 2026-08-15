# dsh-preset-reference

两个可安装的 DeepSeek Harness agent preset，给每个新会话加一个纯 Minimal 的 warmup 轮，避免首个模型请求被 AGENTS.md/CLAUDE.md 和 skill 注入污染。

## 包含的 preset

| Preset | 说明 | 适用场景 |
|---|---|---|
| `warmupbetter` | 首轮由真实模型生成一次长 COT 热身，随后恢复正常任务 | 希望每次热身内容都新鲜生成,**使用deepseek官方接口的用户使用该项** |
| `warmupbetter-replay` | 首轮重放一段预录制的 COT + 回复，不调用模型，随后恢复正常任务 | **OPENCODE用户推荐**：首轮固定、省一次调用、轨迹锚定稳定 |

推荐默认使用 `warmupbetter-replay`。它重放的 COT 和回复来自一次真实的 Warmup Better 会话，保存在 `warmupbetter-replay/replay.json`，完全公开；已在复杂 AGENTS.md/skill 注入下保持 minimal-like 轨迹（当前为单环境观察，尚未跑正式 benchmark）。

## 安装
**如果存在兼容性问题,可以直接打开deepseek创造模式安装**

```powershell
.\install-presets.ps1                          # 安装两个
.\install-presets.ps1 -Presets warmupbetter-replay
.\install-presets.ps1 -Update                  # 更新已安装的版本（覆盖前自动备份）
```

脚本会把 preset 复制到 `%USERPROFILE%\.dsh\.agent-presets\`。已存在同名目录时默认跳过、不覆盖；`-Update` 会先把旧目录备份到 `%USERPROFILE%\.dsh\.agent-presets-backup\`，再覆盖源文件。安装后重启 dsh，新建 session 并选择对应 preset。

## 升级已安装版本并修复旧会话

在 `c844c2c` 之前安装过 preset 的用户：旧版本注入的 warmup 消息缺 `id`，会导致**已经产生的会话历史无法加载**。更新 preset 只对之后的新会话生效，旧会话日志需要离线回填。请按顺序操作：

1. **完全退出 dsh**（会话日志正在被追加时不能改写）。
2. 备份会话数据：

   ```powershell
   Copy-Item -Recurse "$env:DSH_HOME\sessions" "$env:DSH_HOME\sessions.backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
   ```

   如果 `$env:DSH_HOME` 为空，把路径换成 `$HOME\.dsh`。
3. 更新 preset 文件并重启前先修复历史：

   ```powershell
   .\install-presets.ps1 -Update
   node .\repair-warmup-sessions.mjs --dry-run   # 先看会修哪些会话，只读
   node .\repair-warmup-sessions.mjs             # 实际回填缺失的 id（每个日志旁留 .bak）
   ```

   自定义 DSH home 时给修复脚本传 `--root`，例如 `node .\repair-warmup-sessions.mjs --root D:\other-dsh-home`。
4. 重启 dsh，打开旧的 warmupbetter / warmupbetter-replay 会话验证历史能正常加载；新建会话检查首个 warmup `user/message` 已带 `id`。

修复脚本只改一种记录：`user/message` 中 `source.kind === 'plugin'` 且 `source.plugin` 为 `warmup-replay` / `warmup-tool-bootstrap`、同时 `data.id` 缺失或为空的 warmup 消息，给它补一个 UUID；其余字节保持原样。若 dsh 侧仍显示旧缓存（通常不会），可删除 `$env:DSH_HOME\storages\session_projcache.json` 让其重建。

## 工作机制

- 第一轮：固定 Minimal system prompt，只暴露两个工具（Windows 为 `pwsh` + `str_replace_editor`）；激活模型正确思维链, 用以锚定之后的策略选择路径, 真实用户输入顺延到下一轮。
- 第二轮起：真实模型 + 完整 Standard 工具目录 + 正常上下文注入。

## 参考与许可

- Pristine 思路参考 [YeEeck/dsh-pristine](https://github.com/YeEeck/dsh-pristine)。
- Anchored Standard 思路参考 [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)。
- 基于 DeepSeek Harness 的 Standard/Minimal preset 修改，MIT 许可（各子目录内含 `LICENSE.deepseek-harness`）。
