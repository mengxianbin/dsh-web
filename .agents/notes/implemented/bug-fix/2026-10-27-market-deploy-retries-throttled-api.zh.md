# Agent Note: Deploy Market 通道对被限流的 Cloudflare API 做重试，而不是在第一个 429 上失败

Status: implemented

## Problem

Deploy Market 通道在 dev 上红了三次，每次都在 `node scripts/deploy-market` 开始约一秒后失败：run 40350674320（2026-10-26 15:34）、run 40367640238（2026-10-26 17:20）、run 40430514377（2026-10-27 01:05）。日志是 `GET /accounts/***/workers/services/dsh-market` 的 `Received a malformed response from the API` 加 `-> 429 Too Many Requests`，随后 `deploy-market: wrangler deploy failed (exit 1)`。

通道发出去的请求本身没有问题。这个 429 没有带 `Retry-After` 头，而 wrangler 只在该头存在时才退避（`wrangler-dist/cli.js` 62987 与 65214），于是第一个被限流的响应就结束了整条通道。

客户端版本同样不是变量。最后一次绿跑（40285936221，2026-10-26 07:27）装的是 wrangler 4.152.0，失败的那几次装的是 4.153.0，但两个 bundle 里 `workers/services` 的调用点都是同样 14 处；差别在 API 限流了哪个请求，不在客户端。

还有一次红跑属于这段历史、但不属于本决策：run 40212351108（2026-10-25）失败得更早，在 Market consistency 步骤里，已单独修复。

## Decision

`scripts/deploy-market` 在受限的重试策略下运行每一次 wrangler 调用：`MAX_ATTEMPTS = 4`（第 42 行），即首次尝试加最多三次重试，重试之间是 `RETRY_BACKOFF_MS = [5000, 20000, 60000]`（第 45 行）。

`classifyTransientFailure`（第 79 行）拿子进程的失败文本去匹配 `TRANSIENT_SIGNATURES`（第 66 行），认得 HTTP 429、只在 wrangler 打印的那几种形状里的 HTTP 5xx（`-> 503`、`HTTP 522`、`statusCode: 500`）、文本 `malformed response from the API`，以及 `ECONNRESET` / `ETIMEDOUT` / `EPIPE` / `socket hang up`。一条都不匹配的失败仍走旧的快速失败路径，报的仍是逐字节相同的那条消息（第 211 行）。

预算用尽时，失败消息带上原因、尝试次数、响应里带的 Cloudflare Ray ID，以及被捕获输出的有界 200 行尾巴（`failureMessage`，第 228 行；`createTail`，第 99 行）。子进程的 stdout 与 stderr 经中继实时留在 job 日志里，同一份文本同时留在有界环形缓冲中（`spawnAttempt`，第 144 行），因此最终成功的那次重试之后，先前几次的日志仍然可读。

通道里其余部分一律不动：`--wrangler` 选项、`TURNSTILE_SECRET` 与 `ASSET_ATTEST_SECRET` 的失败关闭闸门、siteverify 配对探针、`market-build --check` 预检、D1 迁移步骤以及每一个退出码，行为都与加重试之前一致。

## Testing

`scripts/deploy-market.test.mjs` 通过注入的尝试与等待驱动这套策略，不睡觉也不联网：它证明重试后成功、预算耗尽时带出 Ray ID 与捕获证据、以及非瞬时失败恰好只尝试一次。另有两个用例跑真实子进程，覆盖输出中继与 secret 绑定依赖的 stdin 载荷。

这次改动要求的验证：`pnpm test:scripts`、`pnpm test:standards`、`pnpm typecheck`，以及改动推送后第一次 Deploy Market 运行。

## Alternatives considered

- **把 wrangler 钉在最后一次绿跑的版本上。** 否决：证据显示与版本无关，两个 bundle 的 `workers/services` 调用点都是同样 14 处；钉版只会把上游修复一起冻住，而碰不到限流本身。
- **把重试搬到 workflow 步骤层。** 否决：步骤级重试会把 D1 迁移、部署与 secret 刷新整条重跑一遍，还会重跑 `market-build` 预检，而为的只是一个被限流的 HTTP 响应。
- **现在就把通道迁到 `cf` CLI。** 属于本次不改、而非永久否决：它需要为 `market/worker` 准备 `cloudflare.config.ts`，并把 wrangler 装成该目录的 devDependency，是个更大的改动，只有在有界重试救不回通道时才重新考虑。

## Consequences

- 子进程输出里任何一处孤立的 `429` 都可能先烧掉最多 85 秒重试（5 + 20 + 60），然后才浮现同一个失败，而它从不会把失败刷成绿。多出来的等待远在通道 15 分钟超时之内。
- 管道化子进程输出会让本地手工运行这个脚本时失去 wrangler 的 ANSI 颜色；CI 不受影响。
- 残余风险直说：如果这个 429 是账号级的持续性限流而不是瞬时限流，重试救不回通道，下一步就是迁到 `cf` CLI。
