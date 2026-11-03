# 本地 ASR 与批量音频核对

更新：2026-11-03。本指南说明 ASR provider、服务配置、视频 workflow 和字幕对齐的实际用法。模型必须先放在本机；服务以离线方式验证模型文件，不会下载模型。

## 语言路由与 workflow

`video:make` 的 TTS 继续使用现有在线 Qwen Token Plan；本地服务仅用于中文/英语 ASR，不是本地 TTS 服务。ASR provider 选择不会把 TTS 改成本地合成。

`pnpm video:make` 支持：

- `--asr-provider=auto|local|qwen-token-plan|mimo-token-plan|off`
- 可选 `--asr-aliases=FILE`
- 可选 `--alignment-provider=qwen-token-plan`

生产默认用 `auto`：中文和英语选本地 ASR，日语选 Qwen Token Plan 在线 ASR。日语生产只能用在线 Qwen；显式 `local` 或 `mimo-token-plan` 会被拒绝。MiMo 日语结果仅保存在单独实验报告中，不能进入日语生产路由。

阶段顺序为：

1. 生成 TTS 波形并做 waveform 检查；
2. 独立 ASR 识别、逐段对照原稿；若配置了对齐，则验证完整词级时间；
3. 完整音频与字幕时间审计；
4. 生成 timeline。

成功的识别结果按音频、provider、模型和选项缓存；复用缓存不会再次请求服务。转写与原稿不一致会列为 `needs-review`，错误或不完整转写列为 `failure`。原稿不会被自动改写。

英语、日语的 Qwen 同一次识别响应若带有可用 word timestamps，且内容和时间经校验能严格映射原稿，workflow 会直接复用这次响应生成对齐 sidecar。英语选本地或 MiMo 时，若词时间缺失或检查不通过，须明确加 `--alignment-provider=qwen-token-plan`；否则以 `alignment-required` 失败。额外对齐请求计入报告的 `alignmentRequests`；Qwen 主识别只复用本次响应，不重复请求。当前外部词边界导入仅支持英语、日语，中文原 TTS 字时不可靠时直接停止，额外云端对齐请求前就拒绝；须另行提供可靠字时。

关闭语义核对：

```powershell
pnpm video:make --room=latest --asr-provider=off
```

workflow status 会把语义状态记为 `not-checked-explicitly-disabled`。此选项仍运行完整时间审计，但不能标记为语音语义通过。若只做材料准备或预检：

```powershell
pnpm video:make --room=latest --prepare-only --asr-provider=auto
pnpm video:make --room=latest --check-only --asr-provider=auto
```

`--prepare-only` 停在 plan，`--check-only` 停在 preflight；两者都不会启动 ASR daemon。workflow 只会在到达 review-audio 阶段且最终 provider 为 local 时按需启动服务。

普通自动运行示例：

```powershell
pnpm video:make --room=latest --asr-provider=auto
pnpm video:make --room=EN_ROOM_ID --asr-provider=local --alignment-provider=qwen-token-plan
pnpm video:make --room=latest --asr-provider=qwen-token-plan
```

第二条把 `EN_ROOM_ID` 换成实际英语房间号，在本地识别后按需要明确请求 Qwen 词边界。中文可本地核对内容，但不支持此项补对齐；日语不要指定 local。也可用 `--asr-provider=mimo-token-plan` 对支持语言做单独的 MiMo 调用。

### 别名文件

`--asr-aliases=FILE` 接受按 clip ID 分组的显式映射：

```json
{
  "clip-01": [
    { "source": "<原稿中的批准写法>", "transcript": "<独立 ASR 的对应写法>" }
  ]
}
```

只用于批准的专名或正字法差异。别名不能掩盖漏词、增词、翻译或 instruction 读入；报告会记录别名表的 hash。

## 本地服务的启停与配置

在项目根目录运行：

```powershell
pnpm asr:start
pnpm asr:status
pnpm asr:restart
pnpm asr:stop
```

workflow 选 local 时会自动执行相当于 `asr:start` 的就绪检查。启动后用 `pnpm asr:status` 确认 `ready`、backend、模型 revision、设备和 runtime；不要手工终止陌生进程。

本地配置文件是忽略数据目录中的 `data/local-asr/service-settings.json`。目前使用的内容如下；各模型、GGUF binding 和 native runtime 均在 `D:/QWEN`：

Transformers/CUDA 的 Qwen3-ASR-0.6B 备用模型目录为 `D:/QWEN/Qwen3-ASR-0.6B-hf`；当前配置仍选择下表所示 Q5 GGUF。

```json
{
  "backend": "gguf",
  "device": "gpu",
  "modelDir": "D:/QWEN/Qwen3-ASR-1.7B-Q5_K_M",
  "python": "D:/python/python.exe",
  "bindings": "D:/QWEN/runtime/transcribe-cpp-0.4.1/python",
  "library": "D:/QWEN/runtime/transcribe-cpp-0.4.1/native/transcribe-native-windows-x86_64-cpu-vulkan/transcribe.dll"
}
```

settings 支持 `backend`、`device`、`modelDir`、`python`、`bindings`、`library` 六项；模型及 runtime 路径须为绝对路径。修改设置后运行 `pnpm asr:restart`，再用 status 核对实际选择。

服务管理器参数优先级（从高到低）：

