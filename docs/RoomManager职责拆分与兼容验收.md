# RoomManager 职责拆分与兼容验收

## 基准范围

本文记录 `packages/session/src/manager.ts` 在基准提交 `ea8e7f7849553f9c5c718d00cb6947338072361f` 的职责与兼容契约，供拆分实施和后续验收使用。审计时 `manager.ts`、`store.ts` 及本文件映射到的会话测试相对该基准无差异。

本文只描述拆分前契约，不记录拆分已通过或已完成。拆分后应依据本文逐项补记实现位置、验证结果及差异。

## 导出与公开入口

`packages/session/src/index.ts` 将 `RoomManager`、`ApiFailure`、`ManagerOptions` 作为包入口导出。`actionLimitSec` 是 `manager.ts` 的具名导出，但当前没有从 `index.ts` 转出。拆分需要维持包入口的既有导出与 `RoomManager` 方法签名/行为；内部服务可以新增模块，不要求作为包 API 导出。

| 模块导出 | 同步性 | 兼容边界 |
| --- | --- | --- |
| `ApiFailure` | 同步类 | 保留 `status`、`code` 和错误消息字段，供 HTTP 层映射错误。 |
| `ManagerOptions` | 类型 | 保留依赖和可选运行参数，见“装配字段”。 |
| `RoomManager` | 同步构造 | 保留现有门面和下表全部方法。 |
| `actionLimitSec(stepType, fallback)` | 同步函数，仅 `manager.ts` 直接导出 | 发言/wolf discuss 为 180 秒、放逐/警长投票为 90 秒，其余回退到传入值；不是 `@werewolf/session` 包入口导出。 |

| 原入口 | 同步性 | 建议归属 | 兼容边界 |
| --- | --- | --- | --- |
| `constructor(options)` | 同步 | `RoomManager` 装配 | 读取 `store.loadAll()`；补齐旧存档的 `heardSeq`、`threads`；建立每房间 Live；按 `tickMs` 启动并 `unref` 周期计时器。 |
| `resumeAll()` | 同步启动、后台推进 | Runtime | 对运行中的房间重装截止时间并启动 pump；不等待模型调用完成。 |
| `dispose()` | 同步 | `RoomManager` 协调 Runtime 与保存组件 | 停止周期计时器、取消在途请求、清理思考通知计时器并同步 flush 所有房间。 |
| `catalog()` | 同步 | Lobby／配置查询 | 返回引擎目录与 `STYLES`。 |
| `modelPresets()` | 同步 | Lobby／模型库 | 返回不含密钥明文的模型视图。 |
| `importLegacyModels()` | 同步 | Lobby／模型库 | 显式一次性导入；返回导入数量。 |
| `addModel(body)` / `deleteModel(id)` | 同步 | Lobby／模型库 | 校验和错误包装为 `ApiFailure(400, 'BAD_REQUEST', ...)`；模型库自身持久化。 |
| `createRoom(input?)` | 同步 | `RoomManager` 房间生命周期 | 校验风格与语言；创建全新房间和凭证；将初始记录写入 store 后返回 `roomId` 与 `hostToken`。 |
| `cloneRoom(roomId, tok)` | 同步 | `RoomManager` 房间生命周期，配置委托 Lobby | 仅房主可克隆；复制规则、计时及座位配置（含密钥密文），重新生成房间和座位凭证，清空候场状态；保存最终克隆记录。 |
| `getSetup(roomId, tok)` | 同步 | Lobby | 房主鉴权；构造设置视图，掩去密钥明文。 |
| `updateSetup(roomId, tok, input)` | 同步 | Lobby | 只允许 setup 状态；校验规则、语言、版型、计时、座位设置；按现有条件撤销真人准备；变更后进入统一 `changed` 顺序。 |
| `testSeat(roomId, tok, seat)` | **异步** | Lobby／模型连接检查 | 房主鉴权；mock 不联网；其他适配器异步测试连接并脱敏错误。 |
| `start(roomId, tok)` | 同步返回设置视图；异步启动 Runtime | `RoomManager` 生命周期到 Runtime 的转接 | 房主鉴权、setup 校验、创建引擎初态、切换 running、清空旧上下文/计时状态，先 `changed` 后触发不等待的 pump。 |
| `control(roomId, tok, action)` | 同步返回 `RoomBrief`；可能异步推进 | Runtime | pause/resume/step/end；暂停取消请求并冻结剩余时间；结束作废代数并停止推进；非 end 操作在 `changed` 后启动 pump。 |
| `participate(roomId, tok, input)` | 同步返回 `ViewResponse` | Lobby | 仅真人座位凭证可接入本人座位；只可在 setup 修改本人昵称/准备；保存变更并返回该凭证的视图。 |
| `view(roomId, tok)` | 同步 | View | 凭证决定 host/seat/spectator 投影，附加死因展示和可用时间；不得先泄露上帝投影再由调用方隐藏。 |
| `speechLocale(roomId, tok)` / `speechText(roomId, tok, seq)` | 同步 | View | 依凭证校验并按其投影取可朗读的已提交发言；私密或非 speech 事件不可读。 |
| `act(roomId, tok, body)` | 同步返回结果；可能异步推进 | Runtime | 只允许当前真人座位凭证、运行中且未暂停时提交；须带 decision ID 和参数对象；提交后触发 pump，但不等待。 |
| `subscribe(roomId, tok, send)` | 同步返回取消订阅函数 | View | 订阅者按自身视角签名变化通知；建立/取消连接也更新在线状态。 |
| `audit(roomId, tok)` | 同步 | 保存／审计组件 | 房主鉴权后读取该房间审计记录。 |
| `exportRecord(roomId, tok, kind)` | 同步 | View／导出 | god 仅房主可取；public 房主可在终局前导出，其他视角须等终局。 |
| `tick()` | 同步检查；超时后触发异步推进 | Runtime | 只处理运行中、未暂停、当前 pending 的房间；到点执行引擎托管行动并触发 pump。 |
| `whenIdle(roomId)` | **异步** | Runtime | 等待该房间当前 pump；房间不存在时直接完成。 |

