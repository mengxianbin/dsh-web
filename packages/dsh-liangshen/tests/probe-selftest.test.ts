import { describe, expect, test } from 'vitest'

import { probeInventory, PROBES, runSelftest } from '../tools/probe-selftest.mjs'

describe('behaviour probes', () => {
  test('operator finds every probe shipped with its environment, oracle, and both policies', () => {
    // Given the probe directory
    const inventory = probeInventory()
    // When the inventory is read
    // Then every probe ships exactly the three files the selftest drives
    expect(inventory.map((entry) => entry.name)).toEqual(PROBES)
    for (const entry of inventory) {
      expect(entry.files, entry.name + ' is incomplete').toEqual(['env.mjs', 'grade.mjs', 'strategies.mjs'])
    }
  })

  // The offline half of the method: a probe that cannot fail its own bad policy,
  // or cannot pass its own good one, measures nothing and must not ship.
  test('operator only trusts a probe that separates its own scripted habits', async () => {
    // Given four probes, each with a scripted good policy and a scripted bad one
    const result = await runSelftest()
    // When both policies are driven through the same environment
    // Then the good one passes, the bad one fails, and the named metric moves
    for (const row of result.rows) {
      expect(row.good.passed, row.name + ' good policy must pass').toBe(true)
      expect(row.bad.passed, row.name + ' bad policy must fail').toBe(false)
      expect(row.ok, row.name + ' must move ' + row.rule.metric).toBe(true)
    }
    expect(result.ok).toBe(true)
  }, 120000)
})