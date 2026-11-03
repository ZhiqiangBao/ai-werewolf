# 本地 ASR 与批量音频核对

更新：2026-11-03。本指南说明 ASR provider、服务配置、视频 workflow 和字幕对齐的实际用法。模型必须先放在本机；服务以离线方式验证模型文件，不会下载模型。

## 语言路由与 workflow

`video:make` 的 TTS 继续使用现有在线 Qwen Token Plan；本地服务仅用于中文/英语 ASR，不是本地 TTS 服务。ASR provider 选择不会把 TTS 改成本地合成。

`pnpm video:make` 支持：

- `--asr-provider=auto|local|qwen-token-plan|mimo-token-plan|off`
- 可选 `--asr-aliases=FILE`
- 可选 `--alignment-provider=qwen-token-plan`

ASR 默认关闭（`off`），按需启用，不会因制作视频自动产生识别请求。显式 `auto` 才按语言路由：中文和英语使用本地 Q8，日语使用 Qwen Token Plan 在线 ASR。日语生产只能用在线 Qwen；显式 `local` 或 `mimo-token-plan` 会被拒绝。MiMo 日语结果仅保存在单独实验报告中，不能进入日语生产路由。

`auto` 不会在中文/英语本地服务不可用时改走在线 ASR。选择启用 ASR 后，第一次制作前按源局语言准备路由，并在产生外部 TTS 请求前确认前置条件：中文/英语使用 `auto` 时先完成本机模型注册并确认服务 `ready`；日语或显式 Qwen 路由须确认项目加密模型库中有可解密的 Qwen Token Plan 条目。Qwen ASR 只从 `data/models.json` 和对应项目主密钥读取此凭据，不读取 `WEREWOLF_TTS_API_KEY`；TTS 的凭据来源见 [批量 TTS](tts-batch.md)。如当前工作站缺少本地模型，不要假设示例中的 D 盘路径存在或擅自下载；在用户授权下显式改选 Qwen，或先取得模型安装授权。`off` 是当前默认值，表示没有执行语义核对；不能标记为语音内容通过。

阶段顺序为：

1. 生成 TTS 波形并做 waveform 检查；
2. 仅在显式启用 ASR 时，独立识别并逐段对照原稿；若配置了对齐，则验证完整词级时间；
3. 完整音频与字幕时间审计；
4. 生成 timeline。

成功的识别结果按音频、provider、模型和选项缓存；复用缓存不会再次请求服务。转写与原稿不一致会列为 `needs-review`，错误或不完整转写列为 `failure`。原稿不会被自动改写。默认 `off` 时跳过此阶段，状态为 `not-checked-explicitly-disabled`。

Q8 的本地识别只提供转写，不提供可用于字幕的词级时间。日语显式启用 Qwen 后可用该次响应的 `--align` 词边界；若缺失或检查失败，保留检查点和原响应，取得可验证且绑定原音的独立词边界后，按下文显式导入。不能添加 `--alignment-provider=qwen-token-plan` 期待它重新请求：Qwen 主识别只复用同一响应，该选项只用于本地/MiMo 核对后的英语补对齐。英语选本地或 MiMo 时，若词时间缺失或检查不通过，明确选择该选项才会额外请求 Qwen，否则以 `alignment-required` 失败。额外对齐请求计入报告的 `alignmentRequests`；可复用的 Qwen 主识别响应不会重复请求。当前外部词边界导入仅支持英语、日语；中文不支持外部补对齐，若原 TTS 字时不可靠须停止并取得可靠字时，不能把 Q8 转写当作对齐。

关闭语义核对：

```powershell
pnpm video:make --room=latest
```

workflow status 会把语义状态记为 `not-checked-explicitly-disabled`。此选项仍运行完整时间审计，但不能标记为语音语义通过。若只做材料准备或预检：

```powershell
pnpm video:make --room=latest --prepare-only --asr-provider=auto
pnpm video:make --room=latest --check-only --asr-provider=auto
```

不指定 `--asr-provider` 等同于 `off`。`--prepare-only` 停在 plan，`--check-only` 停在 preflight；两者都不会启动 ASR daemon。workflow 只会在到达 review-audio 阶段、明确启用识别且最终 provider 为 local 时按需启动服务。

这两个阶段也不会验证本地 ASR 的模型/运行时是否可加载，或在线 ASR 凭据是否可用。只有显式启用 ASR 时才会在 TTS 后运行识别；若本次选择 `auto`，中文/英语首跑前请依照下方本地服务步骤完成模型注册，并先确认 `pnpm asr:status` 显示 `ready`；日语首跑前请确认项目模型库中有可解密的 Qwen Token Plan 条目。缺少这些条件时先停止，不要先发起 TTS 再发现核对路由未就绪。

制作默认不调用 ASR。需要按需核对时，显式启用以下路由：

```powershell
pnpm video:make --room=latest --asr-provider=auto
pnpm video:make --room=EN_ROOM_ID --asr-provider=local --alignment-provider=qwen-token-plan
pnpm video:make --room=latest --asr-provider=qwen-token-plan
```

第二条把 `EN_ROOM_ID` 换成实际英语房间号，在本地识别后明确请求 Qwen 词边界。日语如需内容核对，使用 `--asr-provider=qwen-token-plan`；若现有词时不可靠，可对单个片段运行 `pnpm video:review-audio --provider=qwen-token-plan --clip=CLIP_ID --align`，先设置正确的 `VIDEO_PROJECT_DIR` 与 `WEREWOLF_DATA`。中文可用 Q8 核对内容，但不支持 Qwen 外部补对齐；若源时间不可靠，停止并索取可靠字时。也可用 `--asr-provider=mimo-token-plan` 对支持语言做单独的 MiMo 调用。

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

### 首次启用：注册已安装模型与 runtime

