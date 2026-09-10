# 电脑控制 Mac 适配路线（computer-use）

当前 `A:\CodexData\tools\windows-computer-use\` 的桥是 Windows 专用（user32 + UIAutomation + PowerShell）。
MCP 服务器层（mcp-server.js）与路由注入层（lib/chatgpt-web-tools.mjs）均为跨平台设计，
Mac 适配只需实现一个等价的 macOS 桥并接入 `runBridge` 的平台分派。

## 桥需要实现的命令（与 Windows 版同名同参）

| 命令 | macOS 等价实现 |
| --- | --- |
| list-apps | `osascript -e 'tell app "System Events" to get name of every application process whose background only is false'` |
| get-app-state | System Events accessibility tree（AXUIElementCopyAttributeValue），元素中心坐标 + 角色标签 |
| screenshot-window | `screencapture -l <windowid> out.png`（需屏幕录制授权） |
| click | CGEvent（`CGEventCreateMouseEvent`）真实移动+点击；或 accessibility `AXPress` |
| type-text | CGEvent keyboard 逐键 / `osascript keystroke`（需辅助功能授权） |
| press-key | `key code` / CGEvent key combos |
| scroll | CGEvent scroll wheel |
| set-value | accessibility `AXValue` 设置 |
| focus | `NSRunningApplication.activate` / AppleScript `activate`（Mac 无前台锁问题，比 Windows 简单） |

## 授权前置（首次运行会弹）

- 系统设置 → 隐私与安全性 → **辅助功能**：勾选运行宿主（终端/Codex）
- 系统设置 → 隐私与安全性 → **屏幕录制**：同上

## 路由侧接入点

- `lib/chatgpt-web-tools.mjs`：`mergeContinuationMcpTools` 的目录注入与平台无关，无需改动
- 桥分派：`mcp-server.js` 的 `runBridge`（`process.platform === 'darwin'` 分支），实现 `scripts/mac-bridge.js`
- 桌面端注册：config.toml 的 `[mcp_servers.windows-computer-use]` 换成 mac 路径即可

## Windows 版本已修的坑（Mac 版对照注意）

1. 进程/窗口枚举要快（Windows 版 tasklist /v 曾 125s → 换 Get-Process 330ms）；Mac 用 System Events 或 NSWorkspace
2. 输出编码统一 UTF-8（PS1 中文乱码教训）
3. 前台切换：Mac 无前台锁，activate 即可；但辅助功能授权是硬前置
4. 坐标系：Mac 是全局坐标（原点左下）与 Windows（左上）不同，截图/点击换算要统一
