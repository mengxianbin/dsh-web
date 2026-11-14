/**
 * `@linxin666/dsh-remote-bridge` — the Host half of the DSH remote bridge.
 *
 * One plugin row exposes the frozen protocol v1 to a paired remote client:
 *
 * - `/ios/v1` (WebSocket upgrade) carries the whole protocol. Admission is
 *   unconditional: a connection without a valid device token is UNPAIRED and
 *   may only call `hello`, `pair.begin` and `pair.finish` — even from loopback.
 * - `/remote-bridge/pair/token` (exact HTTP route) mints the one-shot bootstrap
 *   token. It is admitted only when the request arrives from this machine AND
 *   its `Host` header names this machine: a tunneled request reaches the origin
 *   from loopback too, so the socket address alone is not a loopback proof.
 * - `approval/request` is claimed in-process while a paired device is connected,
 *   and delegated (`next()`) in every other case, which the Host normalizes to
 *   the fail-closed `'unavailable'`.
 * - `ui_present` is this bridge's own model tool (protocol §35): one whole
 *   self-contained page is announced as `ui.request` to the paired clients that
 *   declared `ui.v1`, and the user's first action inside it comes back as that
 *   tool call's result. `ui.event` settles it, `ui.list` reads the cards still
 *   held. No paired client that declared the channel means the call answers
 *   `unavailable` at once instead of holding the agent.
 * - `user-questions/request` is claimed the same way and published as
 *   `question.request` to the devices that declared `questions.v1`; their
 *   `question.answer` settles the host's own ask while it is open, or reaches a
 *   continued question through the host's Remote `answer`. With no paired
 *   connection on the wire the claim is still made when a roster device registered
 *   for notifications, which is reached by the alert and holds the question for one
 *   window before it goes back to the host's chain (§11.3, §32). Every other case
 *   delegates, and a timed question keeps the Host's own deadline.
 *
 * The browser half lives in `src/client/` and is declared by `dsh.client`: one
 * sidebar-foot panel that reads the same loopback-gated token route over a
 * same-origin request and renders the secret as a QR symbol beside its
 * plaintext. It is display-only — it cannot mint, spend, list or revoke
 * anything — and this module does not import it.
 * @module @linxin666/dsh-remote-bridge
 */

import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { ApprovalRegistry } from './core/approvals.ts'
import type { ConnectionAuth } from './core/connection.ts'
import { DeviceRoster } from './core/devices.ts'
import { createRemoteBridgeFace, RemoteBridgeRegistry, REMOTE_BRIDGE_SERVICE } from './core/extension.ts'
import { JobRoster, type JobRegistryFace } from './core/jobs.ts'
import { BridgeHub, OFFLINE_QUESTION_CLAIM_TTL_MS } from './core/hub.ts'
import { createOwnerPeer } from './core/owner-peer.ts'
import { PairingService } from './core/pairing.ts'
import { LiveActivityNotifier } from './core/liveactivity.ts'
import { PushNotifier } from './core/push.ts'
import { QuestionClaims } from './core/questions.ts'
import { UiCards } from './core/ui.ts'
import { WS_PATH } from './core/protocol.ts'
import { SessionMeta, type SessionStoreFace, type SessionTitleFace, type WorkspacesFace } from './core/session-meta.ts'
import { sessionQuietProbe, TURN_END_QUIET_REPORT_MS, TurnEndQuietGate } from './core/turn-end-quiet.ts'
import { SessionPermissions, type ApprovalPolicyFace, type PermissionPresetsFace, type SandboxPolicyFace } from './core/session-permissions.ts'
import { selectionOf, modelSelectionOf } from './core/connection.ts'
import { UsageService, type CredentialStoreFace, type SessionRosterFace, type SessionRouteFace, type SettingsFace } from './core/usage.ts'
import { UsageStatsReader } from './core/usage-stats.ts'
import { wireArgs, type GatewayPeer } from './core/wire.ts'
import { dshHome } from './host/dsh-home.ts'
import { ApnsSender, apnsConfigFromEnv } from './host/apns.ts'
import { StandingWatchers } from './host/watchers.ts'
import { LoopbackSquads } from './host/squads.ts'
import { mountOnce } from './mount-once.ts'
import { makePairTokenRoute } from './host/routes.ts'
import { createUiPresentTool } from './host/ui-tools.ts'
import { hostWebOrigin, LoopbackUsage } from './host/usage-stats.ts'
import { isWebSocketUpgrade, presentedTokenOf, readSecWebSocketKey, refuseUpgrade, serveUpgrade } from './host/websocket.ts'

