# 上传画质与体积控制

完整对局默认使用 `upload` 编码配置，面向上传后仍需经平台再次编码的成片。画面保持 1920×1080、30fps；视频先以所选配置逐段编码，最终拼接复制视频流，并统一编码 AAC。默认交付 `output/latest-match.mp4`，不经过第二次整片压缩。

## 选择完整片编码配置

`--encoding-profile=upload|compact` 选择完整视频流配置；省略时使用 `upload`。只有明确要求小体积本地副本时才选 `compact`：

```powershell
pnpm video:make --room=ID --encoder=gpu --encoding-profile=upload --resume
pnpm video:make --room=ID --encoder=gpu --encoding-profile=compact --resume
```

两种配置的目标如下。NVENC 使用 H.264 p7/hq、VBR、四分之一分辨率两遍分析、16 帧前瞻、空间/时间 AQ 和 32 个输入表面；CPU 使用 libx264 medium 与静态画面调优。两种编码器的质量数字并不相同：

| 配置 | 视频目标 / 峰值 | NVENC | CPU | GOP |
| --- | ---: | ---: | ---: | ---: |
| `upload`（默认） | 8000 / 12000 kbps | CQ 21 | CRF 19 | 60 帧 |
| `compact` | 750 / 1200 kbps | CQ 30 | CRF 28 | 240 帧 |

音频默认 96 kbps。需要调整编码质量时可传 `--video-quality=N`；它设置 NVENC 的质量值，CPU 路线使用 `N - 2` 作为 CRF。例如 `--video-quality=21` 对应 NVENC CQ 21 或 CPU CRF 19。数值越低，质量目标越高，通常会提高码率直到目标或峰值约束生效；它不固定最终码率或文件大小。目标码率、峰值和质量共同影响结果，实际大小以 `output/verification.json` 的 `bytes` 为准；不能将目标平均码率当成测得码率。

粗略估算可用：

`大小MB ≈ 时长秒 × (视频kbps + 音频kbps) ÷ 8000`

实际 VBR 文件大小会随画面复杂度变化。用户要求硬上限时先留足余量并用新目录试跑；不能默默降低分辨率。HEVC/AV1 需另行验证播放兼容性。

改变编码配置或源画面后，请使用新的 `--project-dir` 作为独立导出目录，并引用已核验的原音 WAV 与元数据。这样不会把旧配置的半成品和新成片混在一起；已完成的 TTS 音频可以复用，无需重新合成。不要把旧成片交给 `compress.ts` 当作修复画面的方法。

## 画面转场与清晰度检查

同一真实 phase/chapter 内的人物或场景切换使用硬切，不对每次发言切换添加整屏淡黑。只有真实 phase/chapter 边界使用 4 帧淡出、4 帧淡入。同格式的图片或主体切换可以硬切。逐段编码参数一致时，最终拼接继续复制视频流，不重新编码整片。

进入整局渲染前，先用样品检查代表性白天、夜间、人物切换和 phase/chapter 边界。对每类切换点抽取切点前后的连续帧，暂停逐帧查看小字、细线、头像和边缘是否清楚；只看场景中间的静态帧不足以检查转场。整局成片也要按相同方式抽查关键切换点，并完整播放。

从 `timeline.json` 或选段边界取准确切点秒数，以下示例在切点前后连续导出 12 帧（30fps 下约 0.4 秒），再按文件序号逐张检查：

```powershell
$boundarySeconds = 360.0 # 替换成实际 phase/chapter 或人物切换时间
$startSeconds = [Math]::Max(0, $boundarySeconds - 0.2)
New-Item -ItemType Directory -Force -Path review-cuts | Out-Null
ffmpeg -ss $startSeconds -i output/latest-match.mp4 -frames:v 12 -fps_mode passthrough review-cuts/cut-%03d.png
```

对文字、票源号码和细边缘，在画面暂停状态下放大确认；只有静态中间帧清楚，不能代表切换前后每帧清楚。

## 历史 compact 实测

2026-11-01 的 46 分 04 秒对局使用当时的原生小体积配置：1080p/30fps、158 段全部 NVENC，直接导出 262,076,815 字节（约 262MB），实际平均总码率 758.4 kbps。较旧版 944,392,555 字节减少约 72.2%，51 条玩家原话完整保留。这是旧 compact 配置的历史实测，只说明该局结果，不代表新的默认 `upload` 文件大小或其他对局的结果。

## 实际验证与记录

先生成真实时间轴，再用 `render.ts --only=片段ID` 试做，保持同一项目环境、声音和字幕文件。不同参数比较使用独立导出目录。配置和底图变更后不要复用旧成片来判断效果；`render.ts --plates-only` 只能看静态排版，不能证明编码、转场或细字在视频中清楚。

- `encoding-settings.json`：采用的配置和第一遍编码参数。
- `segments/*.mp4.json`：逐段实际编码器、大小和耗时；强制显卡模式必须全部为 `h264_nvenc`。
- `output/render-report.json`：整片大小、耗时、配置是否从第一遍生效、最终拼接是否重新编码视频。
- `gpu-metrics.json`：整卡显存与编码器利用率采样，包含其他程序，不能冒充进程独占显存。
- `output/verification.json`：实际帧数、音画时长、原话完整性、章节和实际平均总码率。

## 仅对用户指定的旧文件压缩

`compress.ts` 仅在用户明确要求压缩已有文件时使用，并输出到新路径：

```powershell
pnpm video:compress --input=已有视频路径 --crf=28 --output=新文件路径
```

它用 libx264 medium、静态画面调优和 AAC 96 kbps，无法恢复源图细节，也不更新旁白、规则卡或画面规范。删除房间号页脚、修复模糊或调整转场时，修改源画面后用新导出目录重渲染，并复用已核验的音频；不要对已编码整片套 `delogo` 或再压缩。
