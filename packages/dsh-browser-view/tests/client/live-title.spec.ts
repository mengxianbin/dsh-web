// @vitest-environment jsdom
/**
 * The title channel between a tab body and its chip: one entry per session, a
 * publication only when the title actually changed, and a clear that both drops
 * the entry and wakes the chip up.
 */
import { describe, expect, it } from 'vitest'
import { createLiveTitleStore } from '../../src/client/live-title.ts'

describe('browser view live title channel', () => {
  it('user switches between two sessions and each chip keeps that session own page title', () => {
    // Given one channel shared by two sessions
    // When both publish a page title
    // Then each session reads back its own title and an unpublished one reads nothing
    const channel = createLiveTitleStore()

    channel.set('session-a', 'Checkout')
    channel.set('session-b', 'Invoices')

    expect(channel.get('session-a')).toBe('Checkout')
    expect(channel.get('session-b')).toBe('Invoices')
    expect(channel.get('session-c')).toBeUndefined()
    expect(channel.get(undefined)).toBeUndefined()
  })

  it('user closes the tab and its chip stops naming a page nobody is streaming', () => {
    // Given a session whose page title was published
    // When the body clears it
    // Then the channel holds no title for that session and the subscriber was woken once
    const channel = createLiveTitleStore()
    let notified = 0
    channel.subscribe(() => { notified += 1 })
    channel.set('session-a', 'Checkout')

    channel.set('session-a', undefined)

    expect(channel.get('session-a')).toBeUndefined()
    expect(notified).toBe(2)
  })

  it('operator receives one notification per change and none for a repeated title', () => {
    // Given a subscriber on the channel
    // When the same page title is published twice and then a different one
    // Then only the two real changes notify, so a chip does not re-render on a repeated push
    const channel = createLiveTitleStore()
    let notified = 0
    channel.subscribe(() => { notified += 1 })

    channel.set('session-a', 'Checkout')
    channel.set('session-a', 'Checkout')
    channel.set('session-a', 'Payment')

    expect(notified).toBe(2)
    expect(channel.get('session-a')).toBe('Payment')
  })
})
