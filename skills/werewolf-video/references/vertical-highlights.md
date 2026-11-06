# 旧版竖屏高光兼容入口

此页只记录仍可使用的旧 `video:vertical` 入口。新高光／精华含新增解说及横竖版式请走[编辑版制作](edited-video.md)；完整制作入口见[主流程](../SKILL.md)。当前只支持已结束对局的上帝视角项目，单次选择合计不超过 120 秒。制作复用项目内已有原话和 WAV，不调用 TTS、ASR 或其他外部接口，不改词、不变速。

## 准备源项目与输出位置

用户提供已结束对局的上帝视角制作项目，并说明希望保留的情节；若用户请 agent 自选，agent 按原始事件顺序挑选并写明原因。agent 先确认项目位于游戏仓库，且包含：

- source.json、script.json、clips.json、avatar-theme.json、voices.json；
- audio/ 下与 clips 对应的 WAV 文件及 JSON 元数据；
- 可靠的提供方字时或已验证的对齐数据。

source.json 与 script.json 应指向同一局，且 status 为 ended、perspective 为 god。agent 以 script/events 等记录核对事实，从原始台词和音频核实所选范围；不根据评论、总结或模型分析猜测原话与游戏结果。程序会逐项比较来源事实、文字、WAV 哈希、波形、字时和时间范围，但不会替 agent 判断事实是否真实、选段是否合适。

使用 Node.js 22.12+、仓库依赖和可调用的 FFmpeg/FFprobe。此流程不需要 TTS/ASR 凭据。输出目录的父目录必须已存在，输出目录自身必须尚不存在，并且来源项目与输出目录不得互相包含。把 selection JSON 放在输出目录以外；建议将审核计划和输出都放在 data/video 忽略目录下。不要覆盖或清理已有产物。

## 核对并写审核计划

为每个选段核实来源 clip、原话、事实和音频范围，并在单独的 JSON 计划中填写：

- roomId：来源房间 ID；
- sourceSha256：source.json 原始字节的 SHA-256；
- reviewed：完成逐项核对后才设为 true；
- theme：与 avatar-theme.json 中的主题一致；
- clips：至少一项，按来源顺序排列且不能重复。每项填写 id、quote、factReview、audioReview、excerptNote 和对应 WAV 的 audioSha256。

可用 PowerShell 计算程序所需的小写 SHA-256：

~~~~powershell
$sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $sourceProject 'source.json')).Hash.ToLowerInvariant()
$audioHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $sourceProject "audio\$clipId.wav")).Hash.ToLowerInvariant()
~~~~

完整片段的 quote 必须逐字等于 clips.json 中的 spokenText。若只保留片段中的一段，使用真实字时映射所得的零起始、左闭右开的 wordStart/wordEnd；quote 必须等于该范围原词拼接并 trim 后的文本。字词索引从当前有效的 sourceCaptionWords 映射读取，不能按估计秒数裁切，不能压到相邻词。audioReview 如实写明检查方式、范围以及是否做过主观听审；程序只检查该字段非空，不验证陈述真假。

sourceSha256 或 WAV 哈希改变、主题不符、原话或字时不符、波形不合格、选段乱序或总时长超限都会中止。先修正源项目或审核计划，并重新核对；没有可靠字时就停止，不要估算或伪造。selection JSON 与 source-map.json 会包含实际选用原话，按项目素材保密，只保留在忽略目录；不要把真实原话、私密对话或本机绝对路径复制进 tracked 文档、代码或公开报告。

## 合成

在仓库根目录将以下变量替换为本机的来源项目、审核计划及一个全新输出目录。CPU 使用 libx264；只有环境确实具备 NVENC 且希望使用 GPU 时才选 gpu。GPU 模式失败会报错，不会静默回退。

~~~~powershell
$sourceProject = '<已结束上帝视角项目的绝对路径>'
$selectionPath = '<审核计划 JSON 的绝对路径>'
$newOutput = '<尚不存在的独立输出目录>'
$verticalArgs = @(
  "--source-project=$sourceProject",
  "--selection=$selectionPath",
  "--output-dir=$newOutput",
  '--encoder=cpu'
)
pnpm video:vertical @verticalArgs
~~~~

若 pnpm 命令不可用，在同一仓库根目录、保留 verticalArgs 中相同参数，改用：

~~~~powershell
node node_modules/tsx/dist/cli.mjs scripts/video/vertical-highlight.ts @verticalArgs
~~~~

