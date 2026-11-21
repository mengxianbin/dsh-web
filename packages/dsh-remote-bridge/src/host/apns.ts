/**
 * The APNs client this bridge sends notifications through.
 *
 * Written against `node:http2` and `node:crypto` and nothing else: the provider
 * API is one POST per notification behind an ES256 JWT, which is small enough
 * that a dependency would cost more than it saves, and this package's whole
 * install surface is one browser library.
 *
 * Two facts about the credential shape everything here:
 *
 * - the signing key is an Apple `.p8` on this machine, named by an environment
 *   variable. It never enters this repository, the roster file, a log line or a
 *   wire frame; only the JWT derived from it leaves the process.
 * - a bridge with no key is a bridge with the channel OFF. {@link apnsConfigFromEnv}
 *   answers undefined, no sender is constructed, and every notification path is
 *   a no-op — the existing protocol runs byte for byte as it did before (§28).
 * @module dsh-remote-bridge/host/apns
 */

import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { connect, type ClientHttp2Session } from 'node:http2'
import type { LiveActivityAddress, LiveActivityNotification, LiveActivitySender } from '../core/liveactivity.ts'
import type { PushAddress, PushNotification, PushSendResult, PushSender } from '../core/push.ts'

/** Production APNs authority. */
export const APNS_PRODUCTION_AUTHORITY = 'api.push.apple.com'
/** Development APNs authority; a build signed for development must use it. */
export const APNS_SANDBOX_AUTHORITY = 'api.sandbox.push.apple.com'
/** Path prefix of one device delivery. */
export const APNS_DEVICE_PATH = '/3/device/'
/**
 * The topic suffix a Live Activity push needs.
 *
 * A Live Activity is addressed under the app bundle's own topic with this
 * suffix appended (§29); the bare bundle is the alert channel's topic, and
 * sending a card there is delivered as an alert the App cannot decode.
 */
export const APNS_LIVE_ACTIVITY_TOPIC_SUFFIX = '.push-type.liveactivity'
/**
 * How long one signed provider token is reused.
 *
 * Apple rejects a token older than an hour and throttles a provider that mints
 * one per request, so the token is refreshed well inside that window.
 */
export const APNS_TOKEN_TTL_MS = 45 * 60 * 1000
/** How long one delivery may take before it is abandoned. */
export const APNS_TIMEOUT_MS = 10_000
/** Environment variables this bridge reads its credential from. */
export const APNS_ENV = {
  keyFile: 'DSH_REMOTE_BRIDGE_APNS_KEY_FILE',
  keyId: 'DSH_REMOTE_BRIDGE_APNS_KEY_ID',
  teamId: 'DSH_REMOTE_BRIDGE_APNS_TEAM_ID',
} as const

/** The credential this bridge signs with. */
export interface ApnsConfig {
  /** Absolute path of the `.p8` private key. */
  readonly keyFile: string
  /** The key id Apple issued for that file. */
  readonly keyId: string
  /** The Apple Developer team id, which is the token's `iss`. */
  readonly teamId: string
}

/**
 * Read the APNs credential from the environment.
 * @param env - the environment to read; defaults to this process's.
 * @returns the credential, or undefined when any part of it is missing — which
 * is how the channel stays off by default.
 */
export function apnsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ApnsConfig | undefined {
  const keyFile = env[APNS_ENV.keyFile]?.trim()
  const keyId = env[APNS_ENV.keyId]?.trim()
  const teamId = env[APNS_ENV.teamId]?.trim()
  if (keyFile === undefined || keyFile === '' || keyId === undefined || keyId === '' || teamId === undefined || teamId === '') return undefined
  return { keyFile, keyId, teamId }
}

/** @returns the base64url text of one buffer, without padding. */
export function base64Url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url')
}

/**
 * Sign one APNs provider token.
 *
 * Header and claims are exactly what Apple accepts and nothing more: `alg`,
 * `kid` and `iss`, `iat`. APNs rejects a token carrying any other claim, so
 * this is not a place to add a convenient `exp` beside it.
 * @param input - the key, its id, the team id, and the issue time.
 * @returns the compact JWT.
 */
