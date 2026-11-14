# 鲸鱼娘·萝莉（jyn-loli）

由 stushansusu（涂山苏苏）为 DSH 桌面宠物制作的 frames2d 宠物：由 **MiniMax H3 图生视频**产出的
**10 条轨道、720 帧**。与 `assets/jyn`（女仆鲸鱼娘）、`assets/jyn-foxtail`（鲸鱼娘·狗尾巴草）
同属「鲸鱼娘」角色线。

## 包里有什么

| 项 | 值 |
| --- | --- |
| 轨道 | **10 条** —— `idle`（循环）· `scratch-head` / `whale-pillow` / `lollipop` / `dance-sway`（播一遍回 idle）· `work`（循环）· `work-success` / `work-fail`（播一遍回 work）· `rest`（播一遍）→ `resting`（循环） |
| 帧 | 每轨 **72 帧 × 40 ms = 2880 ms**，共 **720 帧** |
| 单元 | **764×1172**，十轨统一（宿主按帧高缩放，所以十条轨道显示大小完全一致） |
| 玩法 | `stats` / `idleDirector`（4 个待机小动作）/ `hitBox` / `touch`（三个触摸区 + `clickBoost`）/ `work` / `sleep` / `passiveIncome` / `shop` |
| 体积 | **84.5 MB**（帧 69.9 MB + 10 条轨道透明底 GIF 预览 14.7 MB） |

## 来源

- **角色**：「鲸鱼娘」的萝莉形态，与本仓库的 `assets/jyn`、`assets/jyn-foxtail` 同一条角色线。
- **立绘**：一张 **1184×1920 RGBA 已抠像**的 PNG（透明区 RGB 为纯白；可见内容包围盒 1043×1774），
  由作者以 **AI 生成（DeepSeek）** 后提供。
  ⚠️ 与 jyn-q 的立绘不同，**这个 PNG 里没有任何文本块**（既无 XMP 也无 TC260 AIGC 标识），
  所以此处「生成工具」的归属来自**作者陈述**，不是从文件元数据读出来的。
- **帧**：MiniMax **H3 fl2va**（图生视频）在本机 ComfyUI 上逐条生成 —— **73 帧 @24fps = 3.042 s**，
  首帧与尾帧喂**同一张图**，模型因此被夹回起始姿势，**有效周期 = 72 帧**；再把 73 帧等时重采样成 72 帧，
  于是每条轨道首尾天然闭合。整条「视频 → frames2d」产线（含踩过的坑）记在生成侧仓库的 `docs/h3-to-frames2d.md`。
- **十轨共用一个裁切框**：取全部轨道全部保留帧的 alpha 并集、按几何中心对称补边成 **764×1172**，
  所以切轨道时角色既不跳大小也不跳位置。打工三轨（碗 / 圆肚子 / 彩虹）的并集完整落在角色原轮廓以内，
  成品框高度增长 **0 px** ⇒ 角色显示尺寸 **100%**。
- **`rest` 入场轨走的是「运动自适应时间重映射」**（不是把 45 张源帧线性插值铺到 72 帧）：
  源片 f0..f20（站姿 → 躺下，逐帧运动量 18~55 灰阶）**1:1 逐帧照搬、一帧都不混**，
  之后用 smoothstep 把速度平滑升到 2.32 倍，多出来的 27 帧全部落在躺定之后那段几乎不动的呼吸上。
  这样做是因为**在纯白背景上做线性混合会把深色发丝兑成中灰** —— 看上去像半透明重影、alpha 却不透明。
- **`work-fail` 的彩虹是半透明的柔和版本**：源片里模型画的是七条平涂纯色扇区
  （峰值覆盖 87k px、71% 的像素与八邻域同色），会把毛衣与鲸鱼图案整块盖掉。成品帧里
  被它盖住的像素是从**时间上最近的那一帧**取回来的（扇形并集 100% 可找回），
  扇形本身则保留原有色相、用掩膜内的归一化卷积揉成连续渐变、外缘羽化后按 alpha≈0.5 合成。

## 授权与声明

- **贡献与许可**：本宠物（帧序列、`pet.json`、`previews/`）由 stushansusu 以 **MIT** 许可证贡献；
  manifest 记 `author: 11726`、`license: MIT`。`11726` 与 stushansusu 是同一作者的两个署名
  —— 这条角色线上资产的 `pet.json` 都记 `11726`（jyn / jyn-foxtail / doro 亦然），
  而 `THIRD_PARTY_NOTICES.md` 与 README 的内置宠物表按 GitHub 账号记 stushansusu，
  Doro 条目已先记录过这一对应关系。
- **角色权利**：「鲸鱼娘」是对 DeepSeek 鲸鱼标识的**非官方同人**形象，DeepSeek 名称与鲸鱼标识的
  相关权利归 DeepSeek 所有。本作为粉丝二创，与 DeepSeek 无隶属或背书关系，不表述为官方作品，
  也不主张角色本身的任何权利。
- **使用范围**：仅限个人非商业使用 —— 不得售卖、不得商用、不得表述为官方；本仓库 MIT 覆盖的是
  贡献者产出的帧序列与清单，不覆盖角色本身。
- 第三方声明见仓库根 `THIRD_PARTY_NOTICES.md` 的 **Jyn-Loli pet (assets/jyn-loli/)** 条目，
  其中「许可条件不满足时须向权利人取得授权」一句与 Miku 条目同形。

## 预览 GIF 的透明底

`previews/<track>.gif` 是**真透明底**：每一帧保留帧自己的 alpha（128 处二值化 —— GIF 每帧只有
一个 transparent index，这是格式上限），与同仓 `assets/doro/previews/cola.gif`、
`assets/whale-refined/previews/idle.gif` 同一口径。出图脚本在生成侧
`tools/make_preview_gifs.py`：只读 `thumb/<track>/f_*.webp`，等比缩到长边 320、LANCZOS，
不做任何中间合成 —— 所以把 GIF 帧按白底合成回来，与已提交帧的白底合成相差
**mean 2.0~2.5/255、单帧最大 2.95**，差值全部来自调色板量化与二值 alpha 的边缘。
`tests/jyn-loli-pet.spec.ts` 有一条用例**逐帧解码**守着这条（透明索引、左上角透明、透明占比）。

## 为什么不在 `package.json` 的 `files` 白名单里

本包 **84.5 MB**，与 `assets/jyn`（113.9 MB）、`assets/doro`（55.5 MB）、
`assets/jyn-foxtail`（14.9 MB）同属「只放仓库、不随 npm 包发布」的那一档；
只有轻量的内置宠物（如 jyn-q，5.6 MB）才写进 `files`。想把它变成内置宠物，
在 `package.json` 的 `files` 里加一行 `"assets/jyn-loli"` 即可。
