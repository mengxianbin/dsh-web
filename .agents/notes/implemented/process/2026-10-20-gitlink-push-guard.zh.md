# Agent Note: gitlink 不得钉住未推送的卫星仓内容

Status: implemented

## Problem

市场构建读的是每个 `satellites/<repo>` gitlink 记录的提交；一个从未初始化子模块的检出会用 tarball 回退按 SHA 从卫星仓远程取那个提交。于是钉住只存在于本地提交的 gitlink，在这里构建正常、到别处全错：`pnpm market:fetch` 在子模块工作树停在钉住提交时直接复制它，`pnpm market:check` 也报告已提交的 `market/dist` 一致，而第一个故障出现在全新克隆或 CI 上——一个远程从未收到的提交换来 `HTTP 404`。[CONTRIBUTING.md](../../../../CONTRIBUTING.md) 把推送卫星仓提交写成三步钉版流程的第 2 步，并称它是最隐蔽的遗漏；跳过它时本地不会有任何失败，只能靠评审读钉版时发现。

## Decision

`scripts/git-pre-push-gitlinks.sh` 作为 pre-push 钩子运行，拦下「已暂存的 `satellites/` gitlink 钉住的提交不在卫星仓远程上」的推送。

- 钉住提交从 `git ls-tree HEAD` 读取，所以已提交、尚未推送的钉版按这次推送真正会带走的内容判定。
- 钉住提交若已能从某个远程跟踪引用到达，直接放行、不触网；其余情况用一次 `git ls-remote --heads <url> <sha>` 向子模块自己的 `origin` 确认。
- 失败信息点名子模块、缩写的钉住提交与远程，并打印修复命令：`git -C satellites/<repo> push origin main`。
- 该钩子是诊断，不是门禁。当它无法证明钉版有问题时——没有 `node`、子模块目录不是检出、URL 解析不出——它保持沉默并放行，而不是凭猜测阻塞。

## Alternatives considered

**扩展已经在 `.git/hooks/pre-push` 上的 `scripts/git-pre-push-guard.sh`。** 否决：那个守卫只回答一个问题——`origin` 是否仍指向规范仓库，它的失效后果是推错仓库。把网络探测折进去，会让廉价的结构检查依赖上昂贵的那个，而只想要 origin 守卫的检出也不得不两个都接受。新钩子改为与之并列串联。

**做成手动运行的 `pnpm` 脚本。** 否决：它要防的正是遗漏，而一个必须记得去跑的自检，恰好在需要它的那个场景里被忘掉。同样的理由也否决了「把文档写得更重」：三步流程已经写明，这个缺口仍然发生了。

**只对照本地远程跟踪引用判断，完全不触网。** 否决：它会漏掉最关键的情形——卫星仓提交是从另一个克隆推上去的。它保留为「答案已知时跳过网络」的快路径。

**做成 git 或子模块不可用时就阻塞的硬门禁。** 否决：那样一个无法运行的 pre-push 钩子会阻塞每一个来自「从未初始化子模块」检出的推送，而那是受支持的默认形态。看不见状态的检查没有资格据此阻塞。

## Consequences

- CONTRIBUTING.md 描述的缺口现在在本地、在钉版到达 `dev` 之前就被抓住。文档仍保留那一步；钩子负责在它被跳过时失败。
- 在同一次会话里先推卫星仓提交、再推钉版，多花一次 `git ls-remote` 往返；钉住提交已在远程时一次都不花。
- 钩子需要 `PATH` 上的 `node`。它继承执行 `git push` 者的环境，而本仓其他工具本来就要求同一运行时。
- 与 origin 守卫一样，安装是逐检出的选择：`ln -sf ../../scripts/git-pre-push-gitlinks.sh .git/hooks/pre-push`，或按脚本头部所示串联两个守卫。未安装钩子的全新克隆行为不变。
- 验证：`node --test scripts/git-pre-push-gitlinks.test.mjs` 在一次性仓库上覆盖被拦下的钉版、放行的钉版与无子模块的检出；钩子也在本检出上跑过——把真实钉版移到只在本地的提交时被拦下，还原钉版后静默通过。
