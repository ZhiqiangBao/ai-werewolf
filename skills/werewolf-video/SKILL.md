---
name: werewolf-video
description: 将本项目已结束的狼人杀记录制作成上帝视角或单玩家视角视频，含制作前材料、多人物TTS、时间轴、离线画面、样品、封面与发布文案；支持维护制作程序及接入其他TTS服务。
---

# 狼人杀对局视频

主要读者是接手本仓库视频制作任务的 **agent**。目标是把已结束的真实对局制作成指定视角的视频，并交付与该视角一致的音频、字幕、验证记录和约定素材。agent 使用仓库程序完成机械步骤，负责备料、原话与权限核对、检查报告和交付；用户提供必要授权、偏好及需要其判断的听感反馈。已有会话授权沿用，不重复索取。

完整上帝视角可润色开场、点评和收尾；单玩家视角只重建指定席位实际可见的历史，具体权限、身份与审核边界见[单玩家视角制作](references/player-view.md)。涉及生图等外部能力时，提供可复制的输入材料和人工操作方法，具体 agent 的内置工具仅作可选实现。默认制作完整上帝视角对局；用户要求样品时只制作样品。真人制作者也可按相同步骤操作，不依赖某个 agent 的专属工具。

## 起点与制作范围

读者是制作 agent；用户给出已结束对局、视角、交付范围、目标语言与素材目的地，并提供已授权服务和必要的主观听感判断。默认完整上帝视角；用户要求四套时制作：完整横屏、约一分钟竖屏高光、约十分钟精华横屏与精华竖屏。三套独立内容稿分别是完整稿、高光稿、精华稿；精华横竖共用同一审定剪辑和解说，各自验收布局。用户指定其他范围时按其要求调整，不自动扩展。编辑版目前只支持已结束的上帝视角；单玩家视频按[单玩家视角](references/player-view.md)单独制作，不共用全知素材。

在 `ai-werewolf` 仓库根目录准备 Node.js 22.12+、pnpm、项目依赖、FFmpeg/FFprobe 和可读的真实存档；按[制作前准备](references/preproduction.md)检查工具、项目目录和凭据，不输出密钥。用户指定原桌面频道素材文件夹作为最终交付位置；先确认它可写且对应本次项目。TTS、ASR、生图及对外发送材料均按已有授权执行，缺授权或凭据时在该阶段停止，不静默切换服务。ASR 默认关闭；如交付要求独立转写核对，配音前显式选择并确认路由、凭据或本地模型。`--check-only` 不验证 ASR 就绪。

## 1. 准备事实与完整稿

若本机 Corepack 因未缓存 pnpm 而尝试联网下载并失败，且项目依赖已经安装，可用 `node node_modules/tsx/dist/cli.mjs scripts/video/workflow.ts` 替代下文的 `pnpm video:make`，后续参数不变；依赖尚未安装时先回制作前准备，不能据此跳过环境检查。

agent 在仓库根目录先运行，仅备料、不调用 TTS：

```powershell
pnpm video:make --room=latest --prepare-only
```

`latest` 按创建时间选择默认 `data/rooms` 下已结束且有 `game.end` 的对局，并非按结束时间排序；核对结果后把后续命令的 `ROOM_ID` 固定为实际房间号。找不到对局时核实存档，必要时指定 `--data-dir=绝对路径`，不可猜测。单玩家必须加 `--player-seat=N`；以 `--project-dir=绝对路径` 隔离项目，导出仍会写入数据目录。

准备成功后项目中应有 `plan.json`、`editorial-context.json`、`narration.json`、`voices.json` 和 `art-manifest.json`。agent 阅读事实与完整授权原话，按[完整稿写作](references/commentary.md)、[剪辑规则](references/editing.md)写开场、点评与收尾；完整稿保留玩家原话和顺序，事实和行动由记录决定。核对角色、声线及权限，完成真实审核后记录 `review`；模板不是成稿。单玩家按其专门指南只用授权历史并保留空 `edits`。

```powershell
pnpm video:make --room=ROOM_ID --check-only --encoder=cpu
```

查看项目 `output/materials-check.json`：`ready: true` 才能进入配音；否则按 `issues` 修正稿件、声线或审核再检查，不直接修改通过标志。此检查不代表外部服务、ASR、封面或听感已就绪。[制作前准备](references/preproduction.md)包含配置和失败处理。

