# 本地音频核对与 ASR 对比

> 公开版已将本机私有路径、真实房间标识及非必要的个人运行计数替换为通用说明；技术结论与必要测量数据保留。


更新：2026-11-03。本文保留首轮 0.6B/Q5 与在线接口的冻结样本对比；扩大为三语各 10 段的 Q5/Q8 数据见[量化对比记录](评估/Qwen3-ASR-1.7B量化对比.md)。当前本地选项改为 Q8，Q5 仅保留历史测试数据。差异不代表人工金标准准确率，也不改变逐段复核责任。

## 生产路由与自动工作流

- 当前视频 TTS 使用既有在线 Qwen Token Plan；本轮没有部署新的本地 TTS。TTS provider 与 ASR provider 是分开的配置。
- workflow 参数为 `--asr-provider=auto|local|qwen-token-plan|mimo-token-plan|off`、`--asr-aliases=FILE` 和可选 `--alignment-provider=qwen-token-plan`。默认 `off`，先核对原稿与 TTS 标签；显式 `auto` 才对中文、英语选择本地 Q8，对日语选择 Qwen Token Plan 在线识别。显式 `local` 或 MiMo 日语请求会失败，不会静默改路由。
- 工作流先生成音频并做 waveform 检查，在明确启用时运行独立 ASR 复核，再完成完整音频/字幕时间审计，最后进入 timeline。英语、日语的 Qwen 同一次真实响应词边界通过逐字内容、时间、音频与稿件绑定检查时，自动复用该响应建立 sidecar，不多发识别请求。英语若选本地或 MiMo 且词时间不可用或不可靠，必须明确指定 `--alignment-provider=qwen-token-plan`，否则以 `alignment-required` 失败。中文暂不支持外部词边界导入，原 TTS 字时不可靠时在额外云请求前停止，不发送无效补对齐请求。
- ASR 成功结果缓存按输入音频、provider、模型和设置绑定。差异报告为 `needs-review`；workflow 不自动改写原稿。默认或显式 `off` 会在状态报告中记为 `not-checked-explicitly-disabled`，跳过语义核对但仍执行完整时间审计，不能声称 ASR 通过。
- `--prepare-only` 与 `--check-only` 分别停在 plan 与 preflight，不会启动本地 ASR daemon。选择本地路由后，daemon 仅在 workflow 到达 review-audio 阶段时按需启动。完整操作命令见 [本地 ASR 操作指南](../skills/werewolf-video/references/local-asr.md)。

## 冻结样本

证据保存在被忽略的数据目录 `data/asr-benchmark/20261103-0.6b`。三条输入都转为相同的 16 kHz、单声道 PCM16 WAV，并以自动识别、不带原稿提示或热词进行比较：

| 语言与素材 | 时长 | 原稿长度 | 比较单位 |
| --- | ---: | ---: | ---: |
| 中文真实语音，房间 `ROOM_ID_REDACTED_B`、seq27、片段 `027-1` | 18.923 秒 | 92 字符 | 82 |
| 英语真实发言节选，房间 `ROOM_ID_REDACTED_C` | 16.96 秒 | 43 词 | 46 |
| 日语干净样片，房间 `ROOM_ID_REDACTED_D`、seq32 | 38.8 秒 | 227 字符 | 209 |

“差异单位”是识别文本与预期稿件规范化对照后的差异计数，不是人工金标准 WER，也不能单独证明音频实际逐字无误。首轮云端对比共五次请求：中文 Qwen 与 MiMo 均为 0/82，英语两者均为 0/46，日语 Qwen 为 0/209。另有独立的 MiMo 日语实验，单列如下，不并入生产路由评估。

| 方案 | 中文 | 英语 | 日语历史测试（非生产） | 模型加载 | 首次推理 | 暖机中位数 zh/en/ja | 整卡峰值 |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| Qwen3-ASR-0.6B Transformers/CUDA | 1/82 | 0/46 | 12/209 | 13.075 秒 | 19.55 秒 | 1.947 / 1.807 / 5.166 秒 | 2738 MiB |
| Qwen3-ASR-1.7B Q5_K_M GGUF/Vulkan | 1/82 | 0/46 | 8/209 | 2.928 秒 | 17.66 秒 | 0.714 / 0.670 / 1.601 秒 | 2027 MiB |

暖机中位数各来自三次复测；加载和首次推理为各自的一次测量。两套都检出污染语音负例，静音负例返回空文本。中文和英语通过本样本的数量门槛，中文的“上警→上井”等差异仍需逐段审核；日语两套均未通过相对在线基准的门槛，且不改变“日语生产走在线 Qwen”的规则。两方案的模型、量化、运行时和后端同时变化，因此只能比较这两套完整方案，不能把差异归因于单一因素。

## 独立 MiMo 日语实验

对 seq32 日语样片单独调用 MiMo Token Plan，模型为 `mimo-v2.5-asr`；未提供原稿提示或热词。单次用时 11.170 秒。采用已批准别名映射后，差异为 29/209（13.88%）；不采用别名时为 33/209（15.79%）。这是单条样本、单次请求，不能据此判断稳定性或替代生产路线。用户要求日语生产继续只用在线 Qwen，MiMo 结果保留为独立实验。原始证据：`data/asr-benchmark/20261103-0.6b/ja-mimo-experimental.json`。

