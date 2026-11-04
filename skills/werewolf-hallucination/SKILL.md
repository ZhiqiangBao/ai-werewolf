---
name: werewolf-hallucination
description: 诊断本项目某局、某席的疑似幻觉：冻结调用现场、重放单次请求、对照系统提示词并报告证据。用于用户指出具体异常或要求验证提示词修改时；不把诈身份、错误站边或少量样本直接判为幻觉或规则缺陷。
---

# 对局幻觉检查

接手任务的 **agent** 负责取证、实验、判定和报告。用户指出疑似异常，提供无法从项目记录确定的规则预期，并决定是否改变玩法。目标是交付可追溯的现场、每次响应及有证据的处理结论；不是预设模型有错，也不是自动修改生产提示词。

首次验证程序时，直接从[合成材料验收](#用合成材料先验收程序)开始，无需真实房间或模型凭据。处理用户指出的对局异常时，再从下面的定位步骤开始。

## 先定位异常，写下判定依据

agent 在游戏仓库根目录工作，确认 Node.js 22.12 或更新版本及项目依赖可用。用户提到某局、某席或某段发言时，先从获授权的存档与审计定位 `roomId`、座位和审计 ID；缺少会改变定位或判定的材料时再询问。不要默认选择最新房间，也不要操作正在进行的对局。

沿着该席消息向前找首次错误，选择其产生前的调用。区分法官已确认事实、该席私密信息、玩家陈述、推测和策略性撒谎。公开发言与真实身份不符、没有透露查验、投错票，都不能单独证明幻觉；无法区分时保留不可判定。

agent 在本次忽略目录（例如 `data/diagnostics/hallucination/case-01-input/`）写 `rubric.json`，填写目标错误、合理输出范围、带来源的依据和不应误判的情形。格式见[输入与判定文件](references/files.md)。先核对用户已确认预期、本局配置、引擎执行及模型收到的说明；没有历史依据时不能用当前状态补成“当时事实”。

## 冻结后，检查是否可以重放

agent 把下面示例中的房间、审计 ID 和目录替换为定位结果，再在仓库根目录执行：

```powershell
node skills/werewolf-hallucination/scripts/run.mjs freeze --audit-file=data/rooms/ROOM_ID.audit.jsonl --audit=17 --room=ROOM_ID --case-id=case-01 --rubric=data/diagnostics/hallucination/case-01-input/rubric.json --output=data/diagnostics/hallucination/case-01
```

成功后查看输出的 `fidelity`、`ready`，并核对 `case.json` 的来源、消息和 `original-system.txt`。输出目录必须尚不存在；脚本不覆盖原现场。

| 反馈 | agent 的下一步 |
| --- | --- |
| `captured`、`ready: true` | 保存了适配器实际编码的请求，可继续重放；仍不能保证服务端逐字复现 |
| `incomplete`、`ready: false` | 旧审计缺少编码请求；保留现场，停止外发。按[旧审计处理](references/files.md#旧审计缺少编码请求)决定能否明确重建 |
| `reconstructed` | 输入由操作者重建；后续报告一直注明，不称为原请求复现 |
| `CASE_HASH_MISMATCH` | 现场已被改动；保留原件，找回正确副本或重新冻结，不手改哈希继续 |
| 找不到消息、记录不唯一 | 返回定位步骤，不从当前提示词或房间末态补造历史 |

现场只包含该席调用前的输入。原异常回复留在 `original` 中，脚本不会把它、判定卡或诊断结论加入被测请求。真实审计、原生续接数据和测试响应留在忽略目录，不提交 Git，不发给无授权的服务。

## 先重放一次，再比较候选提示词

agent 沿用会话已经授权的服务、模型和样本数。需要识别项目模型 ID 时执行 `models`；它只显示型号、路由主机和凭据是否可用，不显示密钥。真实外发前先生成计划，核对模型名单、调用数、输入范围和已有授权；只有缺少必要授权时才询问用户。

```powershell
node skills/werewolf-hallucination/scripts/run.mjs models
node skills/werewolf-hallucination/scripts/run.mjs replay --case=data/diagnostics/hallucination/case-01/case.json --models=MODEL_ID --output=data/diagnostics/hallucination/case-01-replay-plan
```

第二条命令只生成 `plan.json`，显示 `dryRun: true` 和计划 1 次调用。核对后，agent 用**新的输出目录**执行同一命令并加 `--live`。每次重放恰好一次 HTTP 请求，不自动重试、降级或执行游戏行动。`BINDING_MISMATCH` 表示路由、模型、协议或凭证不匹配；先核对选型，不静默切换。

要测其他模型时，agent 显式加 `--portable`。该模式只迁移语义消息和工具 Schema，去掉原模型的原生签名与推理块，并重新编码请求；首版不迁移无工具或 JSON 兼容请求。它测的是该语义上下文在目标模型上的表现，不能当作原生请求复现。

需要优化提示词时，agent 从 `original-system.txt` 复制出 `candidate.txt`，按本次假设修改，保持其完整内容。用户提供的修改也写入该文件。先记录改动位置、可能的误解、预期改善和可能影响的正常行为；不要把案例正确答案、玩家策略要求或新玩法写进候选。

```powershell
node skills/werewolf-hallucination/scripts/run.mjs compare --case=data/diagnostics/hallucination/case-01/case.json --models=MODEL_ID --candidate=data/diagnostics/hallucination/case-01-input/candidate.txt --repeats=3 --seed=7 --output=data/diagnostics/hallucination/case-01-compare-plan
```

核对 `planned: 6` 及两版系统块后，agent 用新目录添加 `--live`。跨模型时用逗号分隔明确选定的模型 ID，并加 `--portable`；调用数为模型数 × 两版 × 重复数。轮数在运行前固定，不因结果不合预期而不断补样。

脚本随机交错执行两组，保留消息顺序；每次只替换第一个系统块，其余请求不变。历史助手消息继续保留，所以结论只适用于当前节点。若旧历史已经包含错误，agent 另行定位更早的现场，不把本轮结果解释为整局改善。

运行时每完成一次就保存 `run.json` 并显示进度；结束后生成 `labels.json`、`blind-review.json` 和 `report-unreviewed.md`。未结束或进程中断时，先检查已有 `run.json`；首版不自动续跑，以免重复收费。请求失败也保留在结果里，不补成成功样本。

## 判定响应，交付处理结论

agent 按判定卡阅读 `blind-review.json`，先不看模型与版本对应关系，在 `labels.json` 中逐条填写判定和具体证据。完整响应能判定目标事实时标为 `pass` 或 `target_error`；只确认格式等其他错误、尚不能判定目标事实时标为 `other_error`；其余证据不足标为 `uncertain`。同时出现目标错误和其他错误时，标为 `target_error` 并记录两项证据。接口失败、超时和截断保留 `uncertain`，由报告另列。不要把“不确定”或“未回答”算作通过。字段含义见[输入与判定文件](references/files.md#响应标注)。

agent 再阅读实际版本和调用结果，写 `analysis.md`：说明现场完整性，逐项核对预期、规则、实现和传递内容，列出支持及反对本次归因的证据，指出样本与协议限制，并给出下一步。

| 已确认的证据 | 处理去向 |
| --- | --- |
| 本局规则与用户确认的预期不符 | 进入规则修改，保持旧局事实及版本兼容 |
| 规则正确，引擎或上下文传递不符 | 修复实现、投影、回执或协议链路 |
| 输入正确，提示表达或模型执行仍有问题 | 保留提示词候选，结合对照及独立案例回归判断；能力不足也可作为待验证原因 |
| 合理游戏行为或证据不足 | 排除误报或明确未能确认，不强行归因 |

多种原因可以并存。多个模型同错不是规则错误的证明；少量重复或没有复现，也不是问题已消失的证明。修改的采纳还要检查其他事实错误、行动可用性、超时和正常策略是否恶化；首版统计不自动采纳提示词。

```powershell
node skills/werewolf-hallucination/scripts/run.mjs report --case=data/diagnostics/hallucination/case-01/case.json --run=data/diagnostics/hallucination/case-01-compare/run.json --labels=data/diagnostics/hallucination/case-01-compare/labels.json --analysis=data/diagnostics/hallucination/case-01-input/analysis.md --output=data/diagnostics/hallucination/case-01-compare/report.md
```

完成标志是：现场哈希可校验，实际调用数与失败数清楚，每条标注有证据，报告包含归因及其限制、候选差异和下一步。agent 向用户交付这些文件与简短结论，明确哪些已验证、哪些仍待验证。只有本次授权包含实现修改时，才继续项目正常的修改、检查和 Git 交付流程。

## 用合成材料先验收程序

agent 在仓库根目录执行：

```powershell
node skills/werewolf-hallucination/scripts/run.mjs demo --output=data/diagnostics/hallucination/demo-01
```

输出应显示 `networkCalls: 0`，目录包含现场、候选、运行记录、标注和 `report.md`。夹具预设一条目标错误、一条正确响应、一条超时和一条其他错误，用于检查流程和分母，不能作为模型表现或提示词收益证据。

需要获授权的真实模型合成测试时，先用 `example --output=新目录` 生成记录员任务，再按上面的 `compare --portable` 测试。其正确记录是第 1 夜查验 1 号为狼人；该任务刻意不含参局欺骗目标。agent 应区分事实混淆、输出格式错误和服务失败，不把本案例频率推广为模型整体幻觉率。
