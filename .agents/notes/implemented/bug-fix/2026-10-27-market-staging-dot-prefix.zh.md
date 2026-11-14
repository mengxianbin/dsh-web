# Agent Note: 创意工坊的 staging 目录改为点前缀同级目录

Status: implemented

本笔记拥有创意工坊安装器的 staging 目录在磁盘上的命名。同一函数的抓取与重试策略由 [issue 批次 1937-1942](2026-10-24-issue-batch-1937-1942-fixes.md) 拥有；三种资产里有一种落到的预设置库由 [社区 agent 预设](../feature/2026-09-09-community-agent-presets.md) 拥有。

## Problem

`packages/dsh-market/src/core/installer.ts` 里的 `installAsset()` 先下载到目的地旁边的 staging 目录，等每个文件都到齐后才 rename 到位。此前的 staging 名是 `dest + '.install-' + <戳>`，即 `<id>/` 在同一个 kind 目录（`$DSH_HOME/skins`、`$DSH_HOME/pets`、`$DSH_HOME/agent-presets`）内的同级条目，拼法是「真实资产 id 加一个后缀」且没有前导点。

于是每个按名字列举这些目录的消费者都会遇到它——staging 名就是真实资产 id 加一个后缀。三者随后各走各的校验，而其中没有一道是「跳过点前缀」：宠物注册表的 `scanPetDir()`（`satellites/dsh-pet/src/registry.ts`）与预设置库的 `scanPresetIds()`（`satellites/dsh-presets/src/core/library.ts`）按名字列举，后者还要求名字符合预设 id 规则；皮肤中心的 `collectSource()`（`satellites/dsh-skins/src/skin-repo.ts`）则列举全部目录（含点前缀），并拒绝 `skin.json` 缺失或无效、或 `manifest.id` 与目录名不一致的那一个。有两种状态会把该目录暴露给这些列举：

- 下载进行中，staging 目录正在被填；
- 失败后 best-effort 清理没能删掉它——catch 块里的 `rmSync` 是 best effort，Windows 上另一个进程仍持有句柄时它会静默失败。

本该守住这一点的回归测试其实从未读过目录：名为「清理临时目录、下载失败不留残留」的用例在 ES module 的 `.map()` 回调里调用 `require('node:fs')`（必然抛错），用 `try/catch` 把异常吞掉并返回 `[]`，而且遍历 `dirs` 却去读 `home`。它的断言 `expect(leftovers).toEqual([])` 因此在什么都没观测到的情况下成立。

## Decision

staging 目录是目的地的点前缀同级条目：

```ts
const tmp = join(
  dirname(dest),
  '.' + basename(dest) + '.install-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
)
```

这个表达式的两半各承载一条要求。`dirname(dest)` 把 staging 留在目的地自己的父目录里，`renameSync` 因此仍是同盘原子移动。前导 `.` 是「跳过点前缀」的消费者真正据以行动的那个字符：宠物注册表过滤 `!name.startsWith('.')`，预设置库同理，两者连打开都不打开就丢掉该条目。皮肤中心不按名字过滤——它列举全部目录——所以那里的点前缀只是让这份未完成的中间产物在浏览目录的人眼里不像一个资产 id；名册拒绝它靠的仍是既有的 `skin.json` 与目录名一致性检查。rename 目标不变——仍是 `$DSH_HOME/<kind-dir>/<id>`——所以没有任何消费者读到不同的路径。

三种 kind 共用 `targetDir()`，因此 skin、pet 与 preset 的 staging 目录都由同一处改动变成点前缀。

不增加任何自动清理。在用户 home 目录上扫 `.<id>.install-*` 条目的清理器分不清孤儿目录与同一目录里正在进行的安装，而那还会变成对本插件并不拥有的目录做递归删除。

`installer.ts` 的模块注释写明了新的契约。

## Testing

`packages/dsh-market/src/core/installer.test.ts` 把失败用例按三种 kind 参数化（`skin`/whale-song、`pet`/whale-girl、`preset`/demo-preset）。fetch 替身在失败文件被请求的那一刻记录父目录的列举结果——这正是安装仍在进行时扫描器会看到的状态——断言三件事：

- 记录到的条目匹配 `^\.<id>\.install-[0-9a-z]+-[0-9a-z]+$`；
- 它是目的地父目录的子项，因此 rename 仍是同盘操作；
- 失败之后，父目录过滤掉点前缀名后为空，而 best-effort 清理之后仍幸存的条目全部以点开头。

把旧的（无点前缀）表达式改回去会让这三个用例全部失败，说明这道护栏是真的；换回交付的表达式后 `npx vitest run src/core/installer.test.ts` 30 项全通过。成功安装的用例另外断言 kind 目录里恰好只有裸 id，从而钉住未变的 rename 目标。

聚焦验证：包内 `npx tsgo --noEmit`、仓库根 `pnpm build`，随后 `node scripts/lib-artifact-check.mjs --write` 及其 check 模式，全部通过。已提交的 `lib/index.js` 携带同一表达式，`scripts/lib-artifact-fingerprints.json` 记录刷新后的指纹。

## Alternatives considered

- **保留 `<id>.install-<后缀>`，让每个消费者自己过滤该后缀。** 否决：过滤逻辑得落进皮肤中心与宠物插件这两个各自发版的独立仓库，还要落进未来每一个扫描器；后缀属于安装器的实现细节，消费者没有理由知道它。点前缀不需要任何一方配合：本来就跳过点条目的消费者免费丢掉这个 staging 目录，而不跳过的那一个（皮肤中心）继续靠自己的 manifest 一致性检查拒绝它。
- **先在操作系统临时目录里 staging，再移动到位。** 否决：跨盘的 `renameSync` 是复制加删除，既失去原子性，又可能留下半个目的地，而这正是 staging 要防的失败。
- **在专用隐藏目录里 staging（`.staging/<id>-<后缀>`）。** 否决：多出一个要跳过的点条目、多出一个要收集的目录，相比点前缀同级条目没有任何收益。
- **为残留 staging 目录加清理器。** 否决：它分不清孤儿与同一 home 里正在进行的安装，且会在用户数据上加一次递归删除。
- **保留旧测试，只修 `require` 调用。** 否决：修好的断言会正好钉住这次改动要移除的「按后缀判残留」行为。

## Consequences

宠物注册表与预设置库不再会看到 staging 目录，因为两者都跳过名字以点开头的条目。皮肤中心仍会列举到它——它的扫描器不按名字过滤——拒绝依据仍是既有的 `skin.json` 与目录名一致性检查；点前缀在那里的价值是让这份目录读起来像未完成的中间产物而不是资产 id。staging 与目的地仍在同一父目录里，因此 rename 保持原子，皮肤、宠物与预设三者的崩溃安全性都与之前相同。

磁盘占用在性质上不变、在可见性上变了：清理没能跑成的失败会留下一个 `.<id>.install-<后缀>` 目录，装着失败前已下载的文件，且没有任何东西会自动移除它——这些字节只能手工删除才释放。此前这份残留会以形似资产 id 的名字出现在 kind 目录的每一次列举里；现在它是一个点条目、被宠物注册表与预设置库跳过，而字节两种情况都还在——这正是把该限制写在这里、而不是用清理器去「修」它的原因。
