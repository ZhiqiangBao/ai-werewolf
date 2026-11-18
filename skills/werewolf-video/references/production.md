# 一局多版制作清单

制作人把同局的交付要求写在一个 JSON 文件中，放入忽略的制作目录。路径相对清单所在目录解析。使用真实房间号。每行版本独立命名；省略 `playerSeat` 表示上帝视角，提供席位号表示引擎导出的该玩家视角。下面仅展示两种可组合的版本。

```json
{
  "roomId": "ROOM_ID",
  "uiLocale": "zh-CN",
  "encoding": { "videoKbps": 750, "maxVideoKbps": 1200, "audioKbps": 96 },
  "editions": [
    { "id": "04-完整横屏", "kind": "full", "format": "horizontal" },
    { "id": "05-完整竖屏平民视角", "kind": "full", "format": "vertical", "playerSeat": 2 }
  ]
}
```

| 字段 | 用法 |
| --- | --- |
| `kind` / `format` | `full` 完整片，`edit` 按稿剪辑，`sample` 取指定原话。各支持 `horizontal` 或 `vertical`。版本名中的身份须与所选席位实际身份吻合。 |
| `cut` | 剪辑版引用顶层 `cuts` 的一项，如 `"cuts":{"警徽票":{"manuscript":"警徽票.json","reviewFile":"警徽票-审阅.json"}}`。同视角的横竖剪辑引用同一项即可共享选段和解说。[稿件格式](edited-video.md) |
| `selection` | 样片使用 JSON 文件，例如 `{"description":"警徽投票","sections":[{"title":"投票前","sourceSeqs":[23],"parts":{"23":[3]}}]}`。序号选该视角的已导出事件。省略 `parts` 保留事件的全部分段。 |
| `masterProject` | 已有同局完整上帝原音项目的路径。请求上帝完整版时，默认主项目为 `data/video/房间号`；如果指定了新目录，该目录将用于制作上帝完整版。单独制作衍生版时可直接指向已有原音。 |
| `dataDir` / `workDir` | 默认读取仓库 `data`，多版工作目录为 `data/video/房间号-production`。各席位源稿与排版缓存分开。 |
| `deliveryRoot` / `materialsDir` | 默认交付根目录为桌面的 `月影议事厅-频道素材/05-对局成片`，其下使用 `房间号/版本名`。各版编辑材料默认在工作目录的 `materials/版本名`，也可逐版指定。 |
| `encoding` | `videoKbps` 视频平均上限，`maxVideoKbps` 编码器最大码率参数，`maxTotalKbps` 可选整文件平均上限，`audioKbps` 音轨目标。实测两秒峰值仅供报告。显式选择高码率档使用 `"profile":"upload"`。 |
| 其他设置 | `encoder` 可选 `auto`、`cpu`、`gpu`；`theme`、`ttsModel`、`asrProvider`、`alignmentProvider` 沿用[制作前准备](preproduction.md)的取值。语音按房间语言，画面按 `uiLocale`、记录的界面语言、系统界面语言依次取值。 |

## 从备料到交付

在仓库根目录执行。已安装依赖的工作站也可用 `node --import tsx scripts/video/workflow.ts` 替代 `pnpm video:make`。

```powershell
pnpm video:make --production=制作.json --prepare-only
# 写本局解说或选段稿，核对声音与事实
pnpm video:make --production=制作.json --check-only
pnpm video:make --production=制作.json --media-only
```

`--media-only` 会生成所选各版的视频和字幕，便于播放、审阅、取封面参考帧。只允许使用现成原音时加 `--reuse-only`；需要补配的台词会报出片段 ID。程序读出已绑定的同局原音再调用配音。ASR 默认关闭。asrProvider 适用于完整原音和本版所选原话；如需另外识别剪辑版新增旁白，在该 cut 指定 narrationAsr 为 qwen-token-plan。

打开各版成片，确认本版真正呈现的看点。写每版的 `publish-copy.md`，使用独立的 `# 标题`、`# 简介` 段落（英文可用 `# Title` 和 `# Description`）。把实际由生图模型绘有短标题的原图保存为 `cover.png`。在同目录的 `publication-draft.json` 填入事实和实际发给模型的整段提示词，例如以下结构，所有示例值均需替换。

```json
{
  "highlight": { "sourceSeqs": [23], "description": "本版哪句话或哪个动作改变了现场判断" },
  "coverTitle": "本版定稿的短标题",
  "submittedPrompt": "实际发送的完整提示词，其中逐字给出本版定稿的短标题"
}
```

```powershell
pnpm video:make --production=制作.json --record-publication --reviewed-by=实际复核人
pnpm video:make --production=制作.json --deliver-only
```

登记前在缩略图大小逐字检查标题，和实际选段核对文案。程序自动绑定当前文案、封面及来源；完整上帝版按真实存档补上座位和规则说明。需要只登记或转存一版时加 `--edition=版本名`。四件素材齐备后，正常运行不带阶段参数的清单也会执行渲染与交付。改动标题、提示词或封面后重新登记；改动稿件、原音、界面或码率后重新渲染受影响的版本。交付失败保留原音和工作目录，可按报错继续。低层 `--room` 命令供单视角配音和渲染使用；发布的四件套由制作清单交付。

竖屏渲染程序升级后，`--deliver-only` 可以按现有回执转存同一输入和编码设置生成的媒体。重新渲染时使用当前版本的分段缓存。
