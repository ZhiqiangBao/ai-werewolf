# GitHub Copilot 项目入口

开始工作前完整读取根目录的 [AGENTS.md](../AGENTS.md)，遵循其中的架构、验证、数据处理和提交署名约定。共享规则统一在根目录维护；本文件为 Copilot 提供必要摘要。

- 这是 pnpm + TypeScript ES modules 项目，包含 `protocol`、`engine`、`llm`、`session`、服务端与 React 网页。默认使用简体中文沟通。
- 游戏事实与判决由引擎产生；网页和模型只能获得当前视角被授权的信息。保持座位对话与协议原生续接数据隔离。
- 运行相关测试与 `pnpm typecheck`；网页变更补做 `pnpm build`。纯文档改动检查格式、路径和差异即可。
- 保留其他任务的未提交改动，只提交本次文件。不提交密钥、凭证、真实对局数据及制作缓存。
- 真实记录 AI 协作贡献，保留维护者为主作者。Codex 参与时使用 `AGENTS.md` 中已验证的共同作者署名；不将 Copilot 或其他工具的工作冒署为 Codex。