## 2. 分版编辑和独立叙事审阅

agent 分别写高光和精华，按原事件顺序选择可追溯原话，围绕各自观众补足前因、冲突、回应和结果；为每版单独写解说、故事卡与取舍理由。完整稿由制作 agent 核对事实和原话；高光、精华等需要内容取舍的稿件交给独立 reviewer，复核事实、原话、遗漏造成的误导、节奏和解说，并将审阅绑定当前稿件，改变稿件后重新审核。精华两种版式不另写第二套内容。程序只派生哈希、词索引、样本边界、时间、帧数与缓存键，核验绑定并执行，不代替内容创作和审稿。

按[编辑版制作](references/edited-video.md)准备编辑稿和审核记录；此时先确定内容，等下一步原始配音和可靠词时就绪后再编译选段。该文档说明稿件字段、命令和失败分支。真实原话必须可映射到可靠词时，不可用估计秒数或伪造边界。超过程序 720 秒上限时由 agent 重剪并重新审阅，程序不会替你删除内容。原有 `video:vertical` 的 120 秒旧流程保留为[兼容入口](references/vertical-highlights.md)，不是上述编辑版路线。

## 3. 配音、转写与时间对齐

完整片按[批量配音](references/tts-batch.md)准备 `voices.json`，编辑版按[编辑版制作](references/edited-video.md)的旁白 job 显式指定端点、模型和兼容音色。未来新配音优先 `qwen-audio-3.1-tts-flash`；已完成且绑定正确的 Plus 原音继续复用，不因偏好变化重配。模型、端点和音色需实际兼容，不把 Plus 的 voice ID 盲目用于 Flash。agent 保持每个角色固定声线，以完整句或自然段合成，按语义选择情绪指令并核对样音；音色目录和模型能力按[声线](references/character-voices.md)及[配音参考](references/tts-batch.md)核实。

先按批量配音指南执行到 `--through=tts`，取得完整稿原音；原音检查、转写和词时通过后，按编辑版指南编译已经审核的高光和精华稿，再用旁白 job 合成各自新增解说，并对新增音频执行同样检查。完整稿原音已可用时直接复用，不能为编译选段重复付费生成。渲染前应同时具备原音、编译后的 selection 和该版旁白 manifest。

若需要独立 ASR，执行前确认其授权和可用性；[音频核对指南](references/local-asr.md)说明本地模型注册、在线路线和别名。对照原稿、独立转写和原音处理 `needs-review`，只接受已核对的专名别名。用服务真实词时或可靠对齐生成字幕；`alignment-required` 时按指南取得可靠边界，中文缺少可靠字时则停止。转写内容、时间对齐和主观听感分开记录。破音按[音频质量](references/audio-quality.md)定点修复，重配完整句段并重新检查，不只改 sidecar。服务鉴权、额度或限流出错保留检查点，不自动切换付费线路或盲目重试。

## 4. 渲染与检查

完整稿材料、声音和授权就绪后，agent 在仓库根目录执行：

```powershell
pnpm video:make --room=ROOM_ID --encoding-profile=upload --resume
```

完整片默认使用 `upload` 编码配置；只有明确需要小体积本地副本时才选 `--encoding-profile=compact`。可用 `--video-quality=N` 覆盖编码质量值；NVENC 使用该值，CPU 路线使用 `N - 2` 作为 CRF。参数和实际码率限制见[上传画质与体积控制](references/compression.md)。

如要求独立识别，显式加入适合本局的 `--asr-provider=auto|local|qwen-token-plan|mimo-token-plan`，具体限制和补对齐选项见[音频核对指南](references/local-asr.md)。默认 `off` 不能声称独立听写已完成。`--resume` 重做门禁并复用有效缓存；先看 `workflow-status.json` 与对应阶段报告，再针对失败原因修正。完整片默认采用 `upload` 配置；编码器、profile、质量覆盖和实际码率限制见[制作前准备](references/preproduction.md)、[硬件](references/hardware.md)和[上传画质与体积控制](references/compression.md)。

