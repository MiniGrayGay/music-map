# 原神 7.2 音乐分区地图

Vue 3、Vite 和 pnpm 项目，使用 7.2.0 的主世界瓦片及地图编辑器的分层资产。
地图支持鼠标、触屏和键盘操作。音乐清单提供已核对的坐标、分区和可试听音轨。

## 数据来源（全部只读，同版本 7.2.0 客户端）

三个源在 `scripts/build-map-data.mjs` 启动时做指纹核对：两两一致、且
`executableSha256` 与本机客户端 EXE 实算相同（版本绑定参数集中写在脚本
顶部，客户端更新后需重新核对）：

| 内容 | 来源 |
|---|---|
| 瓦片（281 主世界 PNG） | `E:/tools/AnimeStudio/AssetDigger/output/原神7.2.0/Textures/主世界` |
| 区域多边形（67 一级 / 413 二级） | `AssetDigger obj/Layout/ExportRepair/product-completion/scene-point/current/BinOutput/Scene/WorldArea/scene3_worldArea.json` |
| 区域配置（597 行） | `AssetDigger obj/Layout/ExportRepair/product-completion/current/ExcelBinOutput/WorldAreaConfigData.json` |
| 名称（TextMap_MediumCHS 回退 CHS） | `原神7.2.0/TextMap/` |

抗混淆：场景几何用结构自适应解析（复用 `tools/scripts/maps/derive_world_area.mjs`
的形状逻辑，未改原入口）；配置列由 LEVEL_1/LEVEL_2 枚举、TextMap 键集命中、
scene3 (id1,id2) 覆盖三元组动态推断，任何歧义报错退出，不写死混淆名。
WorldArea 几何和名称留作音频条件关联的研究输入。主地图投影使用编辑器
22528×19456 合成图的四分之一坐标系。生产切片使用转换报告中核实的同一份
7.2 `Teyvat_1024.png`，其中已合成杜南纳深坑地图组件。

## 瓦片产物

- `scripts/build-tile-pyramid.mjs` 按 BetterGI 地图编辑器的 512 像素规格、
  图集切片边界与缩放层级生成 `dist/tiles/<地图>/<z>/<x>/<y>.webp`，
  所有层级使用有损 WebP quality 100。输入摘要与层级记录在
  `dist/tiles/meta.json`。四张独立地图使用同版本的原始纹理合成。
- 浏览器按当前视口和 DPI 请求目标层级，未就绪的位置从已缓存的低层级取图，
  在单个画布中合成。楼层贴片与音乐边线由其各自的图层绘制。
  主世界没有源瓦片的空格用海色填底，图集中实际合成的像素保留。

## 命令

运行、构建和验收使用 Node.js 22.12 以上版本及 pnpm 11。发布输入来自已核对的
7.2 地图资产与音频清单。

```powershell
pnpm run dev       # 编辑器预览
pnpm run build     # 编译 Vue，校验并打包静态音频、瓦片、楼层和运行清单
pnpm run build:hosted # 用仓库中的运行资料生成可发布的 dist/site
pnpm run preview   # 直接提供 dist 中的文件
pnpm run verify    # 用无头 Chrome 检查生产产物
pnpm run verify:external # 本地启动分开的站点和音频源，实测跨源试听
pnpm run data      # 从本机 7.2 资料重新生成地图坐标
pnpm run tiles     # 用 Sharp 重新生成多级 WebP
pnpm run layers --out <新目录>   # 从地图编辑器的源资产重建楼层贴片
pnpm run music --bgm <已核实的音区清单> --out <新文件>   # 从本机音频包重建 Wwise 曲单
pnpm run audio:extract --manifest <原始音区清单> --decoder <vgmstream-cli> --work <工作缓存> --out <新目录>
```

## 静态交付

GitHub 仓库包含浏览器运行所需的地图瓦片、分层贴片、精简音乐清单与试听音频。
Vercel 导入仓库后使用 `vercel.json`，以 Node.js 22 和项目锁定的 pnpm 构建
`dist/site`。站点直接读取此仓库中的音频，可用 `TEYVAT_AUDIO_BASE` 切换音频服务。

