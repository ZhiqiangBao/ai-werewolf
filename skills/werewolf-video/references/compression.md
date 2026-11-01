# 原生小体积导出

默认保留 1920×1080、30fps，直接把体积控制放在第一遍编码里。`render.ts` 的每个片段都使用有限码率，最终复制视频流、统一编码 AAC；`output/latest-match.mp4` 就是交付文件。默认流程没有“先生成大母版，再压缩”的阶段。

## 直接导出

```powershell
pnpm video:make --room=ID --encoder=gpu --video-kbps=750 --max-video-kbps=1200 --audio-kbps=96 --resume
```

内置 `encoding.ts` 管理参数。NVENC 使用 H.264、p7/hq、VBR、CQ 30、四分之一分辨率两遍分析、16 帧前瞻、空间/时间 AQ、32 个输入表面；关键帧间隔 240 帧。CPU 使用 libx264 medium、CRF 28 与相同码率约束。先用代表性昼夜片段检查字幕、技能卡细字、票源号码、金色边线和夜景暗部，再跑整局。不同机器上的速度、显存和编码器支持以实测为准。

`--video-kbps` 是目标平均视频码率，`--max-video-kbps` 是峰值约束，AAC 默认 96kbps。VBR 加质量目标不保证精确文件大小；不要把目标平均码率或峰值写成实际码率。估算用：

`大小MB ≈ 时长秒 × (视频kbps + 音频kbps) ÷ 8000`

例如 46 分钟、750+96kbps 约 292MB，容器另有少量开销。成片体积以 `verification.json` 的 `bytes` 为准。用户要求硬上限时预留余量，必要时降低目标和峰值；不能默默降低分辨率。HEVC/AV1 属于另行验证的选择，先确认播放兼容性。

## 实际验证与记录

先生成真实时间轴，再用 `render.ts --only=片段ID` 试做，保持该项目环境与声音、字幕文件一致。不同参数比较使用独立测试目录；编码配置进入缓存键，不能仅改文件名便复用旧编码。`render.ts --plates-only` 只能看静态排版，不能证明编码可用。

- `encoding-settings.json`：第一遍编码参数。
- `segments/*.mp4.json`：逐段实际编码器、大小、耗时；强制显卡模式必须全部为 `h264_nvenc`。
- `output/render-report.json`：整片大小、耗时，是否从第一遍就控制体积，最终拼接是否重编码。
- `gpu-metrics.json`：整卡显存与编码器利用率采样，包含其他程序，不能冒充进程独占显存。
- `output/verification.json`：实际帧数、音画时长、原话完整性、章节和实际平均总码率。

## 仅对已有旧文件再压缩

`compress.ts` 仍可用于用户指定的已有文件，不属于默认制作流程：

```powershell
pnpm video:compress --input=已有视频路径 --crf=28 --output=新文件路径
```

该工具用 libx264 medium、静态画面调优、AAC 96kbps。不要为新项目主动建立大型中间视频再调用它。压缩已有文件不等于更新了旁白、规则卡或画面规范。
