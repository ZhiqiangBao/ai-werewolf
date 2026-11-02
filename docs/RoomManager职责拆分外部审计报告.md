# RoomManager 职责拆分外部审计报告

审计日期：2026-11-02。审阅方：Codex。本报告是对施工实现和验收记录的独立静态复核。

**结论：当前源码支持 ARCH-ROOM-MANAGER 的职责拆分结果；在本次审阅范围内，未发现需要重新打开该事项的拆分回归。** 建议保持已解决状态，后续观测能力建设以拆分后的服务为基础。这个结论针对代码结构和已检查的兼容路径，不等同于本轮重新执行了自动化验收。

## 审计范围与证据等级

- 拆分前基准：`ea8e7f7849553f9c5c718d00cb6947338072361f`。
- 实现提交：`4c39aa9`、`35a4e9a`、`eee4c1e`、`721fa8c`、`df52e31`；契约提交为 `0a7e536`。
- 本轮审阅版本：`08b1ed8`，其中最终代码实现为 `df52e31`。
- 范围：`packages/session/src/manager.ts` 及拆出的房间服务、相关存储与错误入口、增量回归源码、[职责拆分与兼容验收](RoomManager职责拆分与兼容验收.md)和[完成归档](已解决问题与已实现改进.md)。
- 工作区已有 `.gitignore` 修改，不属于本轮审计，不纳入结论或提交。

本轮进行了提交差异、源码路径和测试断言的静态核对，未执行测试、类型检查、构建或真实提供方调用，未读取真实房间与密钥。证据按以下等级解释：

| 等级 | 本报告采用的含义 |
| --- | --- |
| 源码确认 | 当前实现可直接支持该项结构或流程描述。 |
| 回归已定义 | 仓库已有对应测试及断言；本轮确认其存在和覆盖边界。 |
| 历史执行记录 | 施工文档记载当时通过，本轮没有重新执行或重新生成基准。 |

## 职责与兼容路径复核

| 审计项目 | 源码依据与结果 |
| --- | --- |
| 兼容入口 | [manager.ts](../packages/session/src/manager.ts) 保留原 24 个公开实例方法及同步／异步边界。配置与视图入口先经 Lobby 鉴权；行动和控制转交 Runtime；模型库仍由 `ModelLibrary` 承担。入口没有直接执行引擎或模型流程。 |
| 状态唯一性 | Manager 与 Runtime 引用同一份 `RoomRecord`，未复制第二份对局事实。运行状态在 Runtime，订阅和思考通知定时器在 View，保存定时器和审计编号在 Persistence。 |
| 字段归属 | [room-types.ts](../packages/session/src/room-types.ts) 为 28 个顶层字段登记所有权，使用 `satisfies Record<keyof RoomRecord, ...>` 约束穷尽性。`OwnedRoomRecord` 限制非所属顶层字段的替换；该约束为浅层只读，不能解释为嵌套对象不可修改或运行期隔离。施工文档已说明此边界。 |
| 依赖方向 | [room-runtime.ts](../packages/session/src/room-runtime.ts)、[room-lobby.ts](../packages/session/src/room-lobby.ts)、[room-view.ts](../packages/session/src/room-view.ts)、[room-persistence.ts](../packages/session/src/room-persistence.ts) 均不导入完整 Manager；跨职责调用通过构造时传入的窄端口连接。另有本地依赖图回归。 |
| 引擎提交与通知 | Runtime 的 `apply`、`changedState` 保持引擎提交→记录状态／事件／行动→更新截止时间→取消失效行动请求→安排保存→通知的顺序。旁听请求仍按既有规则排除在普通阶段切换取消之外。 |
| 思考更新 | 思考内容由 Runtime 写入；View 仅节流通知与安排保存。思考流不进入 `changedState`，不会因展示更新重新武装计时或取消在途请求。 |
| 暂停及旧结果 | `control`、`stopMatch`、`runAi`、`receive` 保留代数、决策和取消校验；暂停／结束的失效机制没有因拆分迁出协调边界。 |
| 投影与连接 | 凭证决定视角；私密思考按座位筛选。在线状态由该房间订阅集合推导；新订阅重新计算自己的签名后通知其他已建立连接，保留 SSE 响应头先行条件。 |
| 存储与退出 | `RoomStore` 和存档格式未修改；保存仍按 300ms 窗口合并，思考按 80ms 节流且结束立即通知。`dispose` 先停止 tick，再逐房间取消请求、清理思考通知定时器、同步保存，保留原有跨房间顺序。 |
| 导出与错误身份 | `manager.ts` 保留 `ApiFailure`、`ManagerOptions` 及 `actionLimitSec` 的兼容导出；`ApiFailure` 从同一模块重导出，保持 `instanceof` 身份。`actionLimitSec` 仍不是包根入口导出。 |

