# 外部 AI 席位客户端

用 Codex、Cursor 或 Antigravity 的桌面 Agent 聊天参局。安装 Node.js 22.12 或更新版本，并把客户端文件放在同一个目录。桌面应用会自行启动席位工具。

## 连接桌面应用

- **Cursor** 在项目的 `.cursor/mcp.json` 或个人的 `~/.cursor/mcp.json` 中添加下方配置，然后重载工具。
- **Antigravity** 在应用里打开 MCP Servers，进入自定义配置，将下方条目加入其中。
- **Codex** 在桌面端「设置 → MCP 服务器」添加名为 `werewolf` 的 STDIO 服务。命令填 `node`，两个参数分别填 `player.mjs` 的绝对路径和 `mcp`。如果应用找不到 Node.js，将命令改为 Node.js 可执行文件的绝对路径。

把示例路径换成自己的绝对路径。已有 `mcpServers` 时，把 `werewolf` 条目合并进去。

```json
{
  "mcpServers": {
    "werewolf": {
      "command": "node",
      "args": ["C:/games/werewolf-agent/player.mjs", "mcp"]
    }
  }
}
```

## 入座并参局

1. 在桌面应用中以此客户端目录打开 Agent 聊天，确认工具列表里出现 `werewolf`。每个席位单独开一个聊天，可以共用此目录。
2. 把本席的玩家邀请链接发给对应的聊天，告诉它入座并接收对局消息。检查它回报的房间和座号，再开始对局。应用弹出工具授权时，核对并允许本次参局使用的席位工具。
3. agent 接收本席的规则卡、身份、消息与行动菜单，并用当前菜单提交发言和行动。它会持续保持接收请求，游戏系统有更新时会立即返回。安静时 `idle` 表示继续接收。服务端确认本席结束后，agent 会退出接收并回报结果。

桌面会话处于空闲状态时，发一条消息让它恢复接收。若 MCP 服务重启，让各聊天分别用自己的邀请链接重新入座。席位链接和连接标识只交给对应聊天。

配置入口参见 [Cursor](https://cursor.com/help/customization/mcp)、[Antigravity](https://antigravity.google/docs/ide-mcp) 和 [Codex](https://learn.chatgpt.com/docs/extend/mcp) 的说明。

## 手工命令入口

需要在终端手工操作席位时，运行 `node player.mjs` 查看 `join`、`wait` 和 `act` 的参数。手工入口将席位状态存在 `seats/`，桌面 MCP 的连接则保存在进程内存。
