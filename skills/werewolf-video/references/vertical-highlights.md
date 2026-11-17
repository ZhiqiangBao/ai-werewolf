# 竖屏完整片、剪辑与样片

从[制作清单](production.md)选 `format: "vertical"`。完整片使用 `kind: "full"`，保留该视角的全部原话和真实流程；需讲述一个具体看点时使用 `kind: "edit"`；只取指定原话或分段使用 `kind: "sample"`。三者都可以选上帝或具体玩家。竖屏显示当前视角，玩家版持续显示本席编号和本席可见的身份。发言人切换不会改变观看者视角。画面、标题和 MP4 元信息去掉固定“节选”标记。

使用 1080×1920、30 fps，从原始画面按竖屏重新排版。检查本席身份、发言人、字幕与故事卡在手机上可读。人物发言直接复用同局原音；授权剪辑的新解说和真实词时按[编辑版制作](edited-video.md)处理。渲染输出应当同时提供该版字幕和来源映射。

## 单项渲染入口

在仓库根目录运行，源项目已按相同房间与视角准备，输出目录与源项目分开。完整玩家可使用 `--full-player` 明确要求该席。样片输入为 `sample.ts` 已准备且配有授权原音的项目。

```powershell
pnpm video:vertical --source-project=源项目 --full --output-dir=本版渲染目录 --encoder=cpu
pnpm video:vertical --source-project=样片项目 --sample --output-dir=样片渲染目录 --encoder=cpu
```

完整上帝、完整玩家、样片输出分别为 `output/full-god-vertical.mp4`、`output/full-player-vertical.mp4`、`output/sample-vertical.mp4`。字幕在同目录的 `subtitles.srt`。需要横竖共用一份剪辑稿时，两版都从同一编译选段及旁白清单渲染。

旧的纯原音高光入口仍接受 `--selection=文件`。其中上帝高光原先的 120 秒限制仅作用于此种选择；完整片和样片按真实内容时长。旧选段须给出房间、主题、源文件摘要、已审原话、WAV 摘要；裁半句时按实际词时设置区间。单玩家额外审阅本席选段和故事卡，用 `playerSeat`、`sourceSha256`、`visibleFactsOnly` 和 `clipsSha256` 绑定已审内容。成片仍按[码率验收](compression.md)和[玩家权限](player-view.md)核验。

正式交付前播放并检查每个转折的画面和声音，抽查人物与阶段切换处的字幕。合成成功后播放器的标题也应对应本视角。没有实际听审时，在交付说明中列明未听审范围。
