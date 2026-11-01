# 批量 TTS：调用现有服务与扩展制作程序

适用于多人物、多片段配音。以下把通用批量机制和服务商协议分开：现有程序内置 Qwen Token Plan；其他 TTS 通过显式适配器接入，不会因为配置失败而自动更换服务或计费线路。这里的接口说明不是额外的外发授权，调用范围仍以用户已有授权为准。

## 先确定输入与交付契约

保留原始文字与实际朗读文字两份。按原事件顺序分句，每段固定 `id`、`sourceSeq`、`voiceKey` 和 `spokenText`；多角色逐段合成，不把全桌对白一次交给一个声音。分段长度遵守所选服务的请求上限，在句末拆分；新段不能丢字、重复或倒序。

`voices.json` 保存本次使用的 `model` 和 `profiles`。每个 profile 的格式：

```json
{
  "voice": "该服务实际支持的音色 ID",
  "label": "角色标签",
  "rate": 1,
  "instruction": "与角色相符的发音和表达要求"
}
```

`voice`、语速范围、指令能力和模型是否匹配，需要按服务商文档和实际样音核对；不要直接把 Qwen 的音色 ID 发到其他服务。克隆音色必须使用已获授权的声音，不能因为切换服务就默认获得权限。

统一交付为每段一个 **24kHz、单声道、16-bit PCM WAV**，以及 `同名.wav.json`。不是 WAV 的响应应先解码、重采样，再读取实际 PCM 长度。不能把 MP3 或裸 PCM 改扩展名当作 WAV。

## 直接使用当前 Qwen 批量工具

准备并审核剪辑稿和声音表后，在仓库根目录运行：

```powershell
pnpm video:make --room=ID --through=tts --resume
```

完整工作流会先准备剪辑稿，再只合成缺失或缓存过期的片段。已有项目单独补音频可运行：

```powershell
$env:VIDEO_ROOM = '房间ID'
$env:VIDEO_VOICES_FILE = '对应项目的 voices.json 绝对路径'
$env:VIDEO_NARRATION_FILE = '对应项目的 narration.json 绝对路径'
node node_modules/tsx/dist/cli.mjs scripts/video/synthesize.ts
```

只合成已经准备好的样品清单时，先设置独立的 `VIDEO_PROJECT_DIR`，再运行 `synthesize.ts --prepared-clips`。它读取该目录现有的 `source.json`、`script.json`、`clips.json`、`voices.json`，不会重新生成整局清单。不要手工删掉成功的音频以“从头再试”。

需要先查看实际外发清单时，运行 `synthesize.ts --plan-only`；它先做原话/行动来源校验，再保存本局 `source.json`、`script.json`、`clips.json` 和声音表，不调用服务。根据完整请求缓存键区分复用与新增台词；若新增内容超出现有外发授权，只列新增部分供用户审阅。

同一对局从样品扩展为整片时，可把 `VIDEO_AUDIO_CACHE_DIRS` 设为已有音频目录绝对路径的 JSON 数组，例如 `'["D:/项目/data/video/ROOM/audio","D:/项目/data/video/ROOM/sample/audio"]'`。内置 Qwen 适配器在发请求前按完整缓存键查找，检查字节数与 WAV 头，复用音频和真实时间戳；不能仅凭文字相同而复用另一角色声音。其他 TTS 适配器可在计算自己的完整请求键后调用 `audio-cache.ts` 的 `reuseAudio`，不同服务/端点须进入键中。

Qwen Token Plan 特例：

- 保留 `qwen-token-plan` 路由和现有 Token Plan 端点；凭据由内存中的环境或获准配置读取，不落入项目、脚本或日志。
- 当前内置模型为 `qwen-audio-3.0-tts-plus`。使用 `input.instruction`、`word_timestamp_enabled: true` 和 SSE；语音、时间戳与结束事件都完成后才写成功缓存。
- SSE 事件按空行分块；同一事件可能有多行 JSON。最终 WAV 可能带流式长度头，应按真实 PCM 字节数重写规范头。
- 下载服务返回的音频 URL 时，不向存储域名转发服务商 API Key，不打印带签名 URL。
- 鉴权、额度、限流或外发审批失败应保留检查点。换标准按量密钥、端点或服务商属于另外的选择，不能自动回退。

