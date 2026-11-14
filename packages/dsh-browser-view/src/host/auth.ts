/**
 * DSH's own authentication page, and the single launch-token retry a
 * navigation to it gets.
 *
 * A fresh `dsh web` process prints a URL carrying `?token=<launch token>`.
 * A request to the site root with that token answers 303 to the clean address
 * and sets the `dsh-auth-<authority>` cookie; every later request is served
 * from the cookie. A browser profile that never received the token — an
 * ephemeral `--user-data-dir`, which is exactly what this plugin launches —
 * sees the 401 challenge instead, whose body is the sentence matched here.
 *
 * The host's connection service can mint that same token for any URL
 * (`ctx.connection.authenticatedUrl`), which is what makes the retry possible
 * without this package depending on that SDK.
 *
 * If DSH rewords the challenge, {@link AUTH_CHALLENGE_TEXT} simply stops
 * matching: the capability degrades to showing the authentication page exactly
 * as before, and no other site's page is ever mistaken for ours.
 *
 * @module @linxin666/dsh-client-ui-browser-view/host/auth
 */

import { isLoopbackHostname } from './loopback.ts'

/**
 * Body text of the page DSH serves when a request carries neither the launch
 * token nor a valid cookie. This is the one page the top-up reacts to.
 */
const AUTH_CHALLENGE_TEXT = /dsh web authentication required/i

/**
 * Script that reads the document's visible text. `document.body` is absent on
 * a document that has no body yet, and `innerText` needs one.
 */
export const DOCUMENT_TEXT_EXPRESSION = "document.body ? document.body.innerText : ''"

/**
 * The host seam that turns one clean URL into the same URL carrying the
 * process launch token. Typed structurally: the connection SDK package is not
 * a dependency of this one.
 */
export interface AuthenticatedUrlSource {
  /**
   * @param baseUrl - clean browser URL whose authority and mount are preserved.
   * @returns the same URL carrying the process token.
   */
  authenticatedUrl(baseUrl: string): string
}

/**
 * Whether a page's visible text is DSH's authentication challenge.
 * @param text - `document.body.innerText` of the page that just loaded.
 * @returns true when the document is the challenge rather than a real page.
 */
export function isAuthChallengeText(text: string): boolean {
  return AUTH_CHALLENGE_TEXT.test(text)
}

/**
 * Whether a navigation target is one this DSH process serves on loopback: a
 * `localhost` name, 127/8, or `[::1]`. A remote site can render any text it
 * likes, so only a loopback authority is worth a token retry.
 * @param url - the URL a navigation was asked to open.
 * @returns true for an absolute http(s) URL naming a loopback authority.
 */
export function isLoopbackTarget(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  return isLoopbackHostname(parsed.hostname)
}
