# Agent Note: 发布年龄覆盖键改用 kebab-case，因为 pnpm 12 不再识别驼峰写法

Status: implemented

## Problem

`@linxin666/dsh-update` 对用户主动触发的更新，用「每次调用传命令行覆盖」代替「让每个 profile 去改 `pnpm-workspace.yaml`」，以绕开 pnpm 的供应链门禁。这个覆盖原本写成 `--config.minimumReleaseAge=0`，即 pnpm 11 接受的写法。

pnpm 12 改了 `--config.<key>` 的解析：只识别 kebab-case 键。驼峰键仍被当作合法参数接受，因此既没有 warning 也没有非零退出码——它只是没有进入 pnpm 配置。在 pnpm 12.4.2 上，更新命令于是带着完整的门禁跑完：

- `pnpm add dsh-context@latest --config.minimumReleaseAge=0` 装到落后一版的 0.73.0；`--config.minimum-release-age=0` 装到当日发布的 0.73.1。`pnpm config list --json` 在驼峰写法下没有任何 `minimum*` 项，在 kebab 写法下是 `"minimumReleaseAge": 0`。
- 面板同款命令，在带有同一份 `pnpm-workspace.yaml` 的 profile 副本里，打印 `Lockfile passes supply-chain policies` 与 `Already up to date`，退出码 0，安装版本不动。
- pnpm 11.28.6 两种写法都接受，所以这个回归在本仓库自己使用的 pnpm（`packageManager: pnpm@11.24.0`）上不可见，只出现在运行 pnpm 12 的宿主上。

事后核对确实把这个 no-op 报成了 `update.error.stale`，但文案把它归因成用户该去改 `pnpm-workspace.yaml`，并把门禁记在 pnpm 11 名下——这两点都没有描述「覆盖本身被忽略」的宿主。

## Decision

`MIN_RELEASE_AGE_OVERRIDE` 的取值是 `--config.minimum-release-age=0`。三个候选命令（`pnpm`、`corepack pnpm`、`npx --yes pnpm`）继续共用该常量，写法只有一个事实源，固定它的测试直接读取实际 spawn 的参数列表。

kebab-case 是唯一在两个大版本上都生效的写法：pnpm 11 同时接受 kebab-case 与 camelCase，pnpm 12 只接受 kebab-case。选它让覆盖与宿主解析到哪个 pnpm 无关。

`update.error.stale` 文案在 `packages/dsh-update/src/client/locales.ts`（zh 为键源，en 对照）与集中式俄语字典（`packages/dsh-i18n/src/client/ru/update.ts`）里改为：门禁归属 pnpm 11/12；命令已经带上 `--config.minimum-release-age=0`；覆盖未生效时先查 pnpm 12 的键名写法变化；确实无效时仍给出 `minimumReleaseAgeExclude` / `minimumReleaseAge: 0` 的处置办法。包 README（英文与中文）的「已知限制」记录同一事实。

## Alternatives considered

- **命令行同时传两种写法。** 否决：那个不会生效的键会成为永久邀请，让人再把驼峰写法加回来；参数列表被既有测试逐字断言，多加一个键只增加噪音。
- **先探测 pnpm 大版本再拼命令。** 否决：更新路径要多跑一次进程（每次运行前先探版本）来在两个写法之间二选一，而单一写法已经同时覆盖两个大版本。
- **去掉覆盖，只依赖 stale 报告。** 否决：那是 #263 之前的状态——每个当日发布的家族版本都变成「装了但升不上去」，而提示还把原因归到用户配置上，正是该覆盖要避免的情形。
- **把 `minimumReleaseAge: 0` 写进 profile 的 `pnpm-workspace.yaml`。** 否决：插件会成为用户 profile 配置的第二个写入者，而该设置只在一条命令执行期间有意义；持久覆盖还会顺带关掉用户并未主动发起的安装的门禁。

## Consequences

- 宿主解析到 pnpm 12 的 profile 现在真正绕开了门禁：发布不足 24 小时的版本会被装上，而不是打印 `Already up to date` 后以退出码 0 结束。
- 若覆盖因其他原因仍未生效，失败依然会响亮地报出来：事后核对给出 `stale`，而文案现在点名键名写法变化与 profile 级处置办法，而不是只给单一原因。
- 覆盖仍然只在用户主动发起的那次调用里生效；profile 的其他安装依旧受门禁保护。

## Testing

`packages/dsh-update/tests/update.spec.ts` 对三个候选命令的参数列表都做了断言，因此 kebab-case 键被逐字固定：退回驼峰写法会让主 `pnpm` 路径与两个回退路径同时失败。`pnpm i18n:check` 拉住 zh/en/ru 的键集与占位符，`pnpm docs:check` 用记录的哈希校验 README 双语配对。
