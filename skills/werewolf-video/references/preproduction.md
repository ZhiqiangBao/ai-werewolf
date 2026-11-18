# 制作前准备与台词润色：从对局到可运行的制作材料

这一步由制作者（AI agent 或真人）完成。`prepare.ts` 只生成素材索引与模板，不会替你完成有表达质量的叙事编辑，也不会自动请求另一个文案模型。不要把“脚本能运行”当作“台词已润色”。先按本文件备齐材料，再开始 TTS 和渲染。

本文件的旁白与全桌画面步骤默认用于完整上帝视角。若制作单玩家历史视角，命令须指定 `--player-seat=N`，改按[单玩家视角制作](player-view.md)执行：只审核该席位可见的历史原话，不写自由解说，并让其他座位身份始终保持未知。两条流程不能共用编辑稿或样品目录。

## 启动前到底准备到哪一步

第一次运行 `--prepare-only` 前，需要已结束房间、项目依赖和可读的存档；此时不必先手工创建旁白文件。脚本会生成下表的初稿与索引。完整上帝视角进入正式配音前，制作者必须完成上帝解说和声音表的实际核对、选择已授权的 TTS 服务与凭据；再运行 `--check-only`。单玩家视角遵照[该视角的审核字段与材料规则](player-view.md)，不能用本页的自由解说模板。

| 文件／事项 | 脚本生成什么 | 开始正式配音前需完成什么 |
| --- | --- | --- |
| `plan.json`、`editorial-context.json` | 房间、身份、规则、事实与发言索引 | 阅读材料，引用发言时补读完整原文 |
| `narration.json` | 可编辑模板，不代表已完成本局解说 | 上帝视角按 [上帝解说写作](commentary.md) 写开场、点评、收尾；玩家视角保留空 `edits` 并按 [单玩家视角制作](player-view.md) 核对授权原话 |
| `art-manifest.json` | 选定主题、图集路径、逐席行列、外貌性别与实际声线 | 按席位核对封面人物参考；玩家视角只使用该视角获授权的事实 |
| `voices.json` | 按主题匹配的默认声音配置与座位标签；传入 `--tts-model` 时由模型注册表自动迁移到兼容音色 | 核对实际音色、指令与语速并试听；自定义音色仍需人工确认，原始立绘提示词随技能附带，法官和上帝分开 |
| TTS 运行配置 | 由 `--tts-model` 选择模型、端点、凭据环境和兼容音色；未传参数时沿用项目配置 | 确认服务可用、凭据已配置、外发已授权；接入方法见 [批量 TTS](tts-batch.md) |
| 本局内容稿 | 不由运行参数决定 | `narration.json` 的事实编辑、节选稿、故事卡、审核、封面和发布文案仍由制作 AI 根据本局材料实际完成 |
| 主题与样品选择 | 已有美术；样品需另选节点 | 使用已确认画面，需样品时备好独立选择表 |