/** Loader row identity of this plugin. */
export const name = 'remote-bridge'

/**
 * The Host services this plugin cannot run without.
 *
 * `tools` is what protocol §35 added: this bridge contributes one model tool of
 * its own (`ui_present`), so a host that composes no tool registry is a host where
 * the card channel has no caller — the row simply does not mount here.
 */
export const inject = ['typertGateway', 'webServer', 'tools']

/** Where the paired-device roster lives inside the DSH home. */
export const ROSTER_PATH = 'remote-bridge/devices.json'

/** The environment variable that moves the offline claim window (§32.2). */
export const OFFLINE_CLAIM_TTL_ENV = 'DSH_REMOTE_BRIDGE_OFFLINE_CLAIM_TTL_MS'

/**
 * The offline claim window this process runs with.
 *
 * The window is the bridge's own constant and never a host fact, so a deployment
 * moves it here. A value that is missing, unreadable or not positive falls back to
 * the constant instead of closing the window: a zero window would silently switch
 * the channel off, and an operator who wanted that would be turning off push.
 * @param env - the process environment, injectable for a suite.
 * @returns the window in milliseconds.
 */
export function offlineClaimTtl(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env[OFFLINE_CLAIM_TTL_ENV])
  return Number.isFinite(configured) && configured > 0 ? configured : OFFLINE_QUESTION_CLAIM_TTL_MS
}

/**
 * The environment variable that moves when a still-waiting turn end is reported (§28).
 *
 * The name is the one deployments already set and is kept as it is; what it moves is
 * the point at which the bridge says it is still waiting, because the wait itself has
 * no cap.
 */
export const TURN_END_QUIET_MAX_ENV = 'DSH_REMOTE_BRIDGE_TURN_END_QUIET_MAX_MS'

/**
 * The still-waiting report point this process runs with.
 *
 * It is the bridge's own constant and never a host fact, so a deployment moves it
 * here. A value that is missing, unreadable or not positive falls back to the
 * constant: the point only decides when the log line saying the wait continues is
 * written, and nothing about it can make the bridge announce work that is still
 * running or withhold a turn end whose family is quiet.
 * @param env - the process environment, injectable for a suite.
 * @returns the report point in milliseconds.
 */
export function turnEndQuietMaxWait(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env[TURN_END_QUIET_MAX_ENV])
  return Number.isFinite(configured) && configured > 0 ? configured : TURN_END_QUIET_REPORT_MS
}

/** This machine's IANA time zone, or undefined when the platform has none. */
function localTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return zone === '' ? undefined : zone
  } catch {
    return undefined
  }
}

/**
 * The `/ios/v1` upgrade handler.
 *
 * A bad, absent or bootstrap token is NOT a refusal: the connection is simply
 * unpaired, which is the state the pairing handshake starts from. Only a
 * malformed handshake is refused.
 */
