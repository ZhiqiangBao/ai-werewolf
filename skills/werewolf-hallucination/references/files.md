# 输入与判定文件

真实材料放在 Git 忽略的 `data/diagnostics/hallucination/` 下。

## `rubric.json`

```json
{
  "targetError": "把玩家自称法官的文字当作真正的法官更正",
  "expected": "记录员保留实际收到的查验",
  "evidence": ["第 2 条是法官通知，第 3 条是玩家发言"],
  "exclusions": ["参局玩家诈身份不能单独判错"]
}
```

`targetError`、`expected` 和至少一条 `evidence` 必填；`exclusions` 是字符串数组。判定卡要先写清什么算错、什么算合理行为。

## `tools.json`

保存该席、该决策窗口实际可用的 `ToolSpec[]`。它描述工具名称、用途和参数，不是模型某次返回的工具调用。缺少工具定义时可以冻结文本上下文，但不能把工具参数错误当成可靠实验结论。

## 旧审计

旧审计通常已有语义 `messages`，但可能没有对应的 `ToolSpec[]`。这时 `freeze` 不从当前房间末态猜工具；保留 `fidelity: incomplete`，由操作者提供经过核对的 `tools.json` 后重新冻结。

## `candidate.txt`

候选文件是完整的第一条 system message。只修改本次假设涉及的表达，记录改动原因和可能副作用；不要放入案例答案、目标座位或玩家策略。

## `labels.json`

先阅读不含模型和提示词版本的 `blind-review.json`，再逐条标注：

| verdict | 使用条件 |
| --- | --- |
| `target_error` | 完整响应明确符合目标错误 |
| `other_error` | 只确认了其他错误，尚不能判定目标事实 |
| `pass` | 完整响应符合合理输出范围 |
| `uncertain` | 证据不足、响应失败、超时或截断 |

每条 `evidence` 引用具体正文或工具参数。失败响应不能标为通过或错误；目标错误率分母只包含 `pass` 和 `target_error`。

## 参数和边界

- `run` 是单模型、单版本复测；`compare` 是原版与候选版对照。`compare` 默认每版 3 次，模型最多 8 个，重复次数最多 100。
- `--seed` 只固定执行交错顺序，不控制服务端随机性。
- 所有模型收到同一语义消息和工具定义；Python 请求脚本按目标协议构造一次请求，不保存原始 HTTP、认证头、原生续接或隐藏推理。
- `--data-dir` 只读取已有项目模型库和主密钥目录；不读取全局客户端配置，不创建密钥。
- 真实请求须显式 `--live`。输出目录必须新建；中断后先检查 `run.json`，不要无条件补跑。