接口变化时核对 [Qwen HTTP API](https://platform.qianwenai.com/docs/api-reference/speech-synthesis/qwen-audio-tts/http-api) 和 [Token Plan 多模态接入](https://platform.qianwenai.com/docs/token-plan/best-practices/multimodal-generation)。

## 使用其他 TTS 时，具体改哪些文件

项目已经提供 `scripts/video/tts.ts` 扩展入口；当前只内置 Qwen，下面的外部适配器需要按所选服务实现并验证。

| 文件 | 接入其他服务时的工作 |
| --- | --- |
| `scripts/video/providers/服务商.ts` | 新增协议适配器；处理鉴权、请求、响应、下载、转码、缓存和时间戳归一化。导出下述 `synthesize` 函数 |
| `scripts/video/tts-types.ts` | 已有统一类型，优先遵守；只有服务确实需要额外元数据时才兼容扩展，保留旧缓存可读性 |
| 本次项目 `voices.json` | 改为该服务支持的模型、音色和参数。不要覆盖其他项目声音表 |
| `scripts/video/tts.ts` | 通常不必改；通过环境或工作流参数加载新适配器。若要长期内置，可增加明确的 provider 分支，保留未知 provider 直接报错 |
| `scripts/video/synthesize.ts` | 通常不必改。它已经只通过统一入口合成，继续负责批量调度、重试与失败报告 |
| `scripts/video/timeline.ts` | 不改帧时间基准；只消费规范 WAV 与真实字词时间戳。若更换对齐方式，归一化仍由适配器完成 |
| `scripts/video/package-skill.mjs` | 把新增适配器及所需支持文件加入打包清单；更新技能包后再分发 |

适配器签名来自 `tts-types.ts`，不是要求所有服务使用同一 HTTP 请求体：

```typescript
import type { AudioMeta, VoiceProfile } from '../tts-types';

export async function synthesize(
  text: string,
  profile: VoiceProfile,
  model: string,
  output: string,
): Promise<AudioMeta> {
  // 1. 读取该服务专用的获准凭据，核对模型和音色。
  // 2. 计算含 provider/endpoint/model/text/voice/参数/版本的缓存键。
  // 3. 完整有效缓存直接返回；否则调用该服务官方接口。
  // 4. 获取完整音频，转换为规范 WAV；归一化实际时间戳。
  // 5. 临时文件验证成功后，原子保存 output 和 output + '.json'。
  // 返回元数据；不能仅返回 URL、假时长或估算字幕。
  throw new Error('按所选服务的官方协议实现后移除此占位');
}
```

返回的 `AudioMeta` 至少包含：

```typescript
{
  cacheKey, provider, model, voice, text,
  bytes, // 最终规范 WAV 的实际字节数
  sentences: [{
    index: 0,
    text: '本段已合成的实际文字',
    words: [{ text: '字词', begin_time: 120, end_time: 380 }]
  }],
  alignment: { method: 'provider', engine: '实际服务或对齐器名称' }
}
```

字词时间统一为**相对本段音频起点的毫秒**，而不是服务返回的秒、100ns tick 或整局绝对时间。字符级对齐也可逐字映射；单词级对齐保留其实际粒度，不能均分成虚假的逐字时刻。使用强制对齐时将 `method` 写为 `forced-alignment`，并记录实际引擎。

字幕正文来自已审核的输入朗读稿，不能直接采用服务商标签的拼写。时间戳标签可能有同音字、标点归一化等差异；当前时间轴保留真实时刻，将可对应的字词映射回原稿，并输出 `caption-audit.json` 供核对。发生字词漏增或对应关系不可靠时先做真实对齐，不把错误标签或假时长带进成片。

配置新适配器后运行（路径、provider ID 和音色文件均替换成实际值）：

```powershell
pnpm video:make --room=ID --tts-provider=my-provider --tts-adapter=scripts/video/providers/my-provider.ts --voices=对应声音表路径 --through=tts --resume
```

单独执行已经准备好的批量任务：

```powershell
$env:VIDEO_TTS_PROVIDER = 'my-provider'
$env:VIDEO_TTS_ADAPTER = '新适配器文件的绝对路径'
# 凭据通过受保护的配置或该适配器约定的专用环境变量注入，不写示例明文 Key。
node node_modules/tsx/dist/cli.mjs scripts/video/synthesize.ts --prepared-clips
```

不要只改 URL 和模型名：鉴权头、输入字段、返回格式、流式事件、音色参数及时间戳往往不同。适配器依赖新 SDK 时，更新仓库的依赖和锁文件，并同步技能打包依赖说明。

## 按响应类型实现适配器

| 官方接口返回什么 | 适配器如何处理 |
| --- | --- |
| 同步二进制音频 | 检查状态、Content-Type 和文件头；流写临时文件，完整结束后解码、规范化。错误 JSON 不能当音频保存 |
| JSON 中的 base64 音频 | 解码音频字段，并把相应 alignment 字段转成统一时间戳；不要把大段 base64 打到日志 |
| JSON 中的下载地址 | 下载媒体后验证；存储域名不继承 API 鉴权头。临时 URL 不是持久缓存 |
| SSE / WebSocket 的音频块 | 按官方事件格式收集，确认最终完成再落盘；区分独立可解码块和连续编码流，不能盲目拼 WAV/MP3 文件头 |
| 异步 job / operation | 保存任务 ID，按服务要求轮询或等待通知，成功后下载。恢复时继续查询已有任务，避免重复提交和重复扣费 |
| 本地 TTS 进程 | 用参数数组启动，读取退出码、音频和对齐文件；保留同样缓存与验证契约，无需伪装成 HTTP 服务 |

可核对的协议实例：

- [ElevenLabs 带时间戳接口](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps)：`POST /v1/text-to-speech/{voice_id}/with-timestamps`，返回 `audio_base64` 及字符对齐数组；音色与模型在该服务配置里映射。
- [Azure Batch synthesis](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/batch-synthesis)：异步批量任务，提交后查询完成状态，再下载产物；不能按同步音频响应读取。
- [Google Cloud 长音频合成](https://docs.cloud.google.com/text-to-speech/docs/create-audio-text-long-audio-synthesis)：异步 operation，结果写入指定存储位置，需要相应项目与存储权限。
- [OpenAI Speech API](https://developers.openai.com/api/docs/guides/text-to-speech)：展示同步/流式音频模式。2026-11-01 查阅时，旧 Speech 模型已公告弃用；新接入须先查当前迁移说明，不能把 Realtime 模型名直接填进 `/v1/audio/speech`。此链接不表示已经在本工具实现 OpenAI 适配器。

模型名、限额、区域和费用不固化在技能里；接入时查所选服务的当前官方文档。供应商的 Batch 产品与本地“多段并发合成”也不是同一个功能，不假设所有 TTS 都支持上传 JSONL 批量接口。

## 批量任务的恢复、费用与验证

保留相同的输入清单和稳定 ID。缓存键必须覆盖服务、端点、模型、文本、音色、语速、指令及其他影响声音的参数；缓存只在音频、元数据和字节数一致时生效。更换服务商不能错误命中旧音频。当前 Qwen 的既有缓存算法保持兼容，不为文档升级重发整局请求。

并发以账号额度和接口限制为准，初次接入先单段验证，再小批量。对可重试网络错误和 5xx 做有限重试，尊重 `Retry-After`；429 降并发/等待或停止并报告。401/403、余额不足、额度耗尽、参数不兼容或审批拒绝时停止，保留成功段。超时的异步任务先查状态，不直接新建。当前批量器用有限次数重试，并将鉴权/额度/429 视为停止条件；需要不同服务的重试策略时应明确修改这一处，而不是在适配器中无限循环。

先用一段法官、一段玩家和一段带数字/标点的短句验证实际输出，确认音色、语言、参数、时间戳和错误分支，再扩大批量。测试服务适配器时用记录好的脱敏响应或本地假服务，不为机械验证反复付费。改适配器后验证：

1. 输出可解码、非静音、24kHz 单声道；WAV 头与真实样本数一致。
2. 返回文字对应实际朗读文字；时间戳有序，范围落在该段真实音频内，单位已转换。
3. 重跑相同输入不重复请求；只改一段文字只失效该段；中断可恢复；更换 provider 不混用缓存。
4. 错误或半截响应不生成成功缓存，凭据和签名下载链接不进入日志。
5. 继续运行 `video:timeline`、小段画面渲染和视频检查，确认人物声音与字幕在最终成片仍同步。

服务不提供时间戳时，先对**最终音频和对应朗读文本**做真实强制对齐，再填统一元数据；可以复用已经生成的音频。只有句级时间戳就使用真实句级字幕，若制作程序要求更细粒度则补实际对齐。音频长度、字数、估算语速和“每字平均分配”都不能冒充时间戳；本项目 `timeline.ts` 会拒绝缺失字词时间戳的正式时间轴。
