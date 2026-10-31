---
name: werewolf-video
description: 将本项目已结束的狼人杀对局记录制作成配音驱动的上帝视角视频，包括剧本取舍、人物音色、Qwen TTS、精确字幕时间轴、离线画面、检查和压缩。适用于真实日志重建与该制作程序的维护。
---

# 狼人杀对局视频

使用目标仓库里的确定性程序完成机械步骤。模型主要负责审核人物声音和润色少量上帝台词。默认交付完整对局，不新增实时录屏功能。

## 先定位，再运行

目标是 `package.json` 名为 `ai-werewolf` 的游戏仓库。程序位于 `scripts/video/`，依赖由项目锁文件维护。命令在仓库根目录执行：

```powershell
pnpm video:make --room=latest --prepare-only
```

`latest` 只从默认 `data/rooms` 选择已结束对局，不扫描界面测试目录。指定另一数据目录用 `--data-dir=绝对路径`；指定房间用 `--room=ID`。

读取输出项目的 `plan.json`，审核 `narration.json` 和 `voices.json`。先读 [发言取舍规则](references/editing.md)，再修改台词。用户已要求制作整局且授权 TTS 时，完成内部审核后直接继续，不把普通检查点变成人工审批。

```powershell
pnpm video:make --room=ID --resume
```

这一条依次完成导出、剧本准备、TTS、音频时间轴、画面渲染、节选预览和检查。已成功的音频与视频片段自动复用。没有 pnpm 可直接运行：

```powershell
node node_modules/tsx/dist/cli.mjs scripts/video/workflow.ts --room=ID --resume
```

其他 agent 可用本技能的 `scripts/run.mjs --project=仓库绝对路径` 启动同一程序。如果目标仓库缺少制作程序，使用 `scripts/bootstrap.mjs --project=仓库绝对路径` 安装随技能附带的程序和美术资源，并补齐缺失的依赖声明与启动命令；已有实现保持原样。随后用项目包管理器安装依赖。游戏导出模块仍来自目标游戏仓库。

## 必须保持的约束

- 从真实事实流恢复身份、存活、警徽、票型与昼夜；不要从自然语言或模型思考猜动作，不提前显示后续结果。
- 默认完整保留玩家公开发言、遗言、狼队密谈的原话与顺序。长发言可以分段，但拼接必须还原原文。
- 法官短播报与上帝点评有明确的声音和画面标签；上帝可解释已经发生的反差，不编造玩家动机。
- 一位玩家固定一个声音，法官、解说分别固定声音。依据昵称、人设与人物图核对声线，不给全桌同一音色。
- 使用实际 WAV 样本数与 Qwen 逐字时间戳。无时间戳时停止并做真实对齐；不估算阅读时长冒充正式时间轴。
- 当前成片是上帝视角，含私密夜间信息。玩家/闭眼版本需要先实现权限过滤，不能复用全知显示。
- Qwen 仅用已获准的 Token Plan 凭据；程序在内存读取密钥，产物不包含密钥或房间令牌。鉴权、额度或限流失败时保留检查点并报告，不切换付费线路。

## 可调选项

- `--encoder=cpu`：无需独立显卡；`auto` 自动尝试 NVIDIA 编码并允许软件回退。
- `--theme=campus|storybook|gufeng|fantasy|urban|future`：六套人物；更换后核对声音与人物是否相符。
- `--voices=绝对路径`、`--narration=绝对路径`：显式使用已整理的配置。
- `--through=plan|tts|timeline|render|preview|verify`：停在完整的阶段检查点。

默认单路编码；显存与性能判断读 [硬件说明](references/hardware.md)。修改 API、程序或适配新日志时读 [自动化程序设计](references/automation.md)，其中含文件分工、接口、SSE/WAV 处理、缓存、恢复与测试要求。压缩建议和可运行命令见 [压缩方案](references/compression.md)。

## 验收和交付

以 `output/verification.json` 为程序检查结果；同时看 `output/review/` 的夜间、玩家发言、票型与终局帧，试听至少一个玩家和一个上帝片段。文字、号码和身份标签应清楚，状态不能遮住人物。

交付 `output/latest-match.mp4`，可附 73 秒左右的 `workflow-preview.mp4`（时长随对局变化、含终局节选）、字幕与时间轴；说明时长、体积和有无节选。需要小体积时制作独立分享版，保留母版。

为节省其他模型的上下文，优先读取 `plan.json`、`workflow-status.json`、`verification.json`。不要把原始房间文件、完整时间轴和音频元数据全部打印进上下文。发布和上传不是默认制作步骤。
