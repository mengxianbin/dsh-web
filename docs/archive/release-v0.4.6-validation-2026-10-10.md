# v0.4.6 发布验证快照（2026-10-10）

冻结记录：v0.4.6 的实际发布路径与发布后核验结果。发布流程的当前契约由 [dsh-web-release 技能](../../.agents/skills/dsh-web-release/SKILL.md) 与 [release.yml](../../.github/workflows/release.yml) 拥有，本文件不改写它们。

## 结果

- 四个卫星仓先各自发布 `0.4.6` 并创建 GitHub Release，本仓随后打 tag：
  - dsh-skins `c5b6dde`（皮肤中心，含 miku 面包屑通配修复与新皮肤）
  - dsh-pet `3d1605b`（宠物）
  - dsh-community-plugins `574e6a2`（社区插件索引）
  - dsh-presets `fa79bd0`（预设中心，纯版本对齐，无内容改动）
  四个包均已在 npm 解析 `0.4.6`，`dist-tags.latest` 同步。
- 本仓 17 个家族包与根 `version` 发布 `0.4.6`，`scripts/verify-registry.mjs 0.4.6` 首次尝试即全部解析。
- 发布提交 `3cd18493`（`chore(release): bump to 0.4.6`），tag `v0.4.6` 为附注 tag（`6938a630`）指向该提交。
- 发布管线一次通过（run `38063609860`，8m42s），含 mount smoke 与 GitHub Release。
- 发布后 `dev` / `main` / `origin/dev` / `origin/main` 同为 `3cd18493`。
- 双语说明见 [v0.4.6 release notes](../release-notes/v0.4.6.md)；Release 正文默认视图为中文、English 折叠视图为英文，`user-mention` 计数为 0。
- 旧聚合包 `@linxin666/dsh-web-ui-all` 的 dual-publish 窗口已关闭：该包保持 `0.3.6` 与 `deprecated` 元数据，本次未发布新版本。
- 桌面安装包车道（`desktop-release.yml`）在本仓已不存在，v0.4.6 不涉及。技能文中「由 desktop-release.yml 在 tag 推送后自动构建」一句已过期，见下方「后续可考虑」。

## 发布范围内的关键判断

- **宿主下限不变**：本次没有移动 `dsh.engines.dsh`，仍为 `>=0.2.0-rc.2`，与 `0.4.5` 一致。说明中已据实写明，未重复 `0.4.5` 的「下限提升」事故（该事故的教训是一次性自检项，见 `release-v0.4.5-validation-2026-10-05.md`）。
- **卫星对齐是一次性抬升**：聚合包的四个卫星依赖范围、`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 条目与四个 gitlink 一起从 `0.4.5` 移动到 `0.4.6`；`pnpm install --lockfile-only` 对锁文件未产生字节变化。
- **合并进 dev 的皮肤修复需要重建市场产物**：`satellites/dsh-skins` 的 gitlink 前移到 `c5b6dde` 时带入了 `skins/miku/patches.css`（删除 `[class*="crumb"]` 通配隐藏规则），因此 `market/dist` 必须同一次重建并提交；`market:fetch` → `market:build` → `market:check` 均通过，`tryon/` 按既有约定保持原样并由哈希清单校验。

## 并发协作

发布期间另一会话向 `origin/dev` 推送了 `13bc7032`（`chore(skins): 同步 miku 面包屑修复的 gitlink 并重建市场产物`），与本轮的市场重建工作重叠。处置：

- 本仓发布提交在推送前 rebase 到 `13bc7032` 之上（本地未推送提交，rebase 安全）。
- `git diff` 显示两者的 `market/dist` 输出逐字节一致，唯一实际差异是 `satellites/dsh-skins` 的 gitlink：协作者指向 `5e9fbad`，本轮指向其子提交 `c5b6dde`（该仓的 0.4.6 发布提交），`git merge-tree` 预演无冲突，rebase 后自动取较新者，发布内容未受影响。

## 验证方式与限制

- 家族包可解析性由 `scripts/verify-registry.mjs 0.4.6` 断言（覆盖 npm 传播延迟），不依赖逐包发布成功行。
- 本地门禁在发布提交上全绿：`verify-version`、`typecheck`、`test`、`test:scripts`、`aggregate --check`、`runtime-deps:check`、`libs:check`、`market:check`、`sync-shared:check`。
- **已知时序不稳定**：`packages/dsh-liangshen/tests/benchmark-live-run.test.ts` 有一条用例在并行 `pnpm test` 下可能超过 vitest 默认 5000ms 预算。判定为环境负载而非本次回归：该用例文件自 `v0.4.5` 起未改动，本次对该包唯一改动是版本号字符串，单独运行约 2.4–4.0s 通过，仓库已记录并行测试的时序抖动，且发布管线在同一提交上并行运行该套件时通过（3362ms）。本地验收改用仓库自带的串行车道 `pnpm -r --workspace-concurrency=1 test`，未修改、跳过或放宽任何测试。
- 未验证：npm tarball 的内容级校验（`verify-registry.mjs` 按设计只断言可解析性），以及真实 profile 中安装 / 升级新版本包（本次无持久化格式变化需要触发）。

## 后续可考虑

- **发布说明生成器需要 tag 已存在**：`node scripts/release-notes.mjs vX.Y.Z` 以 tag 作为范围端点，在打 tag 之前无法运行（报 `fatal: ambiguous argument`）。技能第 3 节把「先跑脚本出草稿」排在打 tag 之前，两步顺序对不上；可让脚本接受 `--range <prev>..<head>` 之类的显式端点，或在技能里改成「打包提交前用 HEAD 生成草稿」。
- **技能中的桌面车道描述已过期**：技能第 6 节仍写「桌面安装包由 desktop-release.yml 在 tag 推送后自动构建并上传」，但该工作流已在本仓移除（早于 `v0.4.4`）。
- `docs/publish-prep.md` 第 5 行写「16 个公开家族包」，而同文件表格列了 17 行（含 `packages/dsh-web-all`），`scripts/verify-version.mjs` 也报告 17。`release-v0.4.5-validation-2026-10-05.md` 的口径是「17 个家族包（16 个公开家族包 + 根别名包 `@linxin666/dsh-web-all`）」，两种口径可并存，因此未判定为错误，本次也未改动；若要统一，宜先确定根别名包算不算「公开家族包」再落笔。
- `tests/delegated-skins.spec.ts`（dsh-skins 仓）不隔离环境变量 `DSH_PROFILE` / `DSH_SKIN_PROFILE`：在 DSH 会话内跑 `pnpm test` 会出现 4 条假失败；CI 不受影响。建议在该仓单独提交一个 `beforeEach` 清理，勿混入发布提交。
