# 显卡、内存与速度

本工作流使用云端 Qwen TTS，画面由 CPU 绘制已有的背景、桌子和头像。独立显卡是视频编码加速选项；CPU 编码也能完成。

## 1080p / 30fps 的预算

- 无独显：`--encoder=cpu`，速度由 CPU 决定，成片结构相同。
- NVIDIA 硬件编码：确认显卡、驱动、FFmpeg 支持 NVENC。工程上建议 4GB 显存起，并预留约 1–2GB 空闲显存；8GB 有更多余量。
- 上述 4GB 是余量建议，未在 4GB 显卡上实测，也不是 NVIDIA 发布的最低要求。编码器、缓冲、分辨率和其他程序会改变占用。
- 本地 IndexTTS 或其他生成模型的显存需要另测，不能沿用这份纯合成预算。

NVENC 是专用视频编码能力；支持情况看 [NVIDIA FFmpeg 指南](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/ffmpeg-with-nvidia-gpu/)和 [GPU 支持表](https://developer.nvidia.com/video-encode-decode-support-matrix)。本程序的 Canvas 绘图没有因此自动迁移到 GPU。

## 本次观察与局限

RTX 5060 Laptop 8GB 已完成 43 分钟 1080p 全局。双路编码期间曾遇到输入缓冲分配失败；改为单路、限制解码与滤镜线程、限制编码缓冲后完成。

末段 45 秒、24 次采样，整卡占用峰值为 221MiB；较早另一次整卡快照为 2550MiB。整卡指标包含其他程序，且末段采样不是完整进程峰值，不能把 221MiB 当作最低显存。实际使用应采样自己的工作负载。

Windows 的系统提交内存也会影响分配成功与否。遇到分配失败时先降低并发和线程，不把错误直接解释为“8GB 卡不够”。不要擅自关闭用户程序、修改分页文件或更改系统安全设置。

## 程序设置

默认 `VIDEO_JOBS=1`。编码器限制 `-threads 1`、`-filter_complex_threads 1`，NVENC 输入表面数量限制为 8；硬件编码失败会尝试软件编码。用户明确希望吞吐优先且内存充足时，可测两路，不应直接把并发拉满。

`gpu-metrics.json` 保存整卡采样，`workflow-status.json` 保存当前阶段。不要以显卡“总显存”代替可用显存，也不要把平均占用写成峰值。磁盘保留母版、片段和音频缓存，建议留出数 GB 余量；不要自动清理用户原始存档。