`asr:prepare` 只读取本机现有模型与 runtime，核对固定 repo/revision、文件大小和 SHA，再在指定数据目录生成服务所需的模型清单；它不下载、不启动 ASR，也不修改 `service-settings.json`。GGUF 还会核对目标游戏仓库随附的 `scripts/asr/runtime-manifest.v0.4.1.json` 与其绑定/DLL 文件；该清单按原始字节校验，Git 配置保留其换行。工具和清单不由独立技能包安装。不要手工抄写或修改清单/hash。

已验证 Windows 工作站的 Q8 GGUF 示例：

```powershell
pnpm asr:prepare --backend gguf --model-dir D:/QWEN/Qwen3-ASR-1.7B-Q8_0 --runtime-dir D:/QWEN/runtime/transcribe-cpp-0.4.1 --data-dir D:/document/狼人杀/data
```

命令成功返回后，确认该数据目录下出现 `local-asr/model-manifest.gguf.json`，且模型与 runtime 检查通过；缺少文件或摘要不符时停止，不手工改清单。若该目录已经有旧模型清单（例如旧 Q5），先确认新模型/runtime 完整并通过校验，再在同一命令末尾加 `--replace`；工具会先校验新文件，再备份并原子替换旧清单。成功不会自动启动服务。

工作站没有此 Q8 GGUF 或 Windows Vulkan runtime 时，不要照抄 D 盘路径或自动下载。0.6B Transformers 是保留的备用模型，可在本机确实有完整权重时显式注册：

```powershell
pnpm asr:prepare --backend transformers --model-dir ABS_MODEL_DIR --data-dir ABS_DATA_DIR
```

不传 `--runtime-dir`。如没有可用本地模型，只有在用户授权且项目 Qwen Token Plan ASR 凭据已就绪时，才显式指定 `--asr-provider=qwen-token-plan`；不要让 `auto` 静默改走在线。日语生产仍只使用在线 Qwen。

### 服务配置

本地配置文件是忽略数据目录中的 `data/local-asr/service-settings.json`。下面是已验证 Windows 工作站的配置示例，不是技能包自带内容，也不保证其他机器有相同盘符、模型或显卡；按当前主机实际绝对路径填写。已验证工作站的模型、GGUF binding 和 native runtime 位于 `D:/QWEN`：

该工作站另有 Transformers/CUDA 的 Qwen3-ASR-0.6B 备用模型目录 `D:/QWEN/Qwen3-ASR-0.6B-hf`；生产示例配置选择 Q8 GGUF。其他机器若没有这些文件，不要照抄路径。

```json
{
  "backend": "gguf",
  "device": "gpu",
  "modelDir": "D:/QWEN/Qwen3-ASR-1.7B-Q8_0",
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
pnpm asr:restart -- --backend gguf --device gpu --model-dir D:/QWEN/Qwen3-ASR-1.7B-Q8_0 --python D:/python/python.exe --bindings-dir D:/QWEN/runtime/transcribe-cpp-0.4.1/python --library D:/QWEN/runtime/transcribe-cpp-0.4.1/native/transcribe-native-windows-x86_64-cpu-vulkan/transcribe.dll
```

服务日志在 `data/local-asr/service.log`；控制凭证在同目录的 `service-control.json`。不要复制凭证文件或环境变量到报告、截图或聊天。

## 单独运行复核 CLI

`video:make` 是推荐的自动入口。已有视频项目也可以单独运行复核。PowerShell 示例：

```powershell
$env:VIDEO_PROJECT_DIR = 'data/video/<room-id>'
pnpm asr:start
pnpm video:review-audio --provider=local --align --alignment-provider=qwen-token-plan
```

单独的 `video:review-audio` 参数是 `--provider=auto|local|qwen-token-plan|mimo-token-plan`、`--aliases=JSON_FILE`、`--clip=ID`（可重复）、`--align`、`--alignment-provider=qwen-token-plan`。该命令读项目的 `source.json`、`script.json`、`clips.json`，把音频统一转换为 16 kHz、单声道 PCM16 WAV 后送到明确选择的 provider，结果写入 `output/asr-review/`。例如 `pnpm video:review-audio --provider=auto --clip=027-1` 只检查一个已存在的片段；片段 ID 从本项目 clips.json 取得，未知 ID 在请求前失败。上述带补对齐选项的命令用于英语；中文可用 `--provider=local` 核对原话，字时仍须可靠；日语请改用 `--provider=qwen-token-plan`，不得本地预筛。

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
| GGUF/Vulkan 当前默认 | `handy-computer/Qwen3-ASR-1.7B-gguf`，revision `0e0a596e3959c3f3f2ab7d443a5b6f0f4a4bba6f`，Q8_0 | 2,185,030,624 B；`9a0d81792dfea2d5f278b8a63deb3ea6e02139ce42c2301f32ea19c4f77526b7` |

中文/英语当前本地默认采用 Q8；0.6B Transformers 保留为备用。Q5_K_M 是先前社区 GGUF 对比方案，已不作为当前可用模型。2026-11-03 已完成中、英、日各 10 段、各模型三轮的 Q5/Q8 冻结对比；Q8 的日语原稿差异从 7.59% 降至 5.16%，但仍有否定词等重要错误，不能据此开放日语本地生产。完整数据保存在游戏仓库 `docs/评估/Qwen3-ASR-1.7B量化对比.md`，早期 0.6B 数据为 `docs/本地音频核对与ASR对比.md`；这些历史报告不随独立技能包附带。日语生产只能用在线 Qwen。

曾有一次日语领域后训练 Q5_K_M 实验；模型文件已按用户决定从 `D:/QWEN` 删除，不能配置或启动为本地 ASR。只保留对比报告；日语生产 provider 仍是在线 Qwen。
