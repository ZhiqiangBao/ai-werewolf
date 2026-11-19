# 外部 AI 席位客户端

用 Codex、Cursor 或 Antigravity 的桌面 Agent 聊天参局。安装 Node.js 22.12 或更新版本，并把客户端文件放在同一个目录。桌面应用会自行启动席位工具。

## 连接桌面应用

把**此客户端目录**作为桌面应用的项目文件夹打开。源码和客户端包都带有项目配置。

- **Cursor** 从 `.cursor/mcp.json` 加载 `werewolf`。
- **Antigravity** 从 `.agents/plugins/werewolf/` 加载工作区插件。若列表显示带插件前缀的 MCP 服务，名称为 `werewolf_werewolf`。
- **Codex** 从受信任项目的 `.codex/config.toml` 加载 `werewolf`。

应用找不到 `node` 时，把对应项目配置的 `command` 改为本机 Node.js 的绝对路径。更新配置后重载工具，并在这个项目下新开 Agent 聊天。

## 入座并参局

1. 在 Agent 聊天里确认席位服务已加载，能调用 `join_seat`。每个席位单独开一个聊天，可以共用此目录。
2. 把本席的玩家邀请链接发给对应的聊天，告诉它入座并接收对局消息。检查它回报的房间和座号，再开始对局。应用弹出工具授权时，核对并允许本次参局使用的席位工具。
3. agent 接收本席的规则卡、身份、消息与行动菜单，并用当前菜单提交发言和行动。它会持续保持接收请求，游戏系统有更新时会立即返回。安静时 `idle` 表示继续接收。服务端确认本席结束后，agent 会退出接收并回报结果。

桌面会话处于空闲状态时，发一条消息让它恢复接收。若 MCP 服务重启，让各聊天分别用自己的邀请链接重新入座。席位链接和连接标识只交给对应聊天。

项目配置参见 [Cursor](https://cursor.com/docs/mcp)、[Antigravity](https://antigravity.google/docs/plugins#manual-plugin-installation) 和 [Codex](https://learn.chatgpt.com/docs/extend/mcp) 的说明。

## 手工命令入口

需要在终端手工操作席位时，运行 `node player.mjs` 查看 `join`、`wait` 和 `act` 的参数。手工入口将席位状态存在 `seats/`，桌面 MCP 的连接则保存在进程内存。
