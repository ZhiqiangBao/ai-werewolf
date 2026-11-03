# 真实对局 TTS 样品记录

更新：2026-11-03。此处只记录选中的真实公开发言样品，不包含整局旁白验收。真实原文不在文档重复，完整素材和报告保存在忽略的数据目录。

## 当前反馈与验收边界

用户已授权我们使用真实对局原话与指定 TTS 声线进行抽样。用户反馈英语语种没有问题；日语语种确认、字母大致确认。该反馈不等于用户确认了声线，也不代替逐字核对。声线身份、发音和样品范围按授权抽查，不写成用户已确认声线。

当前视频 TTS 均使用既有在线 Qwen Token Plan；本轮不部署新的本地 TTS。中文/英语本地选项仅属于 ASR 核对，不能解释为本地 TTS。

ASR 独立转写、时间轴映射、画面字幕抽查和听感验收分开记录。服务响应中的 word 标签只表明服务返回了词与时间，不能证明成片实际逐字符合原稿。下述自动转写及文件绑定证据不代表人工听审通过，也不代表整局制作完成。

## 英语样品

- 来源：真实房间 `9a68e390d2`，seq33、seat6，完整公开发言、5 段。
- 声线：Olivia Lin，`qwen-audio-3.0-tts-plus-loongolivialin`；服务商 Qwen Token Plan，模型 `qwen-audio-3.0-tts-plus`。
- 成片：72.233333 秒、2167 帧、5,728,760 字节、1920×1080 H.264，音画时长差 0.001 秒，45 条字幕。
- 素材目录：`data/video/9a68e390d2/real-tts-en`。
- 用户确认英语表达没问题。此记录不等于声线身份已获用户确认，也不扩展为整局旁白验收。

## 日语样品

- 来源：真实房间 `db43517aa0`，seq32、seat3，完整公开发言，原文 227 字符。
- 声线：男声 `qwen-audio-3.0-tts-plus-longchengtaohui`；服务商 Qwen Token Plan，模型 `qwen-audio-3.0-tts-plus`。
- 成片：39.6 秒、1188 帧、2,789,392 字节、1080p H.264，音画差 0 秒；由 ASR 时间映射生成 12 条字幕。
- 既有固定样品复用 38.8 秒干净 WAV，音频字节保持不变；使用日语语言提示，去掉会被朗读的 instruction 字段，没有重新合成。独立转写产生了 hash 绑定的词级对齐 sidecar，字幕原文映射校验通过；这些是自动核对证据，不是人工听审。
- 既有成片路径：`data/video/db43517aa0/real-tts-ja-fixed-20261103/output/latest-match.mp4`。
- 视觉抽查覆盖全部 12 条字幕锚点及片头 5 秒内 4 个位置。音频 master 与 AAC 解码样本在 0–5、17–22、34–38.8 秒的相关系数为 0.9994、0.99976、0.99936，最佳 lag 均为 0。主代理需按最终验收流程填写独立 ASR 完整对照与听审状态；不得把这些声学指标写成语义正确。
- 早期 `real-tts-ja-seq32` 样片曾在开头读出较长 instruction 内容，原成片内容验收已撤销并保留为失败历史。它与当前保留的 `real-tts-ja-fixed-20261103` 样片是不同产物。
- 另一个 `seq38` 样片的问题是发言内部出现较长停顿；三次 seed 修复尝试未解决。不要把 seq38 的停顿问题误记成 instruction 读入。

自动验证脚本中的 `audioSemanticReview` 与 `voiceIdentityReview` 仍为 `not-checked`。用户的语种反馈、独立 ASR 对照、字幕画面抽查和音频相关性各自有明确范围；只有完整证据补齐后，才能更新样品验收状态。

## 新 workflow 样品的逐阶段实测

新样品的逐阶段验收报告为 `data/video/db43517aa0/real-tts-ja-workflow-20261103/output/workflow-stage-acceptance.json`，成片为 `data/video/db43517aa0/real-tts-ja-workflow-20261103/output/latest-match.mp4`。报告明确标注 `scope=separate stages; full workflow not executed`：这是按阶段运行的验收，不能写成完整一键 workflow 已执行。

- 第一次 Qwen ASR 请求未提供原稿提示，计 1 次真实 ASR 请求；初次比较为 `needs-review`。随后使用批准的 3 条别名映射在禁止 fetch 的情况下续跑，识别缓存命中、ASR 请求数为 0，状态为 `matching`；同一响应生成 130 词的独立 Qwen 时间映射。总计 1 次 ASR、0 次 TTS 请求。
- `audit-audio`、`timeline`、NVENC render 与 `verify-sample` 阶段均通过。成片 39.6 秒、1080p、12 条字幕，音画时长差 0 秒。
- 报告的 `semanticReview` 是 `independent-transcript-with-approved-aliases`；`voiceIdentityReview` 仍为 `not-checked`。这表示有独立 ASR 与白名单别名范围内的自动文本检查，不表示人工听审或声线身份已确认。
- 原 `real-tts-ja-fixed-20261103` 样片、干净 WAV 以及先前的视觉与 AAC 抽查证据继续保留；新旧产物分别记录，不用其中一份代替另一份验收。

## 范围限制

成片只复用所选完整公开发言和对应声线，没有添加自由解说；它是样品，不是整局旁白。日语生产 ASR 路由按当前用户约定使用在线 Qwen。任何本地日语 ASR 结果都只能作为单独实验记录，不能成为生产预筛或自动选择的一部分。英语与日语的语种反馈均不作为用户声线确认。
