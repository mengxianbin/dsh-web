import { describe, expect, it } from 'vitest'
import { deviceDisplayName, deviceNameFromUserAgent, duplicateDeviceGroups } from '../src/client/device-name.ts'

describe('deviceNameFromUserAgent', () => {
  it.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36', 'Windows · Chrome'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.3 Safari/605.1.15', 'macOS · Safari'],
    ['Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/151.0.0.0 Mobile Safari/537.36', 'Android · Chrome'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1', 'iOS · Safari'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/151.0.0.0', 'Windows · Edge'],
  ])('labels %s as %s', (userAgent, expected) => {
    expect(deviceNameFromUserAgent(userAgent)).toBe(expected)
  })

  it('returns no label for an absent or unrecognized User-Agent', () => {
    expect(deviceNameFromUserAgent()).toBeUndefined()
    expect(deviceNameFromUserAgent('Custom Client')).toBeUndefined()
  })
})

describe('deviceDisplayName', () => {
  it('user sees the custom name, then the UA name, then the fallback', () => {
    // Given rows with a custom name, a blank custom name, and neither.
    const named = { name: 'My phone', userAgent: 'Custom Client' }
    const blank = { name: '   ', userAgent: 'Mozilla/5.0 (Linux; Android 16) Chrome/151.0.0.0' }
    const bare = {}
    // When the panel resolves each label...
    // Then the custom name wins, then the UA-derived name, then the fallback.
    expect(deviceDisplayName(named, 'Unknown device')).toBe('My phone')
    expect(deviceDisplayName(blank, 'Unknown device')).toBe('Android · Chrome')
    expect(deviceDisplayName(bare, 'Unknown device')).toBe('Unknown device')
  })
})

describe('duplicateDeviceGroups', () => {
  it('user sees rows grouped by an exact non-empty User-Agent, with singletons dropped', () => {
    // Given two rows sharing one User-Agent plus several singletons.
    const devices = [
      { id: 'a', userAgent: 'UA-1' },
      { id: 'b', userAgent: 'UA-2' },
      { id: 'c', userAgent: 'UA-1' },
      { id: 'd' },
      { id: 'e', userAgent: '  ' },
    ]
    // When the roster groups its rows...
    const groups = duplicateDeviceGroups(devices)
    // Then only the shared User-Agent forms a group.
    expect(groups).toEqual([[devices[0], devices[2]]])
  })

  it('user sees no duplicate group when every row is unique', () => {
    // Given a roster with no repeated User-Agent.
    const devices = [{ userAgent: 'A' }, { userAgent: 'B' }]
    // When the roster groups its rows...
    const groups = duplicateDeviceGroups(devices)
    // Then no merge affordance would be offered.
    expect(groups).toEqual([])
    expect(duplicateDeviceGroups([])).toEqual([])
  })
})
