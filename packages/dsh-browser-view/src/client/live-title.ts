/**
 * The page title the tab body last saw, published for the tab's chip.
 *
 * The chip is drawn by the shell beside a body this plugin owns, so the two
 * cannot exchange props: the body learns the streamed page's title from its
 * socket, and the title component reads it here. A chip that says "Browser
 * view" for a session whose page is called "Checkout" is the worse of the two
 * labels, so the body publishes and the title prefers what it published.
 *
 * One browser-view tab per session is what the kind declares (no `multiple`),
 * so the session id alone identifies the entry: there is no second tab whose
 * title could overwrite the first one's.
 */

/** Cross-component title channel, keyed by session. */
export interface BrowserViewLiveTitleStore {
  /**
   * The last published title for a session.
   * @param sessionId - session key, or undefined when the component has none.
   * @returns the title, or undefined when nothing is published.
   */
  get(sessionId: string | undefined): string | undefined
  /**
   * Publish a session's page title, or clear it with undefined or an empty one.
   * @param sessionId - session key, or undefined to drop the write.
   * @param title - the page title, or undefined when the page has none.
   */
  set(sessionId: string | undefined, title: string | undefined): void
  /**
   * Observe publications.
   * @param listener - synchronous invalidation callback.
   * @returns unsubscribe.
   */
  subscribe(listener: () => void): () => void
}

/**
 * Create one store for the plugin's lifetime.
 * @returns the channel.
 */
export function createLiveTitleStore(): BrowserViewLiveTitleStore {
  const titles = new Map<string, string>()
  const listeners = new Set<() => void>()
  const notify = (): void => {
    // Copy first: a listener may unsubscribe while being notified.
    for (const listener of [...listeners]) listener()
  }
  return {
    get(sessionId: string | undefined): string | undefined {
      return sessionId === undefined ? undefined : titles.get(sessionId)
    },
    set(sessionId: string | undefined, title: string | undefined): void {
      if (sessionId === undefined) return
      const current = titles.get(sessionId)
      if (title === undefined || title.length === 0) {
        if (current === undefined) return
        titles.delete(sessionId)
        notify()
        return
      }
      if (current === title) return
      titles.set(sessionId, title)
      notify()
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
