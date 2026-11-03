# 单玩家视角制作

本流程读取本机完整房间文件，执行者需要有权使用该房间及指定座位的历史信息。成片仍包含该玩家收到的私密内容，分享前应确认接收者有权观看。

无需选择活到最后的玩家。视频从引擎保存的整局事件重建该座位视角，模型出局后停止接收消息不影响这份记录；本人出局后的公开发言、投票、出局和结局继续保留，其他人的夜间私密行动继续按权限过滤。制作时不补写该玩家出局后的发言或思考，也不重新调用出局模型。上帝视角的整局制作仍是未指定 `--player-seat` 时的默认模式。

在仓库根目录执行（只支持已结束对局）：

```powershell
pnpm video:make --room=ROOM_ID --player-seat=5 --prepare-only
pnpm video:make --room=ROOM_ID --player-seat=5 --check-only --encoder=cpu
pnpm video:make --room=ROOM_ID --player-seat=5 --resume
```

将 `5` 换成获授权的座位。每一步使用相同座位；默认项目在 `data/video/ROOM_ID-player-5/`，独立导出在 `data/exports/ROOM_ID-player-5-video-script.json`。指定 `--project-dir` 时必须使用新的空目录，目录会绑定房间及座位。源记录变化后另用新目录，避免复用旧音频或画面。不要把上帝视角、其他座位或其他版本的素材复制进来。

准备阶段生成 `plan.json`、`editorial-context.json`、`narration.json` 和 `voices.json`。确认它们都属于目标房间与席位，完成原话和权限核对后填写下文的 `review`，运行 `--check-only`；只有 `output/materials-check.json` 显示 `ready: true` 才运行 `--resume`。若 `issues` 非空，按报告修正后重做检查；没有 `ready: true` 时不启动 TTS。

导出只使用该座位有权接收的历史事件和公开事件，终局全知 `review` 即使标为公开也会排除。画面身份固定为：本人显示真实身份，所有其他座位始终标记“身份未知”，不显示阵营存活统计，也不根据之后的查验或其他信息改写身份图例。授权给该座位的查验结果、狼队密谈等原始可见消息仍按事件顺序保留在发言与字幕中；保留原话不等于把它们回填成其他玩家的身份标签。不得从终局 `review` 或最终 `knownIdentities` 倒推历史画面。规则区只显示本人身份的默认简介，不读取全局规则卡或全部身份。素材不读取座位人设、模型配置或上帝点评。字幕及配音只来自过滤后的事实和发言；玩家版不支持自由撰写、替换或追加旁白，也不能通过 `--narration` 或 `--voices` 引入外部版本。它不会根据事后事实补充角色或死因，因此可能比该玩家实际获知的信息更保守。

如在独立副本 `data/media-work/isolated` 中操作，而真实房间仍位于外层 `data` 目录，先在仓库根目录设置数据路径，并在三步命令中都传入同一个 `--data-dir`：

```powershell
$dataRoot = (Resolve-Path ..\..).Path
pnpm video:make --data-dir=$dataRoot --room=ROOM_ID --player-seat=5 --prepare-only
pnpm video:make --data-dir=$dataRoot --room=ROOM_ID --player-seat=5 --check-only --encoder=cpu
pnpm video:make --data-dir=$dataRoot --room=ROOM_ID --player-seat=5 --resume
```

这样默认目录为外层 `data/video/ROOM_ID-player-5/`；若额外指定 `--project-dir`，请传绝对路径并保持三步完全相同。不要用默认的隔离副本 `data` 代替包含真实房间的外层目录。

播放器版在成功配音时记录原始音频、参数和座位来源的摘要；时间轴、渲染和验收会校验这些记录，并将主音轨逐段与授权音频核对。旧版没有这些记录的音频不可直接复用，请为该座位新建项目目录重新配音；不要手改摘要来绕过检查。

当前单玩家视角不支持 `--repair-audio` 自动定点重配。该修复流程面向上帝视角，不能为玩家版更新或证明绑定座位的音频来源。遇到片段问题时保留旧项目和产物，在新的空项目目录重新准备、审核和制作；不要覆盖旧音频或把修复后的文件放回旧项目。

准备后核对 `plan.json`、`editorial-context.json`、`narration.json` 与声音。完成核对后，在 `narration.json` 中填写 `review`：`status` 为 `reviewed`，`method` 描述实际核对方法，`factsChecked`、`playerQuotesUntouched` 和 `futureResultsNotUsedInProcessCommentary` 均为 `true`。保留 `playerSeat`，`edits` 必须是空对象；审核记录不得写入其他座位的私密资料。检查通过才会进入配音。使用外部 TTS 前确认该玩家可见内容的外发范围已获授权。

制作节选时先完成同座位完整项目的材料准备，并在单独的 JSON 文件中列出按顺序选择的 `sourceSeqs`；格式与现有 `sample.ts` 相同。将环境变量 `VIDEO_ROOM`、`VIDEO_DATA_DIR` 和 `VIDEO_PLAYER_SEAT` 设为同一房间、数据目录和座位，再把 `VIDEO_PROJECT_DIR` 设为新的空样片目录，运行 `node --import tsx scripts/video/sample.ts --selection=选择文件绝对路径`。样片不会从整片复制音频，需在这个目录重新配音、生成时间轴并渲染，再以 `verify-sample.ts --video=成片绝对路径` 核验。脚本和缓存都必须来自同一座位的当前授权导出；不能用上帝版或其他座位的数据。

验收时逐项核对过滤后的源稿、素材、字幕、时间轴、音频和实际画面，尤其检查身份标签、夜间行动、密谈、出局标识及终局；程序检查不能替代视听审核。不要使用上帝版封面、发布文案或含全知信息的截图。切换座位必须重新导出并制作；语言选项只改变标签语言，不改变权限。