表中的“建议归属”按目标服务拆分方案归类。兼容外观仍由 `RoomManager` 保留并将调用转交给所属服务。

## 状态字段所有权

所有权指业务写入与不变量的维护责任。`RoomStore` 负责序列化和持久化，不因此取得房间字段的业务所有权。View 读取并投影状态，不应写入对局事实。

### `RoomRecord`

| 字段 | 拆分后所有者 | 字段用途与当前约束 |
| --- | --- | --- |
| `id` | RoomManager 生命周期 | 房间标识；关联 Live、store 文件和审计文件。 |
| `createdAt` | RoomManager 生命周期 | 建房时间戳。 |
| `avatarStyle` | Lobby | 房间人物风格；仅 setup 可改。 |
| `locale` | Lobby | setup 语言；运行时以 `rules.locale` 为准，旧记录可缺省。 |
| `hostToken`, `spectatorToken`, `seatTokens` | Lobby 凭证 | 房主、旁观、各座位凭证；clone 时全部换新。 |
| `participants` | Lobby | 真人 `joined` / `ready` 候场记录；旧房间可缺省。在线状态不落在此字段。 |
| `status` | 生命周期／Runtime | setup→running→ended；Runtime 负责开局后推进与结束状态，Lobby 仅据此拒绝已开局配置写入。 |
| `paused` | Runtime | 对局暂停门闩；pause/resume/end 和推进错误路径修改。 |
| `presetId`, `ruleValues` | Lobby | 版型与可编辑规则选项。 |
| `timing`, `humanTimeoutSec`, `aiPacingMs` | Lobby 写入，Runtime 消费 | 新计时配置与旧客户端兼容字段；旧记录可能没有 `timing`。 |
| `seats` | Lobby | `SeatRecord[]` 座位/模型配置；Runtime 只读取控制者、适配器和请求参数。开局时座位昵称用于建立引擎状态。 |
| `seed`, `rules`, `state`, `events`, `actions` | Runtime | 引擎事实与已提交输入；由开局、`submit`、结束流局等流程维护。View 只按凭证投影。 |
| `deadlines`, `actionAvailableAt`, `actionGateRemainingMs`, `deadlineRemainingMs` | Runtime | 行动截止、推进间隔及暂停期间剩余时间；须随暂停、恢复、重载保持现有语义。 |
| `thoughts` | Runtime 写入；View 只读 | 模型思考/工具外正文的持久化记录；不能写入对局事件或其他座位提示词。旧房间可缺省。 |
| `threads` | Runtime | 每座位独立模型上下文和消息同步进度；旁听/行动回复都留在对应座位。旧房间可缺省。FileStore 将其写入座位分文件。 |
| `heardSeq` | Runtime | 已广播给其他座位的最后一条发言序号；旧存档缺省时从 `events` 最大 `seq` 推导。 |

