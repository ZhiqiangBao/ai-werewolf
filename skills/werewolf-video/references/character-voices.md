# 立绘与默认声线

新项目优先使用显式 `--theme`，未指定时读取房间公开的 `avatarStyle`，旧存档缺失时使用 `campus`；直接准备时可用 `VIDEO_AVATAR_STYLE` 显式指定。准备完成后查看本局 `art-manifest.json`，它列出实际图集路径、逐席行列、外貌性别以及声音文件中的实际声线。图集从左到右、从上到下编号；角色设定原文见 [立绘原始提示词](../assets/art/moon-village/prompts.json)，完整默认映射见 `scripts/video/character-voices.ts`。这些是中性座位外观，不代表本局身份；真实房间中的昵称、身份和记录不因此改变。

以下是旧版 Plus 模型从 Qwen 音色目录记录的候选，不可直接当作 3.1 Flash 的可用音色。新配音优先核实 Flash 兼容模型、端点与声线，已完成且绑定正确的 Plus 原音继续复用。`voice` 的完整参数均为 `qwen-audio-3.0-tts-plus-` 加表中后缀，目录语种均标为中文。年龄和特质为目录标签，并非听审结论。12 席在每套主题内各用不同声线，跨主题可复用；例如校园 7、8、9、10 席分别为男、女、男、女，而童话为女、男、女、男。

| voice 后缀 | 目录性别 | 目录年龄 | 目录特质 |
| --- | --- | --- | --- |
| longyanfengying | 男 | 24 | 冷静沉稳音 |
| longlingxingxia | 女 | 23 | 客观冷静音 |
| longxinruixuan | 男 | 24 | 自然亲和音 |
| longlingjinquan | 女 | 24 | 元气少女音 |
| longwangjixi | 男 | 25 | 睿智亲和音 |
| longlanlingying | 女 | 24 | 灵动少女音 |
| longlanyufu | 男 | 22 | 温柔亲和音 |
| longshuangxuandie | 女 | 22 | 爽朗利落音 |
| longfenglanlu | 男 | 25 | 清朗少年音 |
| longluanlanju | 女 | 25 | 元气少女音 |
| longlinhongxi | 男 | 22 | 青年朝气音 |
| longlanqinluan | 女 | 25 | 沉稳知性音 |
| longlingzhixing | 男 | 68 | 浑厚沉稳音 |
| longlangmoyue | 男 | 42 | 沉稳内敛音 |
| longyiqinghui | 女 | 60 | 慈祥祖母音 |
| longjinmeicheng | 男 | 27 | 成熟沉稳音 |

选择依据是目录里的性别、年龄感及特质与提示词的保守对应；没有适龄候选时选用较接近的声线，如校园学生使用目录标为 22–25 岁的青年声线。目录标注不保证生成听感，也不证明服务当前可用。制作前仍须实际试听并按需要调整；本表未完成多人物听审。候选目录标注为中文，英文、日文及其他语言的发音和自然度尚未实测，须分别试听。新项目使用 `character-delivery.ts` 的逐席表演指令与语速；六套主题、共 72 人均包含立绘对应、年龄感、声线质地、性格和停连节奏。人物文本设计与实际听感分开验收，不能仅凭配置声称声音已经创建或跨语言效果通过。

项目中已有 `voices.json` 默认会保留；传入 `--tts-model=qwen-audio-3.1-tts-flash|qwen-audio-3.0-tts-plus` 时，模型注册表会只迁移运行配置：已知法官、解说和座位 profile 自动切换到所选模型的兼容音色，已有 `rate`、`instruction`、标签和自定义 profile 在兼容时保留；未知 profile 若没有所选模型的兼容 voice 会停止并提示修正。**已有项目主题冲突或旧项目主题无法确认时程序会停止。** 不能静默改变本局旁白、原话、对局身份、规则或视角权限。

## 人物音色设计

新项目在配音阶段通过 `voice-enrollment` 为所选模型创建立绘对应的专属音色。声音设计调用 DashScope customization 接口，使用 `DASHSCOPE_API_KEY`；这与语音合成线路分别配置，3.0 Plus 合成仍使用 Token Plan，3.1 Flash 合成使用 DashScope。创建需要真实联网，离线测试只验证请求、续跑和绑定行为。

已创建的音色分别保存在 `modelVoiceBindings[model]` 和 `voice-enrollment.json.models[model]`，Flash 旧绑定保持兼容。相同设计续跑复用原 voice ID，改设计需显式 `--force`；旧项目不自动重做声音。已有项目明确重做时运行 `video:voice-enroll --project-dir=项目目录 --model=目标模型 --design`，先核对对应立绘主题；不能跨模型复用 voice ID。设计预览保存在项目 `voice-references/seat-N-design-preview.wav`，听感需真实试听。