高光与精华按[编辑版制作](references/edited-video.md)先验证选段，再对每个格式使用独立输出目录合成。进度 JSON 的 `rendered`、`total` 与 `cached` 显示执行进展；成功后查看 `output/verification.json`、`source-map.json`、`subtitles.srt` 和 MP4。相同输入身份且缓存通过校验才复用；输入、格式、编码器、编码配置或源画面改变时使用新输出目录，避免旧片段和新成片混淆。编码失败先读日志，核实 FFmpeg 和所选编码器；GPU 失败不谎报成功。不要清理正在运行的渲染。

程序验证只是机械检查。agent 对四套各自检查抽帧、完整播放、字幕语义分组、遮挡、角色和事实状态、转场及音画同步；在人物切换与真实 phase/chapter 边界抽取切点前后的连续帧，暂停逐帧检查字幕小字和画面细节，不能只检查场景中间的静态帧。具体抽帧方法见[上传画质与体积控制](references/compression.md#画面转场与清晰度检查)。人物切换及同一 phase/chapter 内的场景变化使用硬切；只有真实 phase/chapter 边界使用 4 帧淡出、4 帧淡入。独立 reviewer 审核每套叙事，精华横竖分别核对布局。听审独立记录，`subjectiveListening: not-checked` 不能当作通过。无法播放或听审时如实标未检查，问题回对应稿、音频或布局修复并重验，不把短样片测试扩大为整片验收。玩家视角额外核验权限和身份显示。

## 5. 封面、文案和交付

视频画面及发布标题、简介不额外添加房间号。房间号用于内部选局、来源校验和制作配置；检查交付文案与画面，删去手写的 `Room:` 行和旧页脚中的编号。若成片仍含旧页脚或发现源画面模糊，修改场景源后用新导出目录重渲染，并复用已核验音频；不要在交付 MP4 上运行 `delogo` 或再次压缩整片。代码更新不会自动修复已经发布到 YouTube 的旧视频。

每套成片各有与目标语言一致的封面、标题与简介；本次要求全英语时四套均用英文。按[封面制作](references/cover.md)制作和检查缩略图可读性、角色与权限，按各版内容写对应简介。完整上帝视角按[制作前准备](references/preproduction.md)和现有 `video:publish-copy` 约定核对席位与规则；单玩家遵守权限。生成服务需已有授权，程序不会自动生成封面。未完成的画面、听感或叙事审阅单列状态，不宣称完成。

验收后，agent 将四套最终视频、各自封面和简介转存到用户原桌面频道素材文件夹，逐项检查可打开、文件大小和哈希与已验收源一致，再从交付位置复核。确认转存无误、所有相关渲染已结束后，删除制作目录中所有成片副本及半成品、渲染缓存；仅保留原始素材（音频、剧本）与复现配置、必要审核记录。清理前确认路径与范围，不删源音频、剧本或唯一交付文件。若复制、校验或渲染尚未完成，则保留现有文件并报告阻碍。最终分别提供四套文件位置、程序验证、叙事、视觉、播放及听感状态。上传和发布由用户自行完成，agent 负责成片质量与素材交付；用户明确改变此分工后再接入频道授权或代传。

## 事实与恢复边界

- 事实、身份、存活、票型及行动以引擎记录为准；只使用授权视角，不能从模型思考猜动作或提前公开身份。玩家原话不得改写；系统托管须标明，行动转述不能冒充原话。完整上帝版保留主持链与全部原话；节选版明确是节选并保持事实因果。
- 时间轴依据真实 WAV 样本与经核对的服务时间戳或独立对齐，字幕文字以核准朗读稿为准，不以均分估时冒充真实词时。程序校验与人工审阅互不替代。
- 声线、配音与其他 TTS 适配见[批量 TTS](references/tts-batch.md)，真实语言样品的有限证据见[样品记录](references/real-tts-samples.md)。维护程序、bootstrap 或其他工作站接入见[程序设计](references/automation.md)；资源和密钥不提交 Git。
- 完整片异常先查看 `workflow-status.json` 和阶段报告；材料缺项回 `materials-check.json`，音频回[质量](references/audio-quality.md)或[ASR](references/local-asr.md)，画面回[硬件](references/hardware.md)。无法恢复时保留检查点并说明阻碍、实际成果与未验收范围。