对 Runtime 与基准 Manager 的对应方法进行文本级比较，扣除保存／通知／审计端口转发、配置帮助函数和 `changedState` 名称变化后，下列 21 个方法的方法体一致：`actionCue`、`apply`、`armDeadlines`、`fallbackIfWaiting`、`finishThought`、`isHuman`、`markAsked`、`prepareWave`、`pump`、`pumpOnce`、`pushThought`、`receive`、`rememberReply`、`resumeAll`、`runAi`、`stopMatch`、`syncThread`、`threadFor`、`tick`、`turnHint`、`whenIdle`。

另外人工核对了 `start`、`act`、`control` 的入口拆分：鉴权、开局校验与返回视图移至兼容入口／Lobby，运行操作留在 Runtime；`live` 仅移走了其他服务拥有的状态。方法体相同能够支持迁移保守性的判断，不能代替运行时验证。

## 回归证据复核

| 证据 | 静态确认的覆盖 | 解释边界 |
| --- | --- | --- |
| [room-compatibility.test.ts](../packages/session/test/room-compatibility.test.ts) | 真人／AI × 新／旧计时共四组固定 SHA-256 摘要；AI 情景包含非法工具后的再次调用、请求、上下文、审计及完整模拟对局。 | 摘要常量及文档均指向 `ea8e7f7`；本轮未重新生成。摘要比较的是测试选择的字段，不是整个存档逐字节相同。真人情景为四次行动后结束；新计时情景将间隔设为零。 |
| [timing-boundaries.test.ts](../packages/session/test/timing-boundaries.test.ts) | 非零间隔、暂停／重载余量、迟到打断、暂停取消在途行动。 | 本次修改主要调整内部服务访问路径，相关原断言保留；弥补固定摘要中零间隔的范围限制。 |
| [runtime-races.test.ts](../packages/session/test/runtime-races.test.ts) | 超时与提交的两种顺序、自爆先于发言、重复自爆、暂停／恢复、重复推进及迟到结果。 | 覆盖有限的可控交错，不构成所有并发排列的形式证明。 |
| [room-services.test.ts](../packages/session/test/room-services.test.ts) | 保存合并与失败、审计编号和房间隔离、思考通知节流、错误构造器身份、思考不改在途行动时限。 | 这些是明确的功能断言，本轮只读检查。 |
| [room-disposal.test.ts](../packages/session/test/room-disposal.test.ts) | 开始取消下一房间请求之前，前一房间已经保存。 | 该测试直接证明的目标是跨房间退出顺序；不能将其扩写为全部后台任务均已完全停止。 |
| [room-boundaries.test.ts](../packages/session/test/room-boundaries.test.ts) | 当前本地静态导入图无反向依赖／循环，兼容入口不持有业务定时器或执行引擎／模型流程。 | 对当前源码结构有效，不是任意动态依赖的检查器。 |
| [protocol-session.test.ts](../packages/session/test/protocol-session.test.ts) | 三协议本机 HTTP 模拟、旁听／行动、无效工具纠错、原生工具回执与签名／加密推理、暂停重启、跨席隔离和行动去重。 | 模拟端点不提供真实外部厂商兼容性或性能证据。 |
| [human.test.ts](../packages/session/test/human.test.ts) 与 [human-http.test.ts](../apps/server/test/human-http.test.ts) | 多连接在线状态、准备状态、克隆凭证、旧档、授权投影及 HTTP/SSE 接入。 | 作为既有边界回归继续保留，本轮未运行。 |

施工记录声明：2026-11-02 在 `df52e31` 上，56 个测试文件、474 项测试以及类型检查、生产构建通过；受限环境失败后在允许相应文件与回环网络操作的环境中完成复验。本报告将这些数值保留为**历史执行记录**，不升级为独立复测结果。

## 审计判断与下一项衔接

1. **职责拆分已在源码落地。** 主要风险路径保留原有处理顺序，新增测试的实际断言与核心验收目标相符，支持维持原事项的已解决状态。
2. **所有权是协作与类型约束。** 浅层只读、有限竞态情景和固定摘要的覆盖范围应继续按上述边界理解，不能宣称深度不可变、穷尽并发验证或整个存档全字段等价。
3. **观测缺口属于下一项。** Runtime 仍有取消后的直接返回路径；现有审计主要按模型调用写入，不能据此完整统计底层 HTTP 尝试、取消、回退和整波等待。相关代码从旧 Manager 保守迁移，并非本次拆分新增的问题。统一归入 [ARCH-OBSERVABILITY](待解决问题.md#arch-observability补齐提供方延迟指标与双桌合成基线)，不另建重复待办。

下一项方案见 [ARCH-OBSERVABILITY 实施方案](ARCH-OBSERVABILITY实施方案.md)。活动状态仍以[待解决问题](待解决问题.md)为唯一入口。
