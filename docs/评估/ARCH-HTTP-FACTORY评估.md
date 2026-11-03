# ARCH-HTTP-FACTORY 评估

评估日期：2026-11-03

## 结论与范围

可行。生产 HTTP 路由和实例状态已从入口提取到 `apps/server/src/http-server.ts` 的 `createHttpServer`。调用方注入 `RoomManager`、语音服务、语音连接和网页目录；存储通过构造 `RoomManager` 注入，测试使用相互独立的 `MemoryStore`。这次保留原有路由分支和错误处理，没有引入路由框架或改变协议。

工厂创建独立的 HTTP server、SSE 连接集合、停止标志和前端引用，不读取环境变量、不获取数据租约、不监听、不注册进程信号，也不恢复房间。`main.ts` 仍负责生产依赖、租约、Vite、监听、恢复房间和进程退出。工厂的 `close` 复用既有 `shutdownResources` 顺序，返回同一个关闭结果；生产入口传入租约释放函数与宽限时间。调用方负责对已经创建的实例调用 `close`，并只为同一个实例设置其前端。

## 验证

- 新增 `http-factory.test.ts`，使用本机临时端口和合成内存房间，验证两个实例的存储、静态页面、前端关闭和 SSE 订阅隔离；验证客户端断开或服务关闭时各取消订阅一次、清除 ping，关闭 SSE，重复关闭复用结果。
- 覆盖空请求体、恰好 1,000,000 字节、1,000,001 字节、损坏 JSON、数组和 `null`；上传中断后服务仍可处理请求，关闭期间读完请求体返回 503。验证 Authorization 优先于查询参数、导出响应头及邀请网络接口。导出内容使用合成替身，仅验证路由与响应格式。
- `shutdown.test.ts`、`shutdown-integration.test.ts`、`invite-network.test.ts` 及 `human-http.test.ts` 在本机合成环境执行通过；后者覆盖现有真人 HTTP/SSE 和语音接口的本地测试替身。未调用真实模型或外部服务。
- 工作区 TypeScript 类型检查通过。受运行环境限制，默认进程无法连接本机临时端口；HTTP 测试在获准的本机执行环境运行。直接调用已安装的 Vitest 和 TypeScript，与项目脚本对应；默认 `pnpm` 入口因 Corepack 无法联网获取版本而不可用。

本评估验证依赖注入及既有行为回归，不代表对所有网络故障、性能负载、生产部署或外部语音服务的完整验证。