export function es256Jwt(input: {
  readonly key: KeyObject
  readonly keyId: string
  readonly teamId: string
  readonly issuedAt?: number
}): string {
  const header = base64Url(JSON.stringify({ alg: 'ES256', kid: input.keyId }))
  const claims = base64Url(JSON.stringify({ iss: input.teamId, iat: Math.floor((input.issuedAt ?? Date.now()) / 1000) }))
  const signingInput = `${header}.${claims}`
  // ES256 is ECDSA over P-256 with SHA-256, and APNs wants the raw r||s pair
  // rather than a DER sequence: 'ieee-p1363' is that encoding.
  const signature = sign('sha256', Buffer.from(signingInput, 'utf8'), { key: input.key, dsaEncoding: 'ieee-p1363' })
  return `${signingInput}.${base64Url(signature)}`
}

/** What one delivery's HTTP/2 request looks like. */
export interface ApnsRequestSpec {
  readonly authority: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
}

/**
 * The request one notification becomes.
 *
 * `apns-topic` is the registration's own bundle id and `apns-push-type` is
 * always `alert`: this channel only ever sends a user-visible notification, and
 * a body typed as anything else would be dropped by the system for having an
 * alert payload.
 * @param target - the device being notified.
 * @param jwt - the provider token.
 * @returns the authority, path and headers of the POST.
 */
export function apnsRequestSpec(target: PushAddress, jwt: string): ApnsRequestSpec {
  return {
    authority: target.environment === 'production' ? APNS_PRODUCTION_AUTHORITY : APNS_SANDBOX_AUTHORITY,
    path: `${APNS_DEVICE_PATH}${target.deviceToken}`,
    headers: {
      authorization: `bearer ${jwt}`,
      'apns-topic': target.bundle,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    },
  }
}

/**
 * The topic one Live Activity push is addressed under.
 * @param bundle - the app bundle the device registered with.
 * @returns the bundle plus the Live Activity suffix, appended once.
 */
export function liveActivityTopicOf(bundle: string): string {
  return bundle.endsWith(APNS_LIVE_ACTIVITY_TOPIC_SUFFIX) ? bundle : `${bundle}${APNS_LIVE_ACTIVITY_TOPIC_SUFFIX}`
}

/**
 * The request one Live Activity push becomes.
 *
 * Three headers differ from the alert request beside it, and each of them is a
 * rule rather than a preference: the push type is `liveactivity`, the topic is
 * the app bundle's Live Activity topic, and the expiration is `0` — a card
 * update that could not be delivered now must never be delivered later, because
 * it would overwrite the present with the past (§29).
 * @param target - the card being pushed to.
 * @param jwt - the provider token.
 * @returns the authority, path and headers of the POST.
 */
export function liveActivityRequestSpec(target: LiveActivityAddress, jwt: string): ApnsRequestSpec {
  return {
    authority: target.environment === 'production' ? APNS_PRODUCTION_AUTHORITY : APNS_SANDBOX_AUTHORITY,
    path: `${APNS_DEVICE_PATH}${target.token}`,
    headers: {
      authorization: `bearer ${jwt}`,
      'apns-topic': liveActivityTopicOf(target.bundle),
      'apns-push-type': 'liveactivity',
      'apns-priority': '10',
      'apns-expiration': '0',
      'content-type': 'application/json',
    },
  }
}

/** The reason APNs named, or its raw answer when it named none. */
function apnsReason(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) {
      const reason = (parsed as { reason?: unknown }).reason
      if (typeof reason === 'string' && reason !== '') return reason
    }
  } catch {
    // Not JSON: the body itself is the answer, and it is all there is.
  }
  return text.slice(0, 200)
}

export interface ApnsSenderOptions {
  readonly config: ApnsConfig
  readonly log?: (message: string) => void
  /** Clock the token lifetime is measured against; the wall clock by default. */
  readonly now?: () => number
  readonly timeoutMs?: number
  /** The HTTP/2 dial, injectable so the failure paths need no network. */
  readonly connect?: (authority: string) => ClientHttp2Session
}

/**
 * The APNs delivery half of the push channel.
 *
 * Every method resolves: a delivery that failed is a {@link PushSendResult} with
 * `ok: false`, never a rejection, because both callers sit on frame paths that
 * must not learn about APNs at all.
 */
export class ApnsSender implements PushSender, LiveActivitySender {
  readonly #config: ApnsConfig
  readonly #log: (message: string) => void
  readonly #now: () => number
  readonly #timeoutMs: number
  readonly #dial: (authority: string) => ClientHttp2Session
  #key: Promise<KeyObject> | undefined
  #token: { readonly value: string; readonly mintedAt: number } | undefined