## 日语后训练 Q5 一次性实验（权重已删除）

同一条 seq32、38.8 秒音频以自动识别且不提供原稿提示运行。历史 checkpoint 为 `mradermacher/Qwen3-ASR-1.7B-JA-Anime-Galgame-GGUF`，来源微调模型为 `jaykwok/Qwen3-ASR-1.7B-JA-Anime-Galgame`，revision `3d6194e06fae19863f5327550779cde737e66a66`；量化 Q5_K_M，runtime 为 `llama.cpp 0.7.0-dev build 396`、commit `7879491`。这与上表的 `transcribe.cpp` 路径使用不同 runtime，不能作单一变量性能归因。

首次有效识别为 4.7248651 秒：原始对照 26/227，规范化后 13/209，套用冻结的 3 条别名后 6/209（2.87%）。仍有专名/术语差异，例如“警長→警庁”“立候補→力候補”及英语词 `vote` 被识为“冒頭”，所以该结果不是逐字通过。早期 `scores.json` 的第 2–4 轮使用了 521/522 个缓存输入 token，不能并入独立暖机统计。之后 `no-cache-1..4.json` 四次请求均为无原稿提示、`cached_tokens=0` 且转写相同；这组独立重测不改变首次无提示评分结论。

模型当时下载到 `[本机模型目录已脱敏]`；主 Q5 文件与 Q8_0 多模态投影文件下载后 SHA 校验通过。按用户决定，专用目录（含清单）共 1,613,587,526 字节已删除；评分与请求记录仍保留在 `data/asr-benchmark/20261103-0.6b/ja-posttrained/`，当前不能再将该 checkpoint 列为可用本地模型。此番实验只供历史对比，日语生产仍固定走在线 Qwen。

## 本地调用范围内的离线观察

`data/asr-benchmark/20261103-0.6b/offline-proof/` 留有中文与英语各一次真实本地请求的记录、进程连接采样与 Python socket guard 探测。采样窗口中对目标进程做了 16 次连接观察，均为 loopback；Python socket guard 拒绝了 4 次探测。此结果只涵盖 Python socket/DNS 调用和本次采样窗口，不是操作系统级断网证明，也不覆盖原生库的网络调用。默认路由下的日语 Qwen 在线请求不属于这项离线观察的范围。

## 模型与运行环境摘要

- 官方 Transformers 模型：`Qwen/Qwen3-ASR-0.6B-hf`，revision `7f1569a48a89f3e3f4dc3a5c9d28bddd903bc76c`，权重文件 1,564,928,088 字节，SHA-256 `d3f212dd20abecd315d830bc54ae3865e56ebfc3276484e57b771288ba27fd35`。
- 社区转换模型：`handy-computer/Qwen3-ASR-1.7B-gguf`，revision `0e0a596e3959c3f3f2ab7d443a5b6f0f4a4bba6f`，基座 `Qwen/Qwen3-ASR-1.7B`，量化格式 Q5_K_M；文件 1,517,290,464 字节，SHA-256 `034c557fe92ff8fcd9a9c041cbdaad347be0a86a58d3a348f63cf3f0180879d0`。这是社区 GGUF 转换，不能称为官方量化。
- 实测设备为 RTX 5060 Laptop 8 GB、24 GB RAM、i5-13500HX。运行时为 `transcribe.cpp` v0.4.1：Windows CPU+Vulkan 原生包 18,052,295 字节，SHA-256 `272eb97795048ccb557c85bb9dd44c9e530e1c928443114c39816a8a5f76269d`；纯 Python ctypes binding wheel 47,639 字节，SHA-256 `f373b6e20a4d897ed0dcaa2fe7fae183379777432b3a76641c42506c77b442ad`。GGUF 路径不需要 PyTorch。

通用模型 manifest 位于 `[本机模型目录已脱敏]`；详细操作、缓存和 sidecar 导入见 [本地 ASR 操作指南](../skills/werewolf-video/references/local-asr.md)。每次 workflow 的实际 provider、识别/对齐请求数、失败片段及语义状态以该次生成的 `workflow-status.json` 和 ASR report 为准。

## 首轮实现验证记录（提交 a93910a）

2026-11-03，隔离工作区最终单 worker 回归共 125 文件、979 项全部通过，TypeScript 检查和网页生产构建通过。最初默认并发耗尽 Windows 内存，第二次低并发仍有一处测试配置断言与 CPU 编码内存失败；修正测试中 Python 配置覆盖并按单 worker 完整重跑后通过，没有通过延长超时或放宽门禁掩盖失败。

Astra 独立复现并复核五项边界修复：对齐异常强制失败；数字小数点/负号不混同；明确截断的响应拒绝导入；两家云端缓存正文/截断与原始响应保持一致；中文不支持补对齐时在额外云请求前失败。坏缓存不自动重发。新日语真实样品在这组修复后再次禁用识别请求复核，仍为 `matching`、`cached=true`，使用已有真实对齐。

技能 bundle 为 v12，含 48 个 pipeline 文件；ZIP 共 75 文件，完整性及与目录逐文件字节一致性已核对。机器可读回归报告保存在忽略目录 `data/media-work/asr-japanese/data/asr-final-tests.json`；真实样品、离线观察及冻结基准保留在前述各证据目录。这些结论不包括新本地 TTS、声线身份审核或真实整局一键制作。