`dist/` 是完整交付目录。常规构建会从工作区 `dist/genshin-region-bgm.json`
读取已核对的数据，并将被引用的 Ogg Opus 试听文件打包到
`dist/region-bgm-audio/`。同盘打包使用硬链接，可跨盘复制。
`TEYVAT_BGM_MANIFEST` 与 `TEYVAT_AUDIO_DIR` 可以指定这两个输入。
打包时同步核对客户端版本、地图文件、音源格式和已发布数据需要的字段。

完整音频约 1.02 GB。独立媒体源的目录应直接提供 `<音源编号>.opus`，
返回可播放的音频类型并支持 HTTP 字节范围。编译后可用以下命令生成约
65 MB 的静态站点目录，命令只需要实际可访问的音频目录地址。

```powershell
pnpm run export:site --audio-base https://assets.example.org/teyvat/audio/
```

默认导出到 `dist/site/`，也可以通过 `--output` 指定目录。导出时将地址写入
运行清单，可以直接发布该目录。每次导出都会生成独立快照，完整验证后替换上次的产物。
Windows 上遇到目录改名受限时，导出会先保留上一版快照，再逐文件复制新包。
新包写入失败时会尝试恢复上一版，恢复失败时保留备份目录供检查。
目标目录若有其他文件，导出会保留原目录并报告冲突。完整音频位于
`dist/region-bgm-audio/`，可以用其中的文件准备独立媒体源。

验收脚本 `scripts/verify-headless.mjs` 检查 7.2.0 版本、可见瓦片数量、缩放级别、
拖动帧间隔、悬停与触屏命中、透明楼层边缘、窄窗、真实音频和切歌外框稳定性。
播放器测试覆盖音频字节范围、暂停定位、音量、循环、快速切歌和音源失败后的恢复。
截图仅保存在
`<工作区>/cache/teyvat-region-map/screenshots`，不做外部上传。

## 分层地图

`dist/layers/manifest.json` 使用地图编辑器 7.2 转换报告中的贴片范围、
楼层、图层顺序与透明度处理。分层视图仅显示所选楼层贴片，地表作为定位背景。
贴片以当前视口的实际尺寸绘制，楼层视图的放大上限由源尺寸和设备像素比决定。
页面提供提瓦特、旧日之海、远古圣山、空之神殿
和霜月切换，并支持搜索分层区域和选择楼层。场景 100 的三张贴片有配置但缺图，
记录在 manifest 的 `noImageLayers` 中。455 张贴片中有 5 张来自已验证的
现成 q80 中间图，再编码为 q100，其余 450 张直接用源 PNG 转换。

## 音乐分区

应用通过静态地址 `/data/genshin-region-bgm.json` 和
`/region-bgm-audio/<sourceId>.opus` 加载地图音乐。
地面视图和楼层视图按 7.2 的 `MapInfo` 音乐状态绘制。点击、右键或按回车后，
可在播放器切换探索和战斗、查看曲目、调整进度和音量、按顺序续播或循环。
支持 Media Session 的浏览器还可通过系统媒体控制操作。

- `scripts/build-bgm-playlists.mjs` 使用已通过核对的 MapInfo、入口与曲名清单，
  核对客户端和 Bank 指纹，并独立从 Wwise HIRC 重建决策树、曲单、片段、音轨和
  切换规则。播放器按选定的地点和模式解析 Wwise 曲目。昼夜开关立即切换对应歌曲。
  「歌曲列表」只显示当前地点、探索或战斗以及选定时段的曲目。UI 条件使用已核实的
  状态名称。