封面和最终发布文案可在成片制作期间准备，在最终交付前补齐。Windows 成片固定交付到 `$env:USERPROFILE\Desktop\月影议事厅-频道素材\05-对局成片\<roomId>\`，按 `01-竖屏高光`、`02-横屏精华`、`03-竖屏精华`、`04-完整横屏` 分目录，不扫描桌面或另建路径。`--check-only` 只检查配音启动材料，不宣称封面、试听或文案已经完成。

首次制作或更换工作站时，在仓库根目录先确认 Node.js、pnpm、FFmpeg 与 FFprobe 可用：

```powershell
node --version
$pnpmPaths = @(where.exe pnpm 2>$null | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$localPnpm = $pnpmPaths | Where-Object {
  $_ -match '\\fallback\\pnpm\.cmd$' -or ($_ -notmatch '\\nodejs\\pnpm(?:\.(cmd|ps1))?$' -and $_ -notmatch '\\corepack\\')
} | Select-Object -First 1
if (-not $localPnpm) { throw '没有可直接执行的本机 pnpm；当前 PATH 只有 Corepack 入口。请先提供本机 pnpm，再运行视频制作。' }
$env:PATH = "$(Split-Path -Parent $localPnpm);$env:PATH"
pnpm --version
ffmpeg -version
ffprobe -version
```

按项目 `AGENTS.md` 的要求准备 Node.js 22.12 或更新版本和本机 pnpm，不指定 pnpm 版本；上面的引导会优先把可直接执行的本机 pnpm 放到当前 PowerShell 会话的 PATH 前面，避免 Corepack 在制作过程中联网解析版本。依赖未安装时运行 `pnpm install`。FFmpeg 与 FFprobe 必须能从 `PATH` 调用；如果已有可执行文件但不在 `PATH`，在同一 PowerShell 会话设置 `$env:FFMPEG_PATH` 和 `$env:FFPROBE_PATH` 为对应绝对路径。缺失工具时先停止并请用户提供安装或可用路径，不要等整局配音后才发现。`--check-only` 不检查这些程序、TTS 凭据或本地 ASR 模型是否就绪。

安装／bootstrap 后、配音前检查美术资源是否已复制到 `apps/web/public/art/moon-village/`：至少要有昼夜背景、昼夜桌面和当前主题头像图集。先查看 `art-manifest.json` 的主题和图集路径：默认读取房间公开的 `avatarStyle`，显式 `--theme` 优先，旧存档缺失时才使用 `campus`。按清单核对对应图集；出现主题冲突或无法确认旧目录主题时使用新目录，或先明确迁移并核对声音和缓存。缺项可按[程序启动与bootstrap](automation.md#运行环境)及技能入口执行 bootstrap，再检查是否出现；不要用缺图开始整局配音。Windows 画面会尝试注册 `C:/Windows/Fonts/msyh.ttc` 与 `msyhbd.ttc`；其他系统按[硬件说明](hardware.md)选择并注册实际中文字体。若字体不存在，先解决字体回退并用短画面检查文字，不能把程序退出成功当成中文字体正确。

准备出本局 `source.json` 后、任何真实 TTS 前，再按本局语言检查工作流实际会使用的工具和凭据。以下只输出可用性布尔值，不显示密钥；使用自定义 `--data-dir` 时，先把 `$env:VIDEO_DATA_DIR` 和 `$env:WEREWOLF_DATA` 设为同一绝对目录：

```powershell
node --import tsx --input-type=module -e "import { execFileSync } from 'node:child_process'; import { ffmpeg, ffprobe } from './scripts/video/project.ts'; import { projectQwenTokenPlanKey } from './packages/session/src/project-models.ts'; await import('@napi-rs/canvas'); for (const bin of [ffmpeg, ffprobe]) execFileSync(bin, ['-version'], { stdio: 'ignore' }); const key = projectQwenTokenPlanKey(); console.log(JSON.stringify({ ffmpeg: true, ffprobe: true, canvas: true, qwenTtsCredential: Boolean((process.env.WEREWOLF_TTS_API_KEY || '').startsWith('sk-sp-') || key), qwenAsrCredential: Boolean(key) }));"
```

`ffmpeg`、`ffprobe` 或 `canvas` 导入失败时，先按上方处理本机依赖。无 TTS 凭据时不要启动会产生外部合成请求的命令；Qwen TTS 可使用 `WEREWOLF_TTS_API_KEY` 或可解密的项目模型库条目。日语 `auto` 或任一语言显式选 Qwen ASR 时，`qwenAsrCredential` 必须为 `true`；ASR 不读取单独的 `WEREWOLF_TTS_API_KEY`。如本局为中文/英语且采用 `auto`，按[音频核对操作指南](local-asr.md)先注册本机模型并确认服务就绪；`--check-only` 不会代替这项检查。缺少服务、凭据或必要授权时先停止，请用户配置或明确授权可用路线，不要暗中换 provider。

## 第一阶段：只运行轻量准备，确认素材

在 `ai-werewolf` 仓库执行：

```powershell
pnpm video:make --room=latest --prepare-only
```

记下输出的实际房间 ID，后续固定用该 ID，避免新结束的对局使 `latest` 改变。已指定房间时用指定 ID。此阶段只读已结束存档并写制作材料，不生成整局配音、不重开游戏。

先读 `data/video/ID/plan.json`，再读其 `editorialContextFile`。后者是程序生成的 `editorial-context.json`，包含本局公共规则、完整身份表、按时间排序的结构化行动/票型、玩家发言索引与终局核对材料。索引只给开头；需要引用或评价某段话时，再按 `sourceSeq` 从 `data/exports/ID-video-script.json` 读取完整原文。

制作前材料清单：

| 材料 | 从哪里来 | 由制作者完成什么 |
| --- | --- | --- |
| 原始剪辑稿和事实 | `video:make --prepare-only` 导出 | 确认房间已结束、导出视角与本次授权相符；不修改事实 |
| `editorial-context.json` | `prepare.ts` 自动生成 | 了解转折、确定点评锚点；不能拿终局信息提前写到过程里 |
| `art-manifest.json` | 选定主题、图集路径、逐席行列、外貌性别与实际声线 | 按席位核对封面人物参考；玩家视角只使用该视角获授权的事实 |
| `voices.json` | 默认音色表 + `plan.json` 人设 | 核对每个角色与音色，写好对应表达指令，保持跨昼夜一致 |
| `narration.json` | 自动模板/旧编辑稿 | **亲自润色开场、关键转折和收尾**，按下面的方法写回 |
| ASR 路由 | `source.json` 的局内语言与[音频核对操作指南](local-asr.md) | 默认 `off`，按需启用；显式 `auto` 才是 `zh`/`en` 本地 Q8、`ja` 在线 Qwen。若本次要核对，在 TTS 前确认对应模型服务或项目 Qwen ASR 凭据可用；`off` 会跳过语义核对，不得标作通过 |
| 公共规则卡 | 游戏规则对象生成的 `ruleCard` | 画面摘录实际规则，不因模型一次误解而新增“纠错规则” |
| 样品选段文件（需要样品时） | 模型选择的真实 `sourceSeq` 和分段 | 覆盖待检查的流程与画面，明确节选而不冒充完整对局 |
| 封面素材与短标题 | 本局事实、`plan.cast`、当前人物图集与画面抽帧 | 逐版选择可见的真实看点和对应人物，写定稿标题与封面短标题，并按 [封面制作](cover.md) 将短标题连同画面交给已授权生图工具生成 |

## 第二阶段：整理人物与声音

使用现有角色图集和声音表；用户要求微调时，复用背景、人物、已成功音频和项目目录中的缓存。不要重新生成所有资产。

逐个对照 `plan.cast` 的名字、形象、角色设定与 `voices.profiles[voiceKey]`。声音应由人物决定，不按狼人/好人的临时身份更换。法官与上帝解说使用不同的固定声音；法官清楚、平稳，解说自然、口语化。12 个座位可以使用现有经过验证的不同音色，不用变速一个声音冒充多人。

主持短句也要听感自然。不要把“预言家请睁眼”拆字点读；整句连读，逗号只轻换气。当前声音表用 `judgeCues["seer-open"]` 为这句保留已试听确认的连读指令与 `rate: 1.14`，继续使用同一法官音色。其他主持句可按实际听感增加各自的 cue 配置，不因此改动玩家原话或全局声线。`project.ts` 的 `clipVoiceProfile` 只将此类指令／语速覆盖用于对应的法官流程片段；合成缓存仍以实际完整请求为准。用户指出听感问题时先生成短样音供试听，再替换对应片段；不能只核对字幕便声称已试听。

指令描述“年轻、冷静、句子干净、转折清晰”这类可执行特征，避免只写“自然好听”。核对服务支持的模型、音色、语速与指令字段。批量调用与新增服务适配器见 [批量 TTS](tts-batch.md)。

## 第三阶段：把自动模板改成真正的节目台词

阅读本局事实与完整玩家原话，按 [上帝解说写作](commentary.md) 选择看点，实际撰写开场、锚点转折和收尾；自动生成的法官主持与模板不是成稿。保留玩家原话及顺序，不把角色行动转述冒充原话。单玩家视角只保留授权历史原话。

### 写回准确的编辑格式

`narration.json` 的 `edits` 以原始非玩家事件的 `sourceSeq` 为键。开场和终局可用 `text` 与 `voiceKey: "commentator"`；事实播报后的点评使用 `after`，让法官先播报结果。每条编辑及点评的 `reason` 要写真实依据，不可修改玩家发言。按 [上帝解说写作](commentary.md) 核对事实与原话后填写 `review`；只给模板增加审核标志不能通过材料检查。

## 第四阶段：备好画面与样品清单

完整上帝视角沿用现有背景、桌子和人物图集，检查它们与人物声音相符。右栏按本局实际身份生成完整技能卡，容纳不下时连续循环滚动，跨发言片段延续进度；不能长期固定只放预言家。单玩家视角展示公共技能信息；除本人身份外，其他座位身份保持未知，见[单玩家视角制作](player-view.md)。白天与黑夜同时切换顶栏、面板边框、中央卡、规则卡和字幕框。中央卡与波形较小，头像上的发言/上警/警徽更醒目。投票框随实际票型行数收紧，票源号码与票数放大，不能靠放大空框突出结果。这些样式由 `scene.ts`、`palette.ts`、`rule-cards.ts`、`rule-strip.ts` 和 `render.ts` 实现。

完整上帝视角底栏沿用整桌人物图集：左侧为 84px 人物头像，上行“编号 · 真实身份”，下行昵称；身份来自本局 cast，不随玩家冒认身份改变。单玩家视角只把自己的身份固定显示，其余席位始终为“身份未知”；授权可见的查验或密谈原话仍保留，不借终局 `review` 或 `knownIdentities` 改写身份标签。法官没有玩家席位，使用法槌徽记和“法官／流程主持”；上帝解说使用眼睛与星芒徽记和“上帝解说／全知视角”。两者占用相同位置，但徽记、标签与声线各自固定，不借用某一位玩家的头像。“行动转述／系统托管／狼队密谈”在身份行旁保留来源标记；出局玩家的遗言继续显示该玩家头像与实际出局状态。

字幕只占底栏右侧文字区，水平与垂直居中，不再在顶部另放发言者文字。1080p 当前底栏为 `(28,942,1864,111)`，文字区为 `(454,956,1410,83)`、中心 `(1159,998)`；头像与文字区由细线分开。`geometry.ts` 的 `subtitleLayout` 是场景与 ASS 共用坐标，`speaker.ts` 选择真实玩家或主持身份，`timeline.ts` 输出居中字幕。调整位置时同步这些模块，抽看最终编码后的画面，不能只看未烧字幕的底图。

验收成片时，抽取代表性昼夜切点和人物切点前后的连续帧，检查首帧亮度、字幕小字、技能卡、号码和细边缘。昼夜切换及同一场景内的人物切换用硬切，其他阶段或章节边界用四帧淡出和淡入。抽帧方法见[上传画质与体积控制](compression.md#画面转场与清晰度检查)。

完整上帝视角的画面样品优先覆盖长昵称与两位数编号的玩家、法官、上帝点评、昼夜两种主题和“行动转述”标记。需要共同评价画面时先交付带声音的独立样品，按用户反馈确定画面，再启动整局；制作整片时复用已确认的样品配音缓存。

用户只要样品时，先做独立目录和显式选择表，不先合成整局。选段应覆盖本次需要看的现象，例如夜间询问/选择/确认、上警标志、白天发言、警长决定顺序、投票邀请与结果；缺少的阶段不能用随便截取前五分钟代替。

选择表格式：

```json
{
  "description": "约五分钟修改样品；非连续节选",
  "sections": [
    { "title": "首夜流程", "sourceSeqs": [4, 6, 8, 16, 18, 19, 20] },
    { "title": "警长流程", "sourceSeqs": [36, 37, 39] },
    { "title": "玩家发言节选", "sourceSeqs": [41], "parts": { "41": [1] } },
    { "title": "放逐投票", "sourceSeqs": [65] }
  ]
}
```

此示例同样只属于 e6220f1238。程序按原顺序选段，保留所选玩家片段原文，并自动包含关联的法官流程。第一次只看实际音频时间轴，再按需要增减完整段；不要用假字幕时长凑五分钟。

```powershell
$env:VIDEO_ROOM = '实际房间ID'
$env:VIDEO_PROJECT_DIR = '本局制作目录下独立的样品目录绝对路径'
$env:VIDEO_NARRATION_FILE = '已润色的本局 narration.json 绝对路径'
node node_modules/tsx/dist/cli.mjs scripts/video/sample.ts --selection=样品选段文件路径
node node_modules/tsx/dist/cli.mjs scripts/video/synthesize.ts --prepared-clips
node node_modules/tsx/dist/cli.mjs scripts/video/audit-audio.ts --fail-on-error
node node_modules/tsx/dist/cli.mjs scripts/video/timeline.ts
node node_modules/tsx/dist/cli.mjs scripts/video/render.ts
node node_modules/tsx/dist/cli.mjs scripts/video/verify-sample.ts --video=样品目录/output/latest-match.mp4
```

原有整局存在时，`sample.ts` 按文字和角色复用配音；首次制作也可在准备完材料后选段，只为样品生成音频。完成样品后不要在同一 shell 忘记清掉 `VIDEO_PROJECT_DIR` 再跑整局；另开干净 shell 或显式设回正确目录。

## 第五阶段：制作和交付

按[主流程](../SKILL.md)完成材料检查、配音、时间对齐、渲染和最终验收；编码配置和交付范围以本次要求及主流程为准。保留受影响阶段的缓存和失败记录，修正后重验最终交付物。

每个交付版本按本版可见事实撰写标题和简介，选择真实看点与封面短标题，再按[封面制作](cover.md)将短标题作为实际生图提示词的一部分与画面一起生成。核对并绑定本版文案、提示词、最终图片及审核记录；单玩家封面和文案不得泄露未授权信息。最终位置、转存和清理按[主流程](../SKILL.md)执行。
