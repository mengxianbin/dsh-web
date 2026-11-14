/**
 * The pairing switch copy (issues #1665 and #1919). The switch governs the bare
 * /api surface only: the /remote channel always requires a paired credential,
 * so its wording must never read as "turn this off and the public entry loses
 * its gate". These specs pin that decision in both dictionaries the client
 * ships, so a later copy edit cannot silently drop it.
 */
import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

describe('pairing switch copy', () => {
  it('operator reads that the switch covers the bare /api surface', () => {
    // Given the zh and en dictionaries this client registers
    // When the switch label is read
    // Then it names the /api surface rather than claiming all LAN access
    expect(zh['settings.requirePairingForLan']).toContain('/api')
    expect(en['settings.requirePairingForLan']).toContain('/api')
  })

  it('operator reads that turning it off never unauthenticates the public entry', () => {
    // Given the same dictionaries
    // When the switch hint is read
    // Then it names the /remote channel as the entry that always requires
    // pairing, and states that the public entry keeps its gate
    expect(zh['settings.requirePairingForLanHint']).toContain('/remote')
    expect(zh['settings.requirePairingForLanHint']).toContain('公网入口')
    expect(zh['settings.requirePairingForLanHint']).toContain('无鉴权')
    expect(en['settings.requirePairingForLanHint']).toContain('/remote')
    expect(en['settings.requirePairingForLanHint']).toContain('public entry')
    expect(en['settings.requirePairingForLanHint']).toContain('unauthenticated')
  })

  it('operator reads that the failing forwarder leaves the loopback entry working', () => {
    // Given the LAN status copy
    // When the forwarder bind failure and the no-address reason are read
    // Then both say the loopback entry is unaffected, so a missing LAN entry
    // is never mistaken for a dead server
    expect(zh['lan.forward.error']).toContain('回环入口不受影响')
    expect(zh['lan.noLanAddress']).toContain('回环入口不受影响')
    expect(en['lan.forward.error']).toContain('loopback entry is unaffected')
    expect(en['lan.noLanAddress']).toContain('loopback entry is unaffected')
  })
})
