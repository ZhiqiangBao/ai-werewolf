# 自动化程序的结构与扩展

程序源码随技能保存在 `assets/pipeline/`，与目标仓库的 `scripts/video/` 同一结构。美术资源在 `assets/art/`。`bootstrap.mjs` 复制缺失文件，并只补齐 package.json 缺失的依赖与命令；已有实现保留。它依赖该游戏仓库的导出模块和 Qwen 配置读取器，不能直接套到不同日志格式。

## 运行环境

使用目标项目的 Node/tsx 和锁文件；本次验证为 Node 24.18。需要 FFmpeg / FFprobe 在 PATH 中，也可设置 `FFMPEG_PATH`、`FFPROBE_PATH`。画面依赖 `@napi-rs/canvas@0.1.100`，缺少时通过目标项目的包管理器安装。

Windows 读取微软雅黑字体。其他系统应在 `scene.ts` 的字体注册处适配实际安装的中文字体，再看抽帧，不能只凭程序退出成功判断文字正确。

## 文件分工

| 程序 | 输入 → 输出 |
| --- | --- |
| workflow.ts | 最新已结束房间/指定 ID → 有状态的全流程 |
| prepare.ts / narration.ts | 原始剪辑稿 → 旁白取舍、声音表、plan.json |
| editorial.ts | 按 sourceSeq 应用法官编辑，保护玩家原话和完整事实 |
| qwen.ts / synthesize.ts | 文本+声音 → WAV、逐字时间戳、缓存 |
| project.ts | 路径、类型、原文分段、号码读法 |
| audio.ts / timeline.ts | 实际 PCM → 规范音轨、字幕、绝对帧时间轴 |
| replay.ts | 真实事实前缀 → 当前存活、身份、警徽、竞选、胜负 |
| scene.ts | 纯回放状态+已有素材 → 一段场景底图 |
| render.ts | 底图+真实配音+字幕 → 分段视频、章节、整局 |
| preview.ts | 已完成片段 → 非连续预览和四类抽帧 |
| verify.ts | 源记录+成片 → 原话、事实、媒体时长核对 |
| metrics.ts | 运行中的编码 → 整卡资源采样 |
| compress.ts | 完整母版 → 独立的 H.264 分享版 |

`workflow.ts` 用参数数组启动子进程，设置 cwd 和本次房间环境变量，不拼接 shell 字符串。每个阶段成功后写检查点；出错停止，保留前面产物。新程序也应保持这个接口，方便低成本模型直接运行而不重新手写整套流程。

## 核心数据契约

```typescript
// 源事实不受法官删句影响。
type Fact = { sourceSeq: number; day: number; phase: string;
  type: string; audience: 'public' | number[]; data: Record<string, unknown> };

// 玩家语音片段保留源事件和原文；朗读文本另存。
type Clip = { id: string; sourceSeq: number; voiceKey: string; seat?: number;
  text: string; spokenText: string; part: number; parts: number; audioFile: string };

// 以实际声音长度驱动时间，动画使用局部时间。
type TimedClip = Clip & { startFrame: number; frames: number;
  audioDuration: number; captions: {text: string; start: number; end: number}[] };
```

24kHz / 30fps 对应每帧 800 个样本。用真实样本数加编辑停顿后向上补齐整帧，把补齐的静音写进主音轨。这样逐段拼接不会累计音画误差。

## Qwen 适配器要点

- Token Plan 端点：`https://token-plan.maas.qianwenaiapi.com/api/v1/services/audio/tts/SpeechSynthesizer`。
- 当前已验证模型 `qwen-audio-3.0-tts-plus`，凭据须为已授权的套餐密钥；不自动换标准计费 Key。
- 请求使用 `input.instruction`（单数）、`word_timestamp_enabled: true` 和 SSE。音色必须属于当前模型。
- SSE 按空行分事件，不按每一行独立 JSON 解析；实际响应可包含多行 JSON。收集句子、字词时间和完成事件，完成后下载完整 WAV。
- 下载媒体时不向存储域名转发 API Key；不把带签名 URL、音频 base64 或密钥打印到上下文。
- 提供方 WAV 可能保留流式长度头。读实际 PCM，再写规范头和实际长度，避免编码器误报损坏或时长。
- 缓存键包括模型、原朗读文本、音色、指令、语速、采样率、种子。音频和元数据完整一致才复用，临时文件成功后原子重命名。
- 鉴权、额度、429 等停止批次；普通片段失败有限次重试。恢复时重新运行同一命令，只补缺失片段。

官方接口与模型变化时查 [Token Plan 接入](https://platform.qianwenai.com/docs/token-plan/best-practices/multimodal-generation)、[TTS API](https://platform.qianwenai.com/docs/api-reference/speech-synthesis/qwen-audio-tts/http-api)、[音色清单](https://platform.qianwenai.com/docs/developer-guides/speech/voice-list/qwen-audio-tts)。无需每次重新抓取几百个音色；预置音色有效时直接复用。

## 渲染与恢复

用现有背景、透明桌面和 4×3 人物图集构建场景；人物、号码、昵称、身份与状态分层。画面不连接实时房间，不提交游戏行动。发言波形来自实际音轨，不用任意循环冒充声音强弱。

一段底图只绘制一次，FFmpeg 循环底图，叠加真实声波和精确字幕。每段视频固定同一分辨率、帧率与像素格式，全部合并后再给主音轨编码 AAC，避免每段音频编码延迟累积。

缓存要关联底图、字幕、配音缓存键、编码参数和帧数。改一个声音或一条法官话，仅重做相关片段与最终合并；不重新运行游戏。

## 增加功能时如何测试

先验证纯逻辑，再跑真实小片段，最后走整局：

1. 分段后原文完整；数字发音变换不改变座位和票数。
2. 时间轴严格连续；字幕来自真实时间戳，范围落在声音长度内。
3. 回放前缀不包含未来死亡；守中、平安夜、猎人开枪、自爆、白痴翻牌与警徽流失语义正确。
4. 所有玩家选段对应原文；完整模式必须保留全部玩家条目。
5. 源事实完全不变，终局存活与记录复盘一致。
6. FFprobe 检查分辨率、帧数、章节和音画时长；抽看夜间、票型、发言与终局，并实际播放音频。

不要为了测试而重新发整局 TTS。可用已缓存项目完整复跑验证断点；为新日志格式写小型事件夹具。未经验证的新角色事件应停止并扩展回放器，不能悄悄把状态猜出来。