运行时每完成一个片段会输出包含 rendered、total 和 clip 的进度 JSON。成功后检查这些文件：

- output/highlight-vertical.mp4：成片；
- output/subtitles.srt：字幕；
- output/source-map.json：片段、字时和源样本映射，含审核选择中的原话；
- output/verification.json：程序验证摘要；
- review/：每段一张抽帧，供人工视觉检查。

画面规格为 1080×1920、30 fps，按所选原始 PCM 样本计时，片段间加入约 0.2 秒静音，不变速。画面顶部显示游戏品牌徽记和游戏英文名 MOONSHADOW HALL，较小的副标题为 AI WEREWOLF；阶段标题旁配昼／夜图标。玩家发言时以当前头像为主体，座位号与身份各用游戏画面同款黄底圆角徽章贴在头像自身左下、右下，名字小字置于头像正下方；头像外沿连续柔软波浪随实际 PCM 响度局部鼓起回落，静音时退去。法官、解说、行动与投票场景把全桌头像沿紧凑椭圆桌沿排布，并显示当时真实的存活和警徽状态；有投票结果时显示真实票型。竖屏目前未接入角色技能动画。阶段与来源标记保持小字，字幕浮在下方，不加规则栏或字幕框。转场为 4 帧淡出、4 帧淡入，不改变所选声音片段的计时。

## 验收并反馈

先读 output/verification.json，确认命令成功、输出存在、尺寸为 1080×1920、帧率为 30 fps、帧数与音视频时长通过校验，且 encoder 是本次选择的实际编码器。程序检查源文件与 WAV 哈希、审核字段、原话、波形、字时、帧数及音视频时长；它不能代替以下人工检查。

逐张查看 review/ 中的抽帧，至少确认每段人物、徽章、名字、阶段/来源文字和构图没有裁切或错位；再播放成片，核对字幕、票型、事实状态和转场。若无法播放成片，明确把整片播放检查记为未检查。主观听审另行记录：程序的 verification.json 固定写 subjectiveListening 为 not-checked；程序不会把人工试听状态自动更新为通过。没有实际试听时，如实报告“主观听审未检查”。

真实试跑记录：房间 afb1f5fc51 的 v6 试片通过程序验证，6 段、1080×1920、30 fps、h264_nvenc、865 帧；视频时长约 28.83 秒，音频时长约 28.833 秒。程序生成了 6 张逐段抽帧，主代理会检查最终画面后再交付；完整视频播放与主观听审尚未检查，verification.json 的 subjectiveListening 为 not-checked。

交付时分别说明程序验证、抽帧检查、整片播放和主观听审的状态，并提供成片与核验记录。source-map 只用于追溯选择与时间，不把其中原话贴入报告。

## 失败时怎么处理

| 可见错误或反馈 | agent 的下一步 |
| --- | --- |
| Wrong room or source hash、Audio hash mismatch | 核对所选 source project、房间号及 WAV；按原始文件重新计算 SHA-256，再修正计划。 |
| Selection has not been reviewed、Missing quote or factual/excerpt review | 完成真实事实、原话和范围审核，补齐对应记录；不可只把 reviewed 改成 true。 |
| Quote differs from word range、Invalid word range、Word range overlaps adjacent words | 从当前有效对齐重取词索引与字时，重算 quote 和范围；没有可靠字时就停止。 |
| Audio waveform failed inspection、Caption text mismatch | 检查对应 WAV、元数据和有效字时；修复来源项目或换选段后重新审核，不在本流程中伪造音频或文字。 |
| Selection exceeds 120 seconds | 减少片段或按可靠词时缩短节选，然后重新检查原话与总时长。 |
| 输出目录已存在、Output must be separate from source project | 不覆盖、不删除旧目录；选一个父目录已存在且与来源互不包含的新输出路径。 |
| FFmpeg/FFprobe 启动或编码失败 | 检查可执行文件路径及本机编码器。若 NVENC 不可用且 CPU 可接受，改为 cpu 并使用全新输出目录；不要把 GPU 失败报告为成功。 |
| Video frame verification failed、Audio/video duration mismatch | 保留失败目录供诊断，检查 FFmpeg/FFprobe 输出及输入素材；原因修正后使用新的输出目录重跑，不交付未通过验证的文件。 |

程序在输出目录建立后失败时会留下目录和中间产物，这是为避免覆盖而保留的检查点。确认失败原因、修正来源或计划、再换新目录；不要盲目重复运行或删除旧证据。
