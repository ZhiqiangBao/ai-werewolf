---
name: werewolf-hallucination
description: 诊断本项目某局、某席的疑似模型幻觉：冻结模型可见的语义上下文，向选定模型重复测试，并比较原系统提示词与候选提示词。用于用户指出具体异常或要求验证提示词修改时；不把诈身份、策略性撒谎或少量样本直接判为幻觉。
---

# 对局幻觉检查

agent 负责取证、实验、人工标注和报告。用户提供无法从记录确定的规则预期，并决定是否修改玩法或提示词。实验对象始终是模型可见的 `messages`、工具定义和指定模型配置；脚本不保存或重放原始 HTTP 请求、原生续接、隐藏推理或认证头。

首次验收直接执行“合成案例”步骤；真实问题从“冻结现场”开始。

## 冻结现场

先从授权的房间审计定位房间、座位、首次出现异常的调用和异常前的消息。区分法官事实、私密信息、玩家陈述、推测和策略性撒谎。公开发言与真实身份不符不等于幻觉；无法区分时标为不可判定。

准备 `rubric.json`，填写目标错误、合理输出范围、带来源的依据和排除情形。还要准备该席在该调用实际可用的 `tools.json`；它应来自对应投影或审计材料，不要从当前房间末态猜测。

```powershell
node skills/werewolf-hallucination/scripts/run.mjs freeze --audit-file=data/rooms/ROOM_ID.audit.jsonl --audit=17 --room=ROOM_ID --case-id=case-01 --rubric=data/diagnostics/hallucination/case-01-input/rubric.json --tools-file=data/diagnostics/hallucination/case-01-input/tools.json --output=data/diagnostics/hallucination/case-01
```

完成后核对 `case.json`、`messages.json`、`tools.json` 和 `fidelity`。`captured` 表示消息和工具都已冻结；`incomplete` 只允许做文本上下文检查，不能可靠评估工具参数。输出目录必须不存在，脚本不会覆盖原材料。

原异常回复只保存在 `case.json` 的 `original` 字段，不会进入测试消息。现场哈希变化时停止并重新冻结，不手改哈希。

## 设计并执行实验

实验固定以下项目：同一份语义消息、同一份工具定义、同一个目标模型、同一组生成参数、同一张判定卡。唯一自变量是第一条 `system` message 的内容。原版和候选版按固定种子交错执行，避免一组总在另一组之后运行。

先列出模型，脚本只显示项目模型库中的型号、协议和凭据是否存在：

```powershell
node skills/werewolf-hallucination/scripts/run.mjs models
```

单模型单次复测：

```powershell
node skills/werewolf-hallucination/scripts/run.mjs run --case=data/diagnostics/hallucination/case-01/case.json --models=MODEL_ID --output=data/diagnostics/hallucination/case-01-run
```

命令默认只生成计划，不发送请求。核对模型、消息范围和调用数后，在新目录加 `--live`。它通过一个独立的 Python 请求脚本发送一次语义请求，按模型协议返回正文和工具调用；不重试、不切换模型、不执行游戏行动。

原版与候选版对照：

```powershell
node skills/werewolf-hallucination/scripts/run.mjs compare --case=data/diagnostics/hallucination/case-01/case.json --models=MODEL_A,MODEL_B --candidate=data/diagnostics/hallucination/case-01-input/candidate.txt --repeats=3 --seed=7 --output=data/diagnostics/hallucination/case-01-compare
```

核对计划后在新目录加 `--live`。调用数是模型数 × 两个提示词版本 × 重复次数。多个模型都接收同一语义上下文；各自的协议转换只是发送手段，不是实验变量。候选文件只能描述要验证的通用澄清，不能写入本案例答案或策略要求。

每个响应返回后必须立即记录，再发出下一次请求。脚本会在运行目录创建 `trial-records.jsonl`，每条结果一行，包含 `caseHash`、试验 ID、模型目标、`original`/`candidate` 版本、重复编号、输入哈希、状态、输出、失败类型、耗时和 `reviewStatus: pending`；不写入请求正文、消息、工具定义、密钥或原生续接数据。`run.json` 仍是汇总状态，但不能代替这份逐条日志。中断时先核对 `trial-records.jsonl` 行数、`run.json.trials.length` 和 `blind-review.json`，不得用新请求覆盖未核对的结果目录；缺失响应标为失败或未判定，不补写模型输出。

多模型实验要在同一冻结案例上同时列出所有目标模型，并在结果表中按“模型 × 提示词版本”分别统计完整响应数、目标错误数、通过数和失败数。跨轮次或跨版本比较前，先记录每一轮的候选文本哈希、模型清单、重复次数和固定种子；分母只包含已完成人工标注的完整响应，不能把失败请求当成通过，也不能把不同样本量的原始计数直接比较。

运行结束后先逐条阅读 `trial-records.jsonl` 和 `blind-review.json`，再填写 `labels.json`；完成标注后运行 `summary`，把目标错误、通过、失败、未判定及候选相对原版的错误率变化保存为结构化 `improvement.json`，再查看 `run.json` 中的模型和版本信息。每一轮实验都必须保留自己的 `trial-records.jsonl`、`labels.json` 和 `improvement.json`，不能只在最终报告里口头汇总。报告前核对逐条日志行数等于已记录试验数，并把每轮实验数据汇总到比较表。中断时不要盲目补跑，先确认已记录试验和服务端状态。

标注后生成改善记录：

```powershell
node skills/werewolf-hallucination/scripts/run.mjs summary --case=data/diagnostics/hallucination/case-01/case.json --run=data/diagnostics/hallucination/case-01-compare/run.json --labels=data/diagnostics/hallucination/case-01-compare/labels.json --output=data/diagnostics/hallucination/case-01-compare/improvement-final.json
```

## 标注与报告

完整响应按判定卡标记：

- `pass`：符合合理输出范围；
- `target_error`：明确出现目标错误；
- `other_error`：只确认了其他错误，尚不能判定目标事实；
- `uncertain`：证据不足、响应失败或无法判断。

每条标注引用具体正文或工具参数。失败、超时和截断不算通过，也不进入目标错误率分母。`report` 会列出试验数、完整响应、失败、其他错误、不可判定和 Wilson 区间；区间只描述这组冻结上下文的重复采样。

```powershell
node skills/werewolf-hallucination/scripts/run.mjs report --case=data/diagnostics/hallucination/case-01/case.json --run=data/diagnostics/hallucination/case-01-compare/run.json --labels=data/diagnostics/hallucination/case-01-compare/labels.json --analysis=data/diagnostics/hallucination/case-01-input/analysis.md --output=data/diagnostics/hallucination/case-01-compare/report.md
```

报告只给出证据和范围，不自动归因或采纳候选提示词。继续核对用户预期、本局规则、引擎执行、消息来源和模型输入，再决定进入规则修订、实现修复、提示词优化或误报排除。

## 合成案例

```powershell
node skills/werewolf-hallucination/scripts/run.mjs demo --output=data/diagnostics/hallucination/demo-01
```

成功反馈包含 `synthetic: true`、`networkCalls: 0`，目录有现场、候选、运行记录、盲审材料、标注和报告。夹具覆盖通过、目标错误、其他错误和超时，只验证流程，不代表任何模型的幻觉率。