`seats[]` 中 `SeatRecord` 的完整字段如下。字段除 `apiKeyEnc`、`apiKeyMask` 外均来自 `SeatConfigView`（其中 `apiKeyMasked` 是接口字段名，不是存档字段）：

| `seats[]` 字段 | 所有者 | 说明 |
| --- | --- | --- |
| `seat`, `name`, `nameSource` | Lobby | 座号、昵称和默认/自定义来源；`nameSource` 可缺省以兼容旧房间。 |
| `controller`, `adapter`, `apiProtocol`, `baseUrl`, `model`, `modelId` | Lobby | 真人/AI、适配器与模型连接配置；协议/模型 ID 对旧记录可缺省。 |
| `temperature`, `style`, `persona`, `toolMode`, `timeoutSec`, `maxOutputTokens`, `thinkingMode` | Lobby | 模型生成配置；可选字段按旧存档兼容规则推导默认值。 |
| `apiKeyEnc`, `apiKeyMask` | Lobby／凭证安全 | 密钥密文与掩码；不得将明文写入 RoomRecord、API 视图或审计。 |

### 原 `Live`

| 字段 | 拆分后所有者 | 字段用途与当前约束 |
| --- | --- | --- |
| `rec` | RoomManager 注册表保存的房间引用 | 对应持久化 `RoomRecord`；字段写入责任按上表分给具体服务。 |
| `running`, `again`, `stepBudget`, `gatePausedAt`, `gen`, `inflight` | Runtime | pump 串行化/重跑标记、单步预算、暂停间隔锚点、失效代数和可取消请求。结束或暂停时递增代数/取消请求，迟到结果不得提交。 |
| `subscribers` | View | 该房间按凭证解析后的订阅者集合；参与真人在线状态计算。 |
| `thoughtTimer`, `thoughtNotifiedAt` | View 通知 | 合并思考流更新，默认最多每 80ms 通知一次；最终思考状态立即通知。 |
| `saveTimer` | 保存组件 | 300ms 合并 RoomRecord 保存；`flush` 取消挂起定时器并同步保存。 |
| `auditId` | 保存／审计组件 | 首次写审计时从已有审计条数初始化，之后逐条递增。 |

### `RoomManager` 装配字段

`rooms` 是房间注册表，由兼容门面/生命周期持有；`store` 和 `secrets` 是共享依赖，由构造器注入相应服务；`now`、`sleep`、`adapters`、周期 `timer` 属 Runtime 注入/运行依赖；`models`（`ModelLibrary`）属于 Lobby 模型配置。拆分时保留 `ManagerOptions` 的现有字段和默认值：`store`、`secrets`、可选 `now`、`sleep`、`adapters`、`tickMs`、`modelsPath`。

## 保存、通知与计时顺序

### 记录变更

常规状态变更走 `changed(live)`，顺序为：

1. `armDeadlines(live, false)` 更新行动截止时间。
2. 按当前 pending 决策清理已过期的在途行动；`:hear:` 旁听请求不会仅因行动决策改变而取消。
3. `scheduleSave(live)` 注册 300ms 的合并保存（已有计时器则复用）。
4. `notify(live)` 逐个计算视角签名，只通知签名变化的订阅者；发送异常会移除对应订阅。

创建新房间立即 `flush`；克隆先建立默认房间、再覆盖复制配置并再次 `flush`。思考流通知使用独立的 RoomRecord 保存计时：普通增量节流到 80ms，最终状态立即安排保存并通知。`flush` 同步调用 `store.save` 并捕获记录保存错误。审计由 `appendAudit` 独立立即追加，不等待房间的 300ms 保存。

