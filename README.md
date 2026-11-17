# 原神 7.2 音乐分区地图

Vue 3、Vite 和 pnpm 项目，使用 7.2.0 的主世界瓦片及地图编辑器的分层资产。
地图支持鼠标、触屏和键盘操作。音乐清单提供已核对的坐标、分区和可试听音轨。
默认打开球面地图，支持搜索地点、跨地图定位和选区浮起。退出分层后返回球面。
播放器把当前分区的曲目合成一张歌单，按网易云专辑曲去重。曲名、专辑和公开直链均经过核对。
地表常驻标签为七国和挪德卡莱，点击地区名称可定位到该地区。
在 B 站 Toy 内，SDK 确认用户尚未关注 BetterGI 时，听歌满 5 秒计一次，累计三次后在下一首播放前提示关注。点击「去关注」打开 [BetterGI 官方 B 站空间](https://space.bilibili.com/3546777483479879)。
选中音乐分区时显示该分区的名称，并按边界和可用视野自动移动、缩放。
进入球面近景后，细分区线随缩放淡入。
桌面端选中提瓦特地表分区时，在右下角显示对应的 3D 模型点阵，连续旋转 360°。选区自动取景会避开放大的预览。
`pnpm exec node scripts/build-relief-preview.mjs --out <已登记的生成目录>` 读取 3D 编辑器正式注册表和实例变换，从显示网格取点，以原生地形做底面并过滤地下几何，最后按音乐分区裁剪。
批量生成时，每批使用 `--part <从 0 开始的批号> --parts <总批数>` 和单独的输出目录。运行 `pnpm exec node scripts/merge-relief-preview.mjs --input <第一批目录> --input <第二批目录> --out <合并目录>`，核对同一模型索引后合并。
运行 `pnpm exec node scripts/build-uniform-relief.mjs --input <原始模型点阵目录> --mesh-sides --out <地表点阵目录>` 生成等距地面点阵，并在原模型表面的 XZ、XY、ZY 平面上采样屋顶、墙和岩面。常规地面网格最长边约 224 格，极窄分片保留原始采样点。
运行 `pnpm exec node scripts/build-relief-native-regions.mjs --base <地表点阵目录> --out <合成点阵目录>` 合入至冬 7.2 原生 LOD0 和杜南纳井体，在井体投影范围内移除盖住开口的地面格。将通过校验的索引与数据发布到 `dist/relief/`。浏览器按选区读取对应字节段。

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
  基础金字塔使用有损 WebP quality 100。输入摘要与层级记录在
  `dist/tiles/meta.json`。四张独立地图使用同版本的原始纹理合成。
- 浏览器按当前视口和 DPI 请求目标层级，未就绪的位置从已缓存的低层级取图，
  在单个画布中合成。楼层贴片与音乐边线由其各自的图层绘制。
  主世界没有源瓦片的空格用海色填底，图集中实际合成的像素保留。
- `scripts/build-native-map-tiles.mjs --out <已登记的缓存目录>` 读取同版本
  `Teyvat_2048.png`，在 48 张 2048 像素原图覆盖处切出 768 张 512 像素瓦片。
  将生成的层级目录放到 `dist/tiles/Teyvat/`，并同步更新 `dist/tiles/meta.json`。
  放大时平面和球面自动按屏幕像素密度加载这一层，其余位置继续使用基础瓦片。

## 命令

运行、构建和验收使用 Node.js 22.12 以上版本及 pnpm 11。发布输入来自已核对的
7.2 地图资产与音频清单。

```powershell
pnpm run dev       # 本地预览，默认球面，/?player-lab 打开播放器实验页
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

GitHub 仓库包含地图瓦片、分层贴片和精简音乐清单。播放器通过网易云曲目 ID 访问公开链接。
Vercel 导入仓库后使用 `vercel.json`，以 Node.js 22 和项目锁定的 pnpm 构建
`dist/site`。

更新网易云曲库时运行 `pnpm exec node scripts/build-netease-catalog.mjs --details`。
脚本以已核验的分区曲目和正式发行的专辑为输入，核对曲名与专辑，再检查匿名播放状态和直链的 HTTP Range 响应。

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

### B 站 Toy 包

先生成常规发布素材，再运行 `pnpm run export:toy`。
命令使用 Python 标准库封装 `dist/teyvat-toy.zip`，
压缩包根目录为 `index.html`。Toy 包仅收录提瓦特和霜月，其现有全部瓦片和
楼层贴片随包。展示图片统一使用有损 WebP 质量 80，霜月功能蒙版保留原始 PNG 像素。
点云以 5 厘米为单位分区编码并合并为单个 gzip 文件。桌面端启动时显示下载和解压进度，
后续选区从内存读取，移动端跳过点云加载。
网易云直链在播放时获取媒体，压缩包仅携带曲目和专辑的索引。ZIP 超过 50 MB 时导出报错。

## 分层地图

`dist/layers/manifest.json` 使用地图编辑器 7.2 转换报告中的贴片范围、
楼层、图层顺序与透明度处理。分层视图仅显示所选楼层贴片，地表作为定位背景。
贴片以当前视口的实际尺寸绘制，楼层视图的放大上限由源尺寸和设备像素比决定。
页面提供提瓦特、旧日之海、远古圣山、空之神殿
和霜月切换，并支持搜索分层区域和选择楼层。场景 100 的三张贴片有配置但缺图，
记录在 manifest 的 `noImageLayers` 中。455 张贴片中有 5 张来自已验证的
现成 q80 中间图，再编码为 q100，其余 450 张直接用源 PNG 转换。

### 霜月安全区

霜月（场景 102）使用两层原始雾遮罩、九个安全区和左侧开放区 920。球面和平面使用
同一张遮罩，蓝色点阵裁在原地图轮廓内。鼠标、触屏和搜索按可达范围命中音乐分区。
描线使用源遮罩和材质阈值，保留静态轮廓。危险区之外使用底图原色。

在项目目录运行 `pnpm exec node scripts/build-mooncanon-stencil.mjs` 可从工作区的
`research/Extracted/maps/MoonCanonBlueMask/` 重建 `MoonCanonStencil.png`。
红、绿、蓝通道分别记录危险覆盖、可达像素和描线覆盖。
乌吉恩圈的合成贴片来自 BetterGI 地图编辑器 `public/MoonCanon_1024.jpg`，
按照原图像素位置叠入总览和近景。可运行 `pnpm exec node scripts/build-mooncanon-composite.mjs` 重建，
编辑器目录可通过 `BGI_MAP_EDITOR` 指定。

## 音乐分区

应用从 `./data/genshin-region-bgm.json` 加载分区音乐清单，通过网易云直链播放。
地面视图和楼层视图按 7.2 的 `MapInfo` 音乐状态绘制。点击、右键或按回车后，
可打开歌曲列表切换白天和夜间、查看曲目，并在播放器调整进度和音量、按顺序续播或循环。
支持 Media Session 的浏览器还可通过系统媒体控制操作。

- `scripts/build-bgm-playlists.mjs` 使用已通过核对的 MapInfo、入口与曲名清单，
  核对客户端和 Bank 指纹，并独立从 Wwise HIRC 重建决策树、曲单、片段、音轨和
  切换规则。歌曲列表中的昼夜及播放条件可用来浏览对应曲目。
  点选歌曲后，对应曲单成为播放队列。界面条件使用已核实的状态名称。
- `build-bgm-playlists.mjs --init-package <文件名>` 可从原始初始化 Bank 提取昼夜曲线，
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
  体积重建地表视图。主世界还核对地图编辑器的地形高度，在已覆盖的范围内排除确定低于
  地形的体积。楼层绑定按原始体积记录区分，同编号体积可有不同的归属。`surfaceViewConflicts`
  保留高度未能确定的重叠交集，这些范围在地表没有音区命中，也不画出因排除产生的边线。
- `scripts/build-bgm-floor-views.mjs` 用当前楼层 WebP 的 alpha 裁剪已核实归属的
  音区填色、命中和原有边线。楼层传送点若证实与地表使用同一状态，会在本层贴片上
  提供试听区域，并排除所有可能覆盖该状态的子区域。此类区域保留原音区编号，并以
  楼层实际名称显示。若贴片的部分范围在任意高度都命中同一音乐状态，该范围可供
  试听。页面使用 `floorViews`，边界与高度原始数据保存在 `volumes`。
  `floorAnchors` 记录按真实 XYZ 校验的传送点与音乐状态，`floorViewConflicts`
  保留二维投影有歧义的条目。不同高度状态在同一楼层贴片上互相覆盖时，优先排除交集，
  保留可判定的其余范围。
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
