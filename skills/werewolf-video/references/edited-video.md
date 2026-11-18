# 从审定的剪辑稿制作横竖屏成片

上帝和单玩家视角都可以按稿剪辑。每个故事按用户要求确定时长，横竖版用同一套已审稿件和声音，各自验收布局。剪辑程序单版最长 720 秒。单独制作剪辑时只准备本版授权原音；上帝完整版也在制作清单内时优先复用它。完整竖屏见[竖屏指南](vertical-highlights.md)。

## 选择和写作

制作 agent 阅读 `source.json`、`script.json`、`clips.json` 对应事件与原话，听原音并分别写高光和精华。先确定每版的故事问题和结局，再选必要的起因、对立、回应和结果；节奏可精简重复，但不能让删去的上下文改变原意。旁白解释已发生事实，不虚构动机或冒充玩家发言。故事卡只概括已发生的状态，不提前揭晓。选段严格沿源顺序、不重复；准确引用所选源片段的连续 `spokenText` 并保留原标点；授权上帝视角可引用已有上帝解说原音，不能将其冒充玩家原话。原片含私人信息时仅用于授权的上帝视角。完整片写作及法官取舍见[解说](commentary.md)和[剪辑](editing.md)。

完整稿由制作 agent 核对事实和原话；高光、精华等节选稿由独立 reviewer 分别审事实、原话、缺省上下文的影响、节奏与解说，记录所审稿件及版本，修改后重新审核。只有真实审核完成才标记通过。程序机械校验不证明叙事、听感或事实解释已审。

## 编译选段

在忽略目录保存每版独立稿件与编译 job；路径相对于 job JSON 所在目录。稿件可为条目数组，或 `{ "roomId": "...", "title": "...", "theme": "...", "items": [...] }`；房间与主题须匹配源项目。每个条目有唯一 `id`：

- 原音：`kind: "source"`、`sourceClipId` 或唯一 `sourceSeq`、逐字 `quote`、选择理由 `reason`；同一句重复出现时用从 1 起的 `occurrence` 指定。
- 新解说：`kind: "narration"`、`text`、锚定已发生事件的 `afterSourceSeq`。
- 两类均可有 `storyCard`：`headline` 最多 100 字符，可选 `detail` 最多 180 字符、`focusSeats` 最多 3 个不重复的真实座位。

编译 job 包含 `sourceProject`、`manuscript`、`output`，可选 `reviewFile`。独立 reviewer 完成真实审阅后可写 `{ "approved": true, "manuscriptSha256": "稿件文件字节的 SHA-256 小写值" }`，或用 `{ "status": "approved", "checks": { "版本名": { "sha256": "稿件文件字节的 SHA-256 小写值" } } }`；用 `Get-FileHash -Algorithm SHA256 -LiteralPath 稿件路径` 核对。没有审核文件会输出 `reviewed: false`，不能用于渲染。先用 `--check-only` 检查而不写输出，再编译：

```powershell
node node_modules/tsx/dist/cli.mjs scripts/video/compile-edit.ts --job=编辑编译任务.json --check-only
node node_modules/tsx/dist/cli.mjs scripts/video/compile-edit.ts --job=编辑编译任务.json
```

单玩家审阅人按本席当时的可见内容核对引语、旁白和故事卡。审稿记录还须绑定 playerSeat、源项目 source.json 的 sourceSha256 及 visibleFactsOnly，稿件变更后重新审阅。

编译器由当前原话、真实有效词时和音频派生 `wordStart`、`wordEnd`、`audioSha256`、源哈希和主题。检查输出 selection 和 reviewer 记录是否绑定当前内容。原话找不到、重复不唯一、词边界无法可靠映射、乱序或来源变化时回稿件和音频解决；不能凭估时手填词索引或绕过审核。

## 旁白合成与可选独立识别

制作 agent 在审核后创建旁白 job，以下路径相对于该 JSON 文件，示例仅说明结构；实际音色、模型与路线须核实兼容并已有授权：