  constructor(options: ApnsSenderOptions) {
    this.#config = options.config
    this.#log = options.log ?? (() => undefined)
    this.#now = options.now ?? (() => Date.now())
    this.#timeoutMs = options.timeoutMs ?? APNS_TIMEOUT_MS
    this.#dial = options.connect ?? (authority => connect(`https://${authority}`))
  }

  /** Deliver one notification, or report why it did not arrive. */
  async send(target: PushAddress, notification: PushNotification): Promise<PushSendResult> {
    let jwt: string
    try {
      jwt = await this.#providerToken()
    } catch (error) {
      return { ok: false, reason: `signing key unusable: ${String(error)}` }
    }
    return await this.#post(apnsRequestSpec(target, jwt), JSON.stringify(notification))
  }

  /**
   * Deliver one Live Activity push, or report why it did not arrive.
   *
   * The same provider token, the same transport and the same "resolve, never
   * reject" rule as {@link send}; only the request's headers and the body differ,
   * and both are built outside this class so the contract stays assertable.
   */
  async sendLiveActivity(target: LiveActivityAddress, notification: LiveActivityNotification): Promise<PushSendResult> {
    let jwt: string
    try {
      jwt = await this.#providerToken()
    } catch (error) {
      return { ok: false, reason: `signing key unusable: ${String(error)}` }
    }
    return await this.#post(liveActivityRequestSpec(target, jwt), JSON.stringify(notification))
  }

  /**
   * POST one already-built body to APNs.
   *
   * One HTTP/2 session per delivery, closed as soon as the answer is in: the
   * provider API has no session to keep warm, and one left open would outlive the
   * caller that wanted it. Every failure resolves, because both callers sit on
   * frame paths that must not learn about APNs at all.
   * @param spec - the authority, path and headers of the delivery.
   * @param body - the JSON body to send.
   * @returns whether APNs accepted it, and why not when it did not.
   */
  async #post(spec: ApnsRequestSpec, body: string): Promise<PushSendResult> {
    const authority = spec.authority
    return await new Promise<PushSendResult>((resolve) => {
      let settled = false
      let timer: NodeJS.Timeout | undefined
      const finish = (result: PushSendResult): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        try {
          session.close()
        } catch {
          // A session already gone is the outcome we wanted anyway.
        }
        resolve(result)
      }
      let session: ClientHttp2Session
      try {
        session = this.#dial(authority)
      } catch (error) {
        resolve({ ok: false, reason: `connect failed: ${String(error)}` })
        return
      }
      timer = setTimeout(() => { finish({ ok: false, reason: `no answer within ${this.#timeoutMs} ms` }) }, this.#timeoutMs)
      timer.unref?.()
      session.on('error', (error: Error) => { finish({ ok: false, reason: String(error) }) })
      session.on('close', () => { finish({ ok: false, reason: 'the connection closed before APNs answered' }) })
      let status = 0
      let text = ''
      try {
        const stream = session.request({ ':method': 'POST', ':path': spec.path, ...spec.headers })
        stream.setEncoding('utf8')
        stream.on('response', (headers) => { status = Number(headers[':status'] ?? 0) })
        stream.on('data', (chunk: string) => { text += chunk })
        stream.on('error', (error: Error) => { finish({ ok: false, reason: String(error) }) })
        stream.on('end', () => {
          finish(status === 200 ? { ok: true, status } : { ok: false, status, reason: apnsReason(text) })
        })
        stream.end(body)
      } catch (error) {
        finish({ ok: false, reason: `request failed: ${String(error)}` })
      }
    })
  }

  /** @returns the cached provider token, minting one when it has aged out. */
  async #providerToken(): Promise<string> {
    const now = this.#now()
    if (this.#token !== undefined && now - this.#token.mintedAt < APNS_TOKEN_TTL_MS) return this.#token.value
    this.#key ??= readFile(this.#config.keyFile, 'utf8').then(pem => createPrivateKey({ key: pem, format: 'pem' }))
    const key = await this.#key
    const value = es256Jwt({ key, keyId: this.#config.keyId, teamId: this.#config.teamId, issuedAt: now })
    this.#token = { value, mintedAt: now }
    this.#log(`minted an APNs provider token for key ${this.#config.keyId}`)
    return value
  }
}