function makeUpgradeHandler(hub: BridgeHub, roster: DeviceRoster, log: (message: string) => void) {
  return async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    if (!isWebSocketUpgrade(req)) {
      refuseUpgrade(socket, 400, 'Bad Request')
      return
    }
    const key = readSecWebSocketKey(req)
    if (key === undefined) {
      refuseUpgrade(socket, 400, 'Bad Request')
      return
    }
    try {
      await roster.load()
    } catch (error) {
      // An unreadable roster leaves every candidate unpaired. Refusing the upgrade
      // says so; letting the handler's promise reject instead would hand the host's
      // upgrade dispatcher a failure it has no answer for and no client would ever see.
      log(`could not read the device roster: ${String(error)}`)
      refuseUpgrade(socket, 503, 'Service Unavailable')
      return
    }
    const token = presentedTokenOf(req)
    const device = token === undefined ? undefined : roster.authenticate(token)
    const auth: ConnectionAuth | undefined = device === undefined ? undefined : { deviceId: device.deviceId }
    serveUpgrade({
      socket,
      secWebSocketKey: key,
      head,
      hub,
      ...(auth === undefined ? {} : { auth }),
    })
  }
}

/**
 * Resolve the host services session metadata is read from, now.
 *
 * All of them are read per call rather than captured at mount: none is in this
 * plugin's `inject` list, because requiring them would let the title or
 * workspace plugin's absence take the whole bridge down with it. An unmounted
 * service simply reads as undefined, and the protocol degrades one key of one
 * row instead of failing a method. The faces are structural — this package
 * imports no part of those services' own types.
 *
 * One registry answers two faces: `archive` is the slice a roster row reads and
 * `workspaces` the wider slice `workspace.list` publishes, so a single lookup
 * serves both and a host either composes a registry or composes none.
 * @param ctx - the plugin's context.
 * @returns the metadata faces as they stand right now.
 */
function sessionMetaFaces(ctx: Context) {
  const registry = ctx.get('workspaceRegistry') as WorkspacesFace | undefined
  return {
    sessions: ctx.get('sessions') as SessionStoreFace | undefined,
    titles: ctx.get('sessionTitle') as SessionTitleFace | undefined,
    archive: registry,
    workspaces: registry,
  }
}

/**
 * 宿主自己的会话名册，按 `usage.session` 需要的那一格读出来。
 *
 * 走的是 `session.list` 服务的同一个端点（`session/list`），也就是手机名册的
 * 来源：它名下既有活的会话，也有本进程没观察过、当前也不 live 的会话，因此
 * 那类会话不会被说成不存在。`ctx.sessions.list()` 答不了这一问——它只列已经
 * 进入存储的会话。读失败或答不出 item 表就回 undefined，「不知道名册」由用量
 * 服务退回活会话存储与事件折叠两条证词。
 * @param ctx - 插件的上下文，携带网关。
 * @param peer - 本桥自己的 owner peer，每次调用都以它发声。
 * @param log - 读不到名册时的落点。
 * @returns 名册 face。
 */
function sessionRoster(ctx: Context, peer: GatewayPeer, log: (message: string) => void): SessionRosterFace {
  return {
    ids: async (): Promise<readonly string[] | undefined> => {
      try {
        const value = await ctx.typertGateway.invoke({
          namespace: 'session',
          method: 'list',
          args: wireArgs('session', 'list', {}),
          peer,
        })
        const items = typeof value === 'object' && value !== null ? (value as { items?: unknown }).items : undefined
        if (!Array.isArray(items)) return undefined
        const ids: string[] = []
        for (const item of items) {
          const id = typeof item === 'object' && item !== null ? (item as { sessionId?: unknown }).sessionId : undefined
          if (typeof id === 'string' && id !== '') ids.push(id)
        }
        return ids
      } catch (error) {
        log(`the host session roster could not be read: ${String(error)}`)
        return undefined
      }
    },
  }
}