`apply` 先调用引擎 `submit`，再写回 `state`、追加 `events`/`actions`、更新 ended 状态和推进间隔，最后调用 `changed`。新决策的 `actionAvailableAt` 是从上一决策的步骤类型读取间隔。RoomRecord 的普通保存因 `changed` 延迟合并；上下文同步和 wave 准备过程也会安排保存，不能丢失 `threads` 或 `heardSeq`。

### 行动与模型时序

- `start` 完成状态初始化后先 `changed`，后启动 fire-and-forget `pump`；`control` 的非 end 分支和 `act` 在状态/行动提交后也按此顺序触发 pump。调用方不等待模型网络请求。
- pump 同一房间只运行一个 `running` promise；并发触发置 `again`，当前轮结束后重新检查。每轮先遵守 `actionAvailableAt`，准备可见消息/行动 wave，然后对同 wave 的 AI 行动和旁听以 `Promise.all` 并行执行。
- `prepareWave` 把新事件同步到各自 `SeatThread` 后更新 `heardSeq` 并安排保存；只有问话已进入该模型座位上下文、`readyToAct` 成立后，才由 `runAi` 标记行动开始并设置模型截止时间。真人截止在等待行动时设置；AI 排队、旁听和展示间隔不占用其行动时限。
- AI 请求回调的流式思考只更新对应 `Thought` 并触发节流通知；有效行动通过 `apply` 进入引擎。回答、失败轮次及工具回执写入该座位线程；审计编号按顺序追加。结束、暂停或决策变化后，generation 与 `AbortController` 检查阻止迟到结果提交。
- `tick` 同步检查当前截止时间；到期后以引擎托管行动提交，随后异步触发 pump。暂停期间不 tick。resume 要恢复间隔与各座位剩余时间，不能重置为完整时限。
- `control('end')` 先作废 generation、取消请求并清理运行时门闩，再经外层 `changed` 保存和通知；不得执行常规胜负结算或提前公开身份。

## 现有测试映射

以下是拆分前已经覆盖相关契约的主要测试；一个测试可能覆盖多个入口。该表是覆盖导航，不代表拆分后的测试已执行或通过。

| 职责／入口 | 现有测试位置与覆盖点 |
| --- | --- |
| 模拟对局、基本鉴权、视角隔离、密钥保存、模型调度、订阅、思考、房间克隆、结束流局、审计和导出 | `packages/session/test/session.test.ts`：整局模拟；凭证/投影边界；请求超时、失败重试和托管；暂停/单步；视角签名通知；思考显示；取消请求；clone 配置与换凭证。 |
| 真人候场、凭证、候场重置、在线通知、重连、真人行动与朗读 | `packages/session/test/human.test.ts`：真人进入/准备校验；改规则撤销准备；多连接在线通知；重启在线状态清空；运行中重接入；speech 按当前视角读；真实人类 act。 |
| deadline、行动间隔、暂停/恢复、单步、重载剩余时间 | `packages/session/test/timing-boundaries.test.ts`；`packages/session/test/locale-timing-presentation.test.ts`。 |
| 座位上下文、问话和许可顺序、旧线程恢复、旁听与行动互不串扰、重试回执、模型计时起点 | `packages/session/test/context-control.test.ts`；`packages/session/test/message-regression.test.ts`。 |
| 语言/计时、clone 与持久化、投影展示边界 | `packages/session/test/locale-timing-presentation.test.ts`。 |
| 真人候场、旧记录兼容、clone 清空候场、在线/准备的存档边界 | `packages/session/test/human.test.ts`。 |
| 昵称字段、默认昵称来源和旧存档迁移 | `packages/session/test/avatar-names.test.ts`。 |
| 文件存储、座位线程分文件、旧嵌入式线程读取 | `packages/session/test/store.test.ts`。 |
| 项目模型库与旧模型迁移、增删、模型选择、克隆和重载 | `packages/session/test/qwen-presets.test.ts`；`packages/session/test/protocol-config.test.ts`。 |
| 多协议旁听/行动、暂停重启和上下文/行动不重复 | `packages/session/test/protocol-session.test.ts`。 |
| 启动恢复与旧记录 pending 消息状态 | `packages/session/test/message-regression.test.ts`。 |

拆分后至少应按职责逐项运行并记录上述覆盖；如抽出的服务改变持久化、上下文顺序、取消边界、在线签名或计时锚点，应补充针对该边界的回归用例。