```json
{
  "sourceProject": "source-project",
  "outputDir": "narration-audio",
  "scripts": [{ "id": "highlight", "scriptFile": "highlight-selection.json" }, { "id": "condensed", "scriptFile": "condensed-selection.json" }],
  "tts": { "route": "token-plan", "model": "qwen-audio-3.1-tts-flash", "voice": "兼容该模型的实际音色", "locale": "en", "rate": 1, "instruction": "", "apiKeyEnv": "可选的凭据环境变量名" },
  "asr": { "enabled": true, "provider": "qwen-token-plan", "aliasesFile": "已核对的别名.json" }
}
```

`apiKeyEnv` 和整个 `asr` 可省略；仅在需要且授权独立识别时配置 ASR，`aliasesFile` 也可省略。`route` 只接受 `token-plan` 或 `dashscope`，DashScope 默认读 `DASHSCOPE_API_KEY`，Token Plan 默认读项目凭据；指定 `apiKeyEnv` 则读该环境变量。凭据不写入 JSON。旁白条目可选 `delivery: { "tag": "标签" }` 或 `delivery: { "segments": [{ "text": "原文片段", "tag": "标签" }] }`；segments 文本拼接必须与原文完全一致。每次请求仍是完整句或自然段；标签和情绪先按实际模型能力试音，不添加凭空内容。

```powershell
node node_modules/tsx/dist/cli.mjs scripts/video/synthesize-narration.ts --job=旁白任务.json --check-only
node node_modules/tsx/dist/cli.mjs scripts/video/synthesize-narration.ts --job=旁白任务.json
```

先看 `--check-only` 输出每段 `cached` 或 `pending` 与凭据提示；它不调用服务，也不证明 ASR 就绪。确认将外发的文本及费用路线已授权后执行第二条。每版在 `outputDir/脚本ID/` 生成 WAV、元数据与 `narration-manifest.json`；缓存由端点、模型、声音、文本及参数绑定。缓存异常会保留并停止以供检查。启用 ASR 后差异产生 `needs-review`，对照原音及原文，确认别名后恢复；真实词时不足则按[音频核对](local-asr.md)处理。实际文字、对齐和听感分别记录，切勿把转写通过当作听审通过。

## 选择、渲染与验收

每一版及格式使用独立输出目录；源项目与输出不能互相包含。编辑 job JSON 使用 `sourceProject`、`selection`、`narrationManifest`、`outputDir`、`format`（`vertical` 或 `horizontal`）、`encoder`（`cpu` 或 `gpu`），路径相对 job 文件。精华两个 job 指向同一 selection 与旁白 manifest，输出目录和格式不同。改变编码或画面源时另建输出目录，并复用已核验的配音，不重新合成。先 `--validate-only`，成功会输出 `validated`、`frames`、`durationSeconds`；然后运行正式命令：

```powershell
node node_modules/tsx/dist/cli.mjs scripts/video/edited-video.ts --job=渲染任务.json --validate-only
node node_modules/tsx/dist/cli.mjs scripts/video/edited-video.ts --job=渲染任务.json
```

也可使用旧的直接参数 `--source-project=路径 --selection=路径 --narration-manifest=路径 --output-dir=路径 --format=vertical|horizontal --encoder=cpu|gpu`。成功后检查 `output/highlights-vertical.mp4` 或 `output/highlights-horizontal.mp4`、`subtitles.srt`、`source-map.json` 和 `verification.json`。输出 1080×1920 或 1920×1080、30fps；`verification.json` 的 `subjectiveListening` 初始为 `not-checked`。身份相同且片段缓存哈希有效才复用；输入或设置变更用新目录。编码报错检查日志及编码器，不能将 GPU 失败当作成功。

昼夜切换和同一场景内的人物切换使用硬切。其他阶段或章节边界使用四帧淡出和淡入。验收时抽取切点前后连续帧，逐帧检查字幕小字、徽章和细边缘，再播放确认切换节奏。连续抽帧命令见[画面转场与清晰度检查](compression.md#画面转场与清晰度检查)。

对每种格式逐镜抽帧并完整播放，检查字幕断句、遮挡、画面、角色、票型、故事卡和转场，再单独听审。reviewer 核验故事，检查结果及未检查项各自记录。画面或内容缺陷修正后重新审阅与验证；没有可靠对齐则停止。各交付版本按目标语言、实际视角和本版可见看点准备标题、简介及由生图模型连同短标题一起生成的封面；竖屏画面不加固定“节选”标签，按[主流程](../SKILL.md)校验和交付；渲染进行时不得清理。
