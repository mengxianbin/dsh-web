import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Cross-repo heavy-io gate wiring (dshweb-manual-gate-1108, 立 2026-11-08 · 落 2026-11-13).
 *
 * dsh-web has no local gate copy on purpose (single source, plan A): the two
 * `heavy:*` entries invoke the harness gate script by absolute path through the
 * harness-owned tsx CLI — the same cross-repo form the auto-build watchdog uses
 * (`scripts/dsh/build-watchdog.py` in m-note: `node <tsx cli.mjs> <gate.ts> …`),
 * because neither the dsh-web session PATH nor this repo ships a tsx binary.
 * The absolute paths are an accepted machine binding of that decision.
 *
 * These assertions pin (a) both entry texts byte-for-byte and (b) the inner
 * command of each wrapper (`pnpm build` / `pnpm test`) so a future edit can
 * neither drop the gate nor silently rewrite the wrapped command — the same
 * wiring/reverse-assertion pattern as harness `heavy-io-gate.spec.ts`. They are
 * pure string checks, so CI runners without D:/tech still pass them.
 */
const GATE_PREFIX = 'node "D:/tech/deepseek-harness/node_modules/tsx/dist/cli.mjs" "D:/tech/deepseek-harness/scripts/heavy-io-gate.ts"'

const { scripts } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

test('heavy:build wraps the literal `pnpm build` with the harness heavy-io gate', () => {
  assert.equal(scripts['heavy:build'], `${GATE_PREFIX} "pnpm build"`)
})

test('heavy:test wraps the literal `pnpm test` with the harness heavy-io gate', () => {
  assert.equal(scripts['heavy:test'], `${GATE_PREFIX} "pnpm test"`)
})

test('pre-existing build/test script texts stay byte-identical (load-bearing keys)', () => {
  assert.equal(scripts.build, 'node scripts/build-stamp.mjs run -- "pnpm -r build"')
  assert.equal(scripts.test, 'pnpm -r test')
})
