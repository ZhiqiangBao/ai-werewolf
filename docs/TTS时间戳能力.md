# TTS 时间戳能力核对

查询日期：2026-11-02。这里比较的是服务接口是否返回与生成音频对应的实际时间信息；返回格式、支持模型和音色需要逐项核对，不以同属 TTS 推断兼容。

| 服务 | 时间信息 | 如何启用／限制 |
| --- | --- | --- |
| Qwen-Audio-TTS | 字级时间戳，句事件中包含 `sentence.words` | `word_timestamp_enabled: true`，默认关闭，仅流式输出支持；还需使用支持时间戳的模型／音色。[官方参数说明](https://platform.qianwenai.com/docs/api-reference/speech-synthesis/qwen-audio-tts/http-python-sdk) |
| 豆包语音 | 字／词时间戳 | 双向流式 V3 使用 `req_params.audio_params.enable_timestamp: true`，在句结束事件返回；HTTP/SSE 接口的部分新模型使用 `enable_subtitle`，受模型、语种和文本形式限制，不能混用参数。[双向流式](https://docs.volcengine.com/docs/doubao-voice/websocket-bidirectional-streaming-v3?lang=zh)、[HTTP/SSE](https://docs.volcengine.com/docs/doubao-voice/http-chunked-sse-unidirectional-streaming-v3?lang=zh) |
| ElevenLabs | 字符开始／结束时间数组（秒） | 使用专门的 `/v1/text-to-speech/{voice_id}/with-timestamps`，响应包含音频和 `alignment`；也提供流式时间戳入口。[官方接口](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps) |
| Azure Speech | 单词边界、音频偏移和持续时间、原文位置 | Speech SDK 订阅 `WordBoundary`，音频偏移使用 100ns tick，接入时转换单位；不是普通音频 HTTP 响应直接带 JSON。[官方事件类型](https://learn.microsoft.com/en-us/dotnet/api/microsoft.cognitiveservices.speech.speechsynthesiswordboundaryeventargs?view=azure-dotnet) |
| Google Cloud TTS | 输入中指定标记的位置（秒） | 在 SSML 插入 `<mark>`，启用 `SSML_MARK`；不是自动为原文每个字／词返回完整时间范围。[官方说明](https://docs.cloud.google.com/text-to-speech/docs/ssml#ssml_timepoints) |
| 小米 MiMo V2.5 TTS | 当前公开协议未提供字词时间戳 | 请求体没有时间戳开关；普通和流式音频字段中 `transcript` 当前仅为 `null`。`created` 是创建时间，`expires_at` 是过期时间，均不定位音频中的字词。[官方 API](https://mimo.mi.com/docs/zh-CN/api/audio/tts) |

## 本项目的 Qwen 已经开启

`packages/session/src/speech/qwen.ts` 当前通过专用 `SpeechSynthesizer` HTTP 接口发送 `input.word_timestamp_enabled: true`，并设置 `X-DashScope-SSE: enable` 读取服务端返回的句事件和字词时间。

因此，Qwen 是**接口原生提供、需要显式启用**，不是默认每次都返回；本项目已经设置，无需再接一个 ASR 服务生成时间戳。这里的“原生”指合成接口直接交付，不能据此推断提供方内部采用何种算法。不同 SDK 的参数位置以对应文档为准，不把本项目 HTTP 的字段位置照搬到 WebSocket 或 SDK。

时间轴仍核对实际 WAV 长度和时间戳标签；标签可能存在同音字或文字归一化差异，字幕正文继续以审核原稿为准。声称支持时间戳也不代表所有音色都支持，或可以免除字幕核对。

## 小米的开发联调结果

使用用户已授权的 Token Plan 凭据，仅发送短合成测试句：

- 普通 WAV 请求：HTTP 200，音频有效，返回 `id/data/expires_at/transcript`。
- 顶层额外添加 `word_timestamp_enabled: true`：HTTP 200，音频有效，仍无字词时间戳。
- 相同参数并设置 `stream: true`、`audio.format: "pcm16"`：HTTP 200，正常返回音频块并以 `stop` 结束，没有时间戳或对齐字段。

这说明当前测试接口接受未知参数但没有给出目标能力；并非证明所有未公开参数都已穷尽。结合官方请求和响应定义，本项目仅将 MiMo 接入网页朗读，视频 skill 继续使用已有 Qwen 路线。上述其他服务只完成文档核对，本次没有新增其适配器或调用账号。