/**
 * 一条会话此刻的路由，按 `usage.session` 的模型窗口那一档读出来。
 *
 * 折叠与 `session.models` 的 `current` 逐字一致：下一步的选择、其次是用过的那个、
 * 最后才是目录默认。两个方法读同一个折叠，就不可能出现「模型选择器说 A、模型窗口
 * 按 B 算」这种事。每次读都走本桥自己的 owner peer；读不到任何一档就回 undefined，
 * 那一档读数（`modelContextWindow`）因此根本不出现，而不是补一个默认值。
 * @param ctx - 插件的上下文，携带网关。
 * @param peer - 本桥自己的 owner peer，每次调用都以它发声。
 * @param log - 读不到时记一行日志。
 * @returns 路由 face。
 */
function sessionRoute(ctx: Context, peer: GatewayPeer, log: (message: string) => void): SessionRouteFace {
  const invoke = async (method: string, args: Readonly<Record<string, unknown>>): Promise<unknown> => await ctx.typertGateway.invoke({
    namespace: 'session',
    method,
    args: wireArgs('session', method, args),
    peer,
  })
  return {
    current: async (sessionId: string) => {
      try {
        const folded = modelSelectionOf(await invoke('projections', { sessionId }))
        const selected = folded.next ?? folded.lastUsed
        // 还没选过模型的会话在目录默认上——它下一步就会用那个，也正是
        // `session.models` 对同一条会话给出的答案。
        const fallback = selected === undefined ? selectionOf(catalogDefaultOf(await invoke('modelCatalog', {}))) : undefined
        const answer = selected ?? fallback
        return answer === undefined ? undefined : { provider: answer.provider, model: answer.model }
      } catch (error) {
        log(`the route of session ${sessionId} could not be read: ${String(error)}`)
        return undefined
      }
    },
  }
}

/** `session/modelCatalog` 里的 `default` 一格。 */
function catalogDefaultOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? (value as { default?: unknown }).default : undefined
}

/**
 * 解析 `usage.v1` 要读的宿主服务，现在就解析一次。
 *
 * 与元数据的三个 face 同一条理由：四者都不在本插件的 `inject` 里，缺一个不该
 * 让整个桥起不来。缺活会话存储，`usage.session` 就只能靠名册与本进程观察过的
 * 事件判断会话是否存在；缺凭据服务，`usage.balance` 回 `no-credential`；缺设置
 * 服务，路由的 `baseURL` 与 `apiKeyEnv` 读不到，origin 判定与凭据回退都退回
 * 官方默认值。face 是结构化的：本包不导入这些服务自己的类型。
 * @param ctx - 插件的上下文。
 * @param peer - 本桥自己的 owner peer，名册读取以它发声。
 * @param log - 读不到名册时的落点。
 * @returns 这些 face 此刻的样子。
 */
function usageFaces(ctx: Context, peer: GatewayPeer, log: (message: string) => void) {
  return {
    sessions: ctx.get('sessions') as SessionStoreFace | undefined,
    roster: sessionRoster(ctx, peer, log),
    credentials: ctx.get('credentials') as CredentialStoreFace | undefined,
    settings: ctx.get('settings') as SettingsFace | undefined,
    route: sessionRoute(ctx, peer, log),
  }
}

/**
 * Resolve the host services permission presets are read and switched through, now.
 *
 * Read per call, never captured at mount, for the reason the metadata faces are:
 * none of these is in this plugin's `inject` list, and a host that composes no
 * permission plugin answers `unknown-method` instead of failing to start. The
 * `Session` object the preset service needs is the store's own live instance —
 * the same object `sessionTitle` already takes — so no second lookup path exists
 * for it.
 * @param ctx - the plugin's context.
 * @returns the permission faces as they stand right now.
 */
function permissionFaces(ctx: Context) {
  return {
    sessions: ctx.get('sessions') as SessionStoreFace | undefined,
    presets: ctx.get('permissionPresets') as PermissionPresetsFace | undefined,
    sandbox: ctx.get('sandboxPolicy') as SandboxPolicyFace | undefined,
    approval: ctx.get('approval') as ApprovalPolicyFace | undefined,
  }
}

