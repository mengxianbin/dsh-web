/**
 * The shared renewal core: the credential seams both the route family and
 * the resident auto-renew loop speak to, plus ONE implementation of the
 * renew execution (resolve → chain → store). The interactive route and the
 * scheduled loop call the same `performRenew`, so their fail-closed rules
 * (store only after a passing chain verdict, both jars on every write) can
 * never drift apart — the route maps this result onto HTTP, the loop onto
 * logs and its pause latch.
 * @module dsh-mimo-relogin/host/renew-core
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { renewChain, type ChainHop } from './chain.ts'
import { assembleHeader, jarFromHeader } from './probe.ts'

/** The managed credential the dsh-usage MiMo adapter probes with (platform jar). */
export const PLATFORM_REF: CredentialRef = credentialRef('MIMO_PLATFORM_COOKIE')
/** The managed credential the renewal chain consumes (account jar / passToken). */
export const ACCOUNT_REF: CredentialRef = credentialRef('MIMO_ACCOUNT_COOKIES')

/** The credential seam duck-typed from ctx.get('credentials'). */
export interface CredentialsSeam {
  resolve(ref: CredentialRef): Promise<{ value?: string } | undefined>
  set(ref: CredentialRef, value: string): Promise<void>
  describe(ref: CredentialRef): Promise<{ configured: boolean }>
}

/** Resolve the managed-credentials seam from the plugin context. */
export function credentialsOf(ctx: Context): CredentialsSeam | undefined {
  try {
    return ctx.get('credentials') as CredentialsSeam | undefined
  } catch {
    return undefined
  }
}

/** Balance probe result as the chain reports it (status always present on `ok`). */
export interface RenewBalance {
  status: number
  balance?: string
  currency?: string
}

/**
 * Result of one renew execution:
 * - `no-credentials` — the seam is missing (host wiring down);
 * - `no-account` — no stored account cookies, the chain has no root to walk;
 * - `chain` — the chain answered with a non-ok verdict (`interactive` = passToken
 *   gone, `failed`/`no-url` = chain or platform shape broke), nothing stored;
 * - `store-error` — the chain passed but the credential store refused a write;
 * - `ok` — both jars rotated and stored, balance probe green.
 */
export type RenewResult =
  | { status: 'no-credentials' }
  | { status: 'no-account' }
  | { status: 'chain', verdict: 'interactive' | 'failed' | 'no-url', note?: string, hops: ChainHop[] }
  | { status: 'store-error', error: string }
  | { status: 'ok', hops: ChainHop[], balance?: RenewBalance }

/**
 * Execute one renewal against the stored credentials (fail-closed: the
 * credential store is touched only after the chain reports `ok`).
 * @param ctx - host plugin context (credentials seam).
 * @param platformUrl - platform origin the chain walks and probes.
 * @param fetchImpl - injectable fetch (tests replay the chain).
 * @returns the structured result; never throws for expected failures.
 */
export async function performRenew(
  ctx: Context,
  platformUrl: string,
  fetchImpl: typeof fetch,
): Promise<RenewResult> {
  const creds = credentialsOf(ctx)
  if (creds === undefined) return { status: 'no-credentials' }
  const accountHeader = (await creds.resolve(ACCOUNT_REF).catch(() => undefined))?.value
  if (accountHeader === undefined || accountHeader === '') return { status: 'no-account' }
  const platformHeader = (await creds.resolve(PLATFORM_REF).catch(() => undefined))?.value ?? ''
  const outcome = await renewChain({
    platformUrl,
    platformJar: jarFromHeader(platformHeader),
    accountJar: jarFromHeader(accountHeader),
    fetchImpl,
  })
  if (outcome.verdict !== 'ok') {
    return {
      status: 'chain',
      verdict: outcome.verdict,
      ...(outcome.note === undefined ? {} : { note: outcome.note }),
      hops: outcome.hops,
    }
  }
  try {
    await creds.set(PLATFORM_REF, assembleHeader(outcome.platformJar))
    await creds.set(ACCOUNT_REF, assembleHeader(outcome.accountJar))
  } catch (error) {
    return { status: 'store-error', error: String(error) }
  }
  return {
    status: 'ok',
    hops: outcome.hops,
    ...(outcome.balance === undefined ? {} : { balance: outcome.balance }),
  }
}