- 支持昼夜分支的音区可设置「试听时间」。该控件按分钟采样初始化 Bank 的开放世界
  音乐开关曲线。曲线原始参数在 5.04154 切为白天，在 17.001 切为夜间，所以按整分钟
  试听时分别在 05:03 与 17:01 切换。参数为 0 时沿用 Wwise 缺省分支。曲线与其他
  四时段开关组独立，游戏客户端向音频引擎传值的过程仍待复核。
  `build-bgm-playlists.mjs --init-package <文件名>` 可从原始初始化 Bank 提取曲线，
  重建时会复用清单中已登记的两份 Bank，并可用 `verify-wwise-source.mjs` 核对指纹及控制点。
  现有素材名按 7.2 音源 ID 连接
  [AnimeWwise 名称表](https://github.com/Escartem/AnimeWwise/blob/deba68978cec74d44bff6989bf1066953a73a173/maps/hk4e.map)。
  部分游戏内中文曲名来自当前版本尘歌壶曲目的 Wwise 分支、音源编号和本地化表。
  `node scripts/verify-wwise-source.mjs --manifest <音区清单>` 可从本机 Bank
  逐字段复核清单中的音乐图。
  `scripts/match-bgm-soundtrack.mjs` 用 Chromaprint 比对本机 Opus 和官方原声试听。
  已确认的匹配收录在 `scripts/verified-soundtrack-titles.json`，打包时重新校验
  曲名证据表、音源 SHA-256 和 Ogg Opus 时长。
  某些地区的 iTunes 索引只返回专辑。匹配脚本会改读 Apple Music 的发行曲目表
  和官方试听。使用 `pnpm run audio:apply-titles` 可把确认的指纹结果合入候选清单
  和候选证据表。通过 `--edition 原专辑编号:中文专辑编号` 指定同一专辑的发行版本，
  现有英文曲名只有在音频指纹、分碟和曲序均吻合时才更新。
  有双语发行曲目表时，也可用 `--publisher-album Apple专辑编号:QQ专辑编号` 取得
  中文名，此路径核对发行者、英文名、分碟、曲序和原声时长。
  音律库曲名的补充记录保留客户端事件、参考音源的 SHA-256 和固定偏移下的
  波形对齐结果。运行 `verify-wwise-source.mjs` 会从本机 PCK 复核这些参考音源。
  按乐器区分的演奏版本沿用已核实的尘歌壶曲名。证据表保留两份音源的 SHA-256、
  素材名、参考曲目状态及固定采样偏移下的波形比对，供后续复核。
- `pnpm run audio:extract` 从原始音乐 PCK 按音源编号提取 Wwise Vorbis，
  解码后生成浏览器可播的 Opus。新编码的文件有独立指纹，替换生产音频需要重新核对
  曲名证据。解码器用 `--decoder` 指定，编码器可用 `--ffmpeg` 指定。
  [vgmstream](https://github.com/vgmstream/vgmstream/releases)
  [FFmpeg](https://ffmpeg.org/download.html)
- `scripts/build-bgm-surface.mjs` 使用同版本 Scene Point 的楼层归属和 LayerRegion
  体积重建地表视图。 `surfaceLayerExclusions` 保留楼层专属音区，`floorVolumeBindings`
  同时保留有独立证据可在地表和楼层生效的状态。
- `scripts/build-bgm-floor-views.mjs` 用当前楼层 WebP 的 alpha 裁剪已核实归属的
  音区填色、命中和原有边线。楼层传送点若证实与地表使用同一状态，会在本层贴片上
  提供试听区域，并排除所有可能覆盖该状态的子区域。此类区域保留原音区编号，并以
  楼层实际名称显示。若贴片的部分范围在任意高度都命中同一音乐状态，该范围可供
  试听。页面使用 `floorViews`，边界与高度原始数据保存在 `volumes`。
  `floorAnchors` 记录按真实 XYZ 校验的传送点与音乐状态，`floorViewConflicts`
  保留二维投影有歧义的条目。
  `scripts/verify-bgm-geometry.mjs` 可将重新生成的清单与已有清单按音区编号、
  音乐状态、传送点、填色范围和边线逐项比较。

## 目录

- `src/features/map/` 地图域：视口模型（mapModel.js）、数据装载（mapData.js）、
  主画面（MapSurface.vue）
- `src/features/bgm/` 音乐状态接入（bgmStatus.js）
- `src/components/` 缩放控件与区域 tooltip
- `scripts/` ESM 构建与验收，以及历史数据研究脚本
- `public/data/map-data.json` 生成产物（含 provenance 指纹与 audit）
- `dist/` 构建输出；`dist/tiles/` 为瓦片唯一产物位

不复制任何客户端资产或旧导出图；原始客户端与 AssetDigger 导出只读。