| 配置 | 优先级 |
| --- | --- |
| data 目录 | `--data-dir` → `WEREWOLF_DATA` → 项目 `data` |
| 服务端口 | `--port` → `WEREWOLF_ASR_PORT` → `5291` |
| backend | CLI `--backend` → `WEREWOLF_ASR_BACKEND` → settings `backend` → `transformers` |
| device | CLI `--device` → `WEREWOLF_ASR_DEVICE` → backend 匹配时的 settings `device` → backend 默认值 |
| modelDir | CLI `--model-dir` → `WEREWOLF_ASR_MODEL_DIR` → backend 匹配时的 settings `modelDir` |
| python | CLI `--python` → `WEREWOLF_ASR_PYTHON` → settings `python` → `python` |
| bindings | CLI `--bindings-dir` → `WEREWOLF_ASR_BINDINGS_DIR` → settings `bindings` |
| library | CLI `--library` → `TRANSCRIBE_LIBRARY` → settings `library` |

如果选中的 backend 与 settings 的 `backend` 不同，settings 的 `device` 和 `modelDir` 不应用到新 backend；其他配置仍按各自优先级处理。手动一次性覆盖可用：

```powershell
pnpm asr:restart -- --backend gguf --device gpu --model-dir D:/QWEN/Qwen3-ASR-1.7B-Q5_K_M --python D:/python/python.exe --bindings-dir D:/QWEN/runtime/transcribe-cpp-0.4.1/python --library D:/QWEN/runtime/transcribe-cpp-0.4.1/native/transcribe-native-windows-x86_64-cpu-vulkan/transcribe.dll
```

服务日志在 `data/local-asr/service.log`；控制凭证在同目录的 `service-control.json`。不要复制凭证文件或环境变量到报告、截图或聊天。

## 单独运行复核 CLI

`video:make` 是推荐的自动入口。已有视频项目也可以单独运行复核。PowerShell 示例：

```powershell
$env:VIDEO_PROJECT_DIR = 'data/video/<room-id>'
pnpm asr:start
pnpm video:review-audio --provider=local --align --alignment-provider=qwen-token-plan
```

单独的 `video:review-audio` 参数是 `--provider=auto|local|qwen-token-plan|mimo-token-plan`、`--aliases=JSON_FILE`、`--align`、`--alignment-provider=qwen-token-plan`。该命令读项目的 `source.json`、`script.json`、`clips.json`，把音频统一转换为 16 kHz、单声道 PCM16 WAV 后送到明确选择的 provider，结果写入 `output/asr-review/`。上述带补对齐选项的命令用于英语；中文可用 `--provider=local` 核对原话，字时仍须可靠；日语请改用 `--provider=qwen-token-plan`，不得本地预筛。

云端调用无隐藏 retry 或 billing fallback。错误报告会隐藏 provider 响应细节和凭据。识别报告包含 request 次数、模型身份、缓存状态、稿件/音频 hash 及逐段状态；将 `output/asr-review/` 视作真实语音私密素材。

## 完整词时间与 sidecar

ASR 内容复核和字幕时间复核是两条单独证据。Qwen 响应路径为 `result.output.sentence.text` 与 `result.output.sentence.words`；服务返回的 words 标签单独不能证明内容逐字正确。workflow 先核对独立转写与原稿，再验证词序、时间边界、音频和元数据 hash。已有对齐 sidecar 若过期或失效会直接失败，不会静默回退或覆盖。

如需从 workflow 外的独立响应手动导入英语或日语词级对齐：

```powershell
pnpm video:import-alignment --audio=data/video/<room-id>/audio/<clip>.wav --locale=en --asr-response=data/video/<room-id>/output/asr-review/transcripts/<transcript>.json
pnpm video:import-alignment --audio=data/video/<room-id>/audio/<clip>.wav --locale=en --check
```

日语把 locale 改为 `ja`。该命令只导入既有 JSON，不调用 ASR；它要求结果绑定目标音频且 `sourcePromptProvided=false`，并验证转写可映射回原稿。默认拒绝覆盖已有 `.alignment.json`。手动别名文件使用 `[{"source":"...","transcript":"..."}]` 数组。

## 模型和比较结果

| 运行方式 | 模型身份 | 权重体积 / SHA-256 |
| --- | --- | --- |
| Transformers/CUDA | `Qwen/Qwen3-ASR-0.6B-hf`，revision `7f1569a48a89f3e3f4dc3a5c9d28bddd903bc76c` | 1,564,928,088 B；`d3f212dd20abecd315d830bc54ae3865e56ebfc3276484e57b771288ba27fd35` |
| GGUF/Vulkan | `handy-computer/Qwen3-ASR-1.7B-gguf`，revision `0e0a596e3959c3f3f2ab7d443a5b6f0f4a4bba6f`，Q5_K_M | 1,517,290,464 B；`034c557fe92ff8fcd9a9c041cbdaad347be0a86a58d3a348f63cf3f0180879d0` |

Q5 是社区 GGUF 转换。中文/英语本地对照差异为 1/82、0/46；日语本地分数仅为历史离线对比，不是生产选项。具体耗时、云端比较和离线观察见 [ASR 对比记录](../../../docs/本地音频核对与ASR对比.md)。

曾有一次日语领域后训练 Q5_K_M 实验；模型文件已按用户决定从 `D:/QWEN` 删除，不能配置或启动为本地 ASR。只保留对比报告；日语生产 provider 仍是在线 Qwen。