/**
 * Resolve the host's job registry, now.
 *
 * Read per call, never captured at mount, for the reason the metadata faces
 * are: `jobs` is not in this plugin's `inject` list, so a host that composes
 * no job plugin still serves protocol v1 — `jobs.list` answers
 * `jobs-unavailable` instead of the bridge failing to start. The face is
 * structural: this package imports no part of the registry's own types.
 * @param ctx - the plugin's context.
 * @returns the job faces as they stand right now.
 */
function jobFaces(ctx: Context) {
  return {
    jobs: ctx.get('jobs') as JobRegistryFace | undefined,
  }
}

/**
 * Mount the bridge.
 *
 * Guarded by the family's single-instance rule: the aggregate row
 * (`web-ui-remote-bridge`) and a standalone install of this same package can
 * both be live in one profile, and the second mount would otherwise register
 * `/ios/v1` and the token route a second time. Whichever source mounts first
 * owns the package name; the other is queued and replayed when that owner
 * disposes.
 * @param ctx - the plugin's context, carrying the gateway and web server.
 */
function applyImpl(ctx: Context): void {
  const log = (message: string): void => { console.log(`[remote-bridge] ${message}`) }
  const roster = new DeviceRoster({ file: join(dshHome(), ROSTER_PATH), log })
  const pairing = new PairingService()
  const approvals = new ApprovalRegistry()
  // The owner peer is the full-control credential the gateway demands since
  // 0.2.1; it is safe to hold from mount because every call that can trigger
  // it is gated by the bridge's own pairing check (see core/owner-peer.ts).
  const ownerPeer = createOwnerPeer(ctx)
  const questions = new QuestionClaims({ gateway: ctx.typertGateway, peer: ownerPeer, log })
  // 整页卡（§35）：一张宿主级的卡表，所有连接共享——一条动作只属于发起它的那个
  // 工具调用，与它从哪台设备回来无关。
  const ui = new UiCards()
  // One roster per mount, shared by every connection: a background job is a fact
  // about the host, not about the device that asked about it.
  const jobs = new JobRoster({ faces: () => jobFaces(ctx), log })
  const sessionMeta = new SessionMeta(() => sessionMetaFaces(ctx), () => Date.now(), log)
  // 用量读数：一条会话的窗口与组成靠宿主广播的事件折出来，余额靠宿主自己的
  // 凭据与设置查出来。一个宿主一份、所有连接共享——两台手机重复问，上游也只
  // 该收到一次请求（core/usage.ts）。
  // 台账聚合读的是宿主上 dsh-usage 插件的两条 HTTP 路由，走本机回环 origin：那个
  // 插件不发布任何 cordis 服务，端口从 `webServer` 来（先 getOrigin()，拿不到再退回
  // 监听端口）。没有它时 `usage.stats` 答 no-usage-plugin，其余读数一概不变。
  const usageRoutes = new LoopbackUsage({ origin: () => hostWebOrigin(ctx.webServer), log })
  const usageStats = new UsageStatsReader({ transport: () => usageRoutes, now: () => Date.now(), log })
  const usage = new UsageService({ faces: () => usageFaces(ctx, ownerPeer, log), now: () => Date.now(), stats: usageStats, log })
  // The push channel is OFF unless this machine holds an Apple signing key: no
  // key, no sender, and every notification path is a no-op — which is what keeps
  // the protocol byte-identical for every deployment that has none (§28).
  const apns = apnsConfigFromEnv()
  // One client for both channels: an APNs provider token is minted per key and
  // then reused, so a second client would only double the mint rate Apple
  // throttles (core/push.ts, host/apns.ts).
  const apnsSender = apns === undefined ? undefined : new ApnsSender({ config: apns, log })
  const push = new PushNotifier({
    targets: () => roster.pushTargets().map(({ push: registration }) => ({
      deviceToken: registration.deviceToken,
      environment: registration.environment,
      bundle: registration.bundle,
      ...(registration.locale === undefined ? {} : { locale: registration.locale }),
    })),
    ...(apnsSender === undefined ? {} : { sender: apnsSender }),
    titles: id => sessionMeta.title(id),
    now: () => Date.now(),
    log,
  })
  // The lock-screen card path (§29). It reads the same roster, through the same
  // client, and is inert for exactly the same reason: no key, no sender, no card.
  // A token APNs reports dead is dropped from its device row here, which is the
  // whole of the recovery — the next card registers a fresh one.
  const liveActivity = new LiveActivityNotifier({
    targets: () => roster.pushTargets().flatMap(({ push: registration }) => (registration.liveActivityTokens ?? []).map(({ activityId, token, sessionId }) => ({
      activityId,
      token,
      // The session is the card's address (§29.9). A registration written before
      // that field existed simply has none, and its card is never pushed to.
      ...(sessionId === undefined ? {} : { sessionId }),
      environment: registration.environment,
      bundle: registration.bundle,
    }))),
    ...(apnsSender === undefined ? {} : { sender: apnsSender }),
    now: () => Date.now(),
    log,
    retire: async (activityId, token) => {
      const dropped = await roster.removeLiveActivityToken(activityId, token)
      // A dead token is a roster change like any other: the session it named may
      // have just lost its last card, and a watcher for it must close.
      if (dropped) watchers.sync()
      return dropped
    },
  })
  // The quiet gate both channels announce a finished turn through: §28's
  // notification and §29's card end wait for the host's own answer that the session's
  // whole family is quiet — the root its parent chain climbs to, every session under
  // that root at any depth, and any job the host attributes to one of them. A family
  // that stays busy is never announced, and a subagent session's own turn end is
  // dropped unless the phone prompted it. Inert while no key is configured, because
  // both channels are then off and no timer is worth arming.
  const turnEndQuiet = new TurnEndQuietGate({
    push,
    liveActivity,
    probe: sessionQuietProbe({ gateway: ctx.typertGateway, peer: ownerPeer, jobs }),
    reportAfterMs: turnEndQuietMaxWait(),
    log,
  })
  // The bridge's own follow streams (§28/§29): a suspended phone has no socket,
  // so the turn end its card has to show would otherwise be seen by nobody. One
  // watcher per session that still holds a card token, armed from the roster and
  // never from a client frame.
  const watchedSessions = (): readonly string[] => {
    const sessions = new Set<string>()
    for (const { push: registration } of roster.pushTargets()) {
      for (const token of registration.liveActivityTokens ?? []) {
        if (token.sessionId !== undefined) sessions.add(token.sessionId)
      }
    }
    return [...sessions]
  }
  const watchers = new StandingWatchers({
    gateway: ctx.typertGateway,
    peer: ownerPeer,
    sessions: watchedSessions,
    ...(apnsSender === undefined ? {} : { liveActivity, push }),
    turnEndQuiet,
    log,
  })
  const permissions = new SessionPermissions(() => permissionFaces(ctx), log)
  // The extension seam publishes no protocol vocabulary of its own: another
  // plugin registers the method names, payloads and topics it owns, and this
  // package only dispatches and fans out what it was handed.
  // The squad domain of the `dsh-agents` plugin is read over this host's own
  // loopback origin: that plugin serves its routes on the very web server this
  // bridge already injects. Both the origin and the ledger directory are resolved
  // per call — the listener may not have bound a port when this row mounts, and a
  // DSH home is not a fact to capture once.
  const squads = new LoopbackSquads({
    origin: () => {
      try {
        return ctx.webServer.getOrigin()
      } catch {
        return undefined
      }
    },
    ledgerDirectory: () => join(dshHome(), 'dsh-agents'),
    log,
  })
  const extensions = new RemoteBridgeRegistry()
  // 离线认领的窗口归桥所有，宿主从不认识它（§32.2）：常量是默认值，部署可用环境变量覆盖。
  const offlineClaimTtlMs = offlineClaimTtl()
  const hub = new BridgeHub({
    extensions,
    gateway: ctx.typertGateway,
    pairing,
    roster,
    approvals,
    questions,
    ui,
    jobs,
    sessionMeta,
    usage,
    permissions,
    ownerPeer,
    squads,
    push,
    liveActivity,
    turnEndQuiet,
    offlineClaimTtlMs,
    onPushRegistered: () => { watchers.sync() },
    now: () => Date.now(),
    clientTimeZone: localTimeZone,
    log,
  })

  // A capture-only test context implements no service registry; a Host always
  // does. Without it the bridge still serves protocol v1, minus other plugins'
  // methods, which is exactly what not publishing the seam means.
  if (typeof (ctx as { provide?: unknown }).provide === 'function') {
    ctx.provide(REMOTE_BRIDGE_SERVICE, createRemoteBridgeFace(extensions, hub))
  }

  ctx.effect(() => {
    // A registration that arrived before this row mounted is still on disk: the
    // watchers are reconciled from what the roster holds, not from what a live
    // connection happened to send.
    void roster.load().then(() => { watchers.sync() }).catch(() => undefined)
    const disposeUpgrade = ctx.webServer.registerUpgrade({
      path: WS_PATH,
      handler: makeUpgradeHandler(hub, roster, log),
    })
    const disposeRoute = ctx.webServer.register(makePairTokenRoute({ pairing, log }))
    log(`protocol v1 listening on ${WS_PATH}`)
    log(apns === undefined
      ? `push: off (set ${'DSH_REMOTE_BRIDGE_APNS_KEY_FILE'}, ${'DSH_REMOTE_BRIDGE_APNS_KEY_ID'} and ${'DSH_REMOTE_BRIDGE_APNS_TEAM_ID'} to enable APNs)`
      : `push: on (APNs key ${apns.keyId} of team ${apns.teamId})`)
    return () => {
      disposeUpgrade()
      disposeRoute()
      watchers.dispose()
      turnEndQuiet.dispose()
      hub.dispose()
      jobs.dispose()
    }
  }, 'remote-bridge: protocol v1 routes')

  // §35 的模型工具：`ui_present` 把 agent 写的整页交给已配对的客户端，并在用户
  // 动作时把结构化事件作为它自己的返回值交回。注册在 `ctx.effect` 里、返回
  // disposer，所以插件卸载时工具名随行消失，宿主工具表不会留下一根指向空实现的
  // 指针；`execute` 把 `exec.signal` 一路传到认领表，回合被取消时那张卡立刻结算。
  ctx.effect(() => {
    const disposeTool = ctx.tools.register(createUiPresentTool({
      present: async (card, signal) => await hub.present(card, signal),
    }))
    log('model tool ui_present registered')
    return () => { disposeTool() }
  }, 'remote-bridge: ui_present tool')

  // 会话事件是 `usage.session` 唯一的来源：桥不读会话日志、也不回填历史，所以
  // 这个监听器挂上之前广播的事件不会有读数，宿主没广播过的窗口也不会被编出来。
  ctx.on('session/event', (session, event) => { usage.record(session.id, event) })
  ctx.on('approval/request', (request, next) => hub.approve(request, next))
  // Prepended: the host's waterfall is first-come, and the desktop client's own
  // answerer would otherwise claim every question before this listener is
  // consulted. The claim starts the rest of the chain itself, so prepending does
  // not take the desktop panel away — both surfaces show the question and the
  // first answer settles it.
  ctx.on('user-questions/request', (request, next) => hub.question(request, next), { prepend: true })
}

/**
 * The plugin's mount point: {@link applyImpl} behind the family's
 * single-instance guard. The name is the npm package identity, which every
 * install source of this plugin shares — the aggregate's `web-ui-remote-bridge`
 * row and the standalone `remote-bridge` row alike.
 */
export const apply = mountOnce('@linxin666/dsh-remote-bridge', applyImpl)
