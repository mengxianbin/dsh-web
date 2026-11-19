/**
 * The introspection endpoint's contract: the three route states the dispatch
 * pinned, and the snapshot shape the reaper/duty faces read.
 *
 * The registry runs against an in-process fake provider that answers frames
 * and writes the seam's ledger line the way the real one does, so the
 * sessionId ↔ shellPid mapping asserted here is the same code path production
 * takes — only the process is a stand-in.
 */
import { mkdtempSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessRuntime,
} from '@deepseek-ai/dsh-subprocess'
import { ShellRegistry } from '../src/shell.ts'
import { makeShellsRoute, SHELLS_PATH } from '../src/host/shells-route.ts'

/**
 * The pid the fake provider reports for every shell it spawns: this worker's
 * own pid, which is always live — the registry's liveness floor rejects a
 * recorded pid whose process is already gone (observed pid reuse), so a
 * stand-in pid must pass that floor to reach the assertions.
 */
const FAKE_SHELL_PID = process.pid

/** The registry clock's fixed epoch, so `born` asserts exactly. */
const FIXED_BORN = 1_766_000_000_000

const BUDGET = { stdoutBytes: 64 * 1024, stderrBytes: 16 * 1024, timeoutMs: 30_000 }

const RUNTIME_PATHS = { bash: 'C:/payload/bash.exe', bin: 'C:/payload/bin' }

/**
 * A provider that answers every stdin frame with one well-formed response
 * (version-shaped stdout, exit 0 — the handshake's gate) and records its
 * spawn in the injected ledger, exactly as the real seam does.
 * @param ledgerPath - the isolated ledger file for the test.
 * @returns the runtime plus a handle that settles the shell's outcome.
 */
function fakeRuntime(ledgerPath: string): { runtime: SubprocessRuntime, settle: () => void } {
  let settleOutcome: ((outcome: SubprocessOutcome) => void) | undefined
  const runtime = {
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      appendFileSync(ledgerPath, JSON.stringify({
        ts: new Date().toISOString(),
        event: 'spawn',
        runner: FAKE_SHELL_PID,
        target: spec.argv[0],
      }) + '\n')
      let output = ''
      const done = new Promise<SubprocessOutcome>(resolve => { settleOutcome = resolve })
      const handle = {
        stdin: {
          write(text: string): boolean {
            const begin = /__DSH_WIN_BASH_[A-Za-z0-9]+__BEGIN/.exec(text)?.[0]
            const end = /__DSH_WIN_BASH_[A-Za-z0-9]+__END/.exec(text)?.[0]
            if (begin !== undefined && end !== undefined) {
              output += '\n' + begin + '\n5.3.9\n' + end + '0\n'
            }
            return true
          },
        },
        stdout: undefined,
        stderr: undefined,
        control: undefined,
        collected: {
          stdout: {
            readFrom: (offset: number) => ({ text: output.slice(offset), nextOffset: output.length, lossy: false }),
          },
          stderr: {
            readFrom: (offset: number) => ({ text: '', nextOffset: 0, lossy: false }),
          },
        },
        done,
        terminate: () => { /* nothing to tear down: no process exists */ },
        terminateForHostExit: () => { /* nothing to tear down: no process exists */ },
        waitForExit: async () => true,
      }
      return handle as unknown as SubprocessHandle
    },
    resolveExecutable: async (command: string) => command,
    terminalEnvironment: async () => ({ platform: 'windows' as const }),
    spawnTerminal: () => { throw new Error('win_bash never allocates a terminal') },
  } as unknown as SubprocessRuntime
  return { runtime, settle: () => { settleOutcome?.({ exitCode: 0, signal: null }) } }
}

/** Minimal req double: the route only reads method/headers/socket. */
function fakeReq(method: string, opts: { loopback?: boolean } = {}): IncomingMessage {
  const stream = Readable.from([]) as IncomingMessage
  stream.method = method
  stream.url = SHELLS_PATH
  stream.headers = { host: '127.0.0.1:3080' }
  stream.socket = { remoteAddress: opts.loopback === false ? '203.0.113.7' : '127.0.0.1' } as IncomingMessage['socket']
  return stream
}

interface Captured { status: number, body: unknown }

/** Minimal res double: the route writes one head and one JSON body. */
function fakeRes(): { res: ServerResponse, captured: Captured } {
  const captured: Captured = { status: 0, body: undefined }
  const res = {
    writeHead(status: number): unknown { captured.status = status; return res },
    end(payload?: string): void { if (payload !== undefined) captured.body = JSON.parse(payload) },
  } as unknown as ServerResponse
  return { res, captured }
}

/** Invoke the route once and return what the client would see. */
function call(handler: (req: IncomingMessage, res: ServerResponse) => void, req: IncomingMessage): Captured {
  const { res, captured } = fakeRes()
  handler(req, res)
  return captured
}

let ledgerDir: string
let ledgerPath: string

beforeEach(() => {
  ledgerDir = mkdtempSync(join(tmpdir(), 'dsh-win-bash-route-'))
  ledgerPath = join(ledgerDir, 'subprocess-ledger.jsonl')
  process.env.DSH_SUBPROCESS_LEDGER = ledgerPath
})

afterEach(() => {
  delete process.env.DSH_SUBPROCESS_LEDGER
  rmSync(ledgerDir, { recursive: true, force: true })
})

/** One registry with one held shell, keyed by an owner carrying a session id. */
async function heldShell(sessionId: string | undefined): Promise<{ shells: ShellRegistry, settle: () => void }> {
  const { runtime, settle } = fakeRuntime(ledgerPath)
  const shells = new ShellRegistry(runtime, () => FIXED_BORN)
  const owner = sessionId === undefined ? {} : { session: { id: sessionId } }
  await shells.run(owner, RUNTIME_PATHS, process.cwd(), 'true', BUDGET)
  return { shells, settle }
}

describe('GET /api/win-bash/shells route states', () => {
  it('loopback GET answers 200 with the pinned body', async () => {
    // Given a registry holding one shell for a session,
    const { shells } = await heldShell('session-abc')
    const route = makeShellsRoute(shells)
    // When a loopback GET arrives,
    const captured = call(route.handler, fakeReq('GET'))
    // Then the pinned200 body comes back verbatim.
    expect(captured.status).toBe(200)
    expect(captured.body).toEqual({
      ok: true,
      hostPid: process.pid,
      shells: [{ sessionId: 'session-abc', shellPid: FAKE_SHELL_PID, born: FIXED_BORN, exited: false }],
    })
  })

  it('non-loopback request answers 403 before anything else', async () => {
    // Given the same registry,
    const { shells } = await heldShell('session-abc')
    const route = makeShellsRoute(shells)
    // When a remote address outside 127/8 asks,
    const captured = call(route.handler, fakeReq('GET', { loopback: false }))
    // Then the fence rejects it.
    expect(captured.status).toBe(403)
    expect(captured.body).toEqual({ ok: false, error: 'forbidden: loopback-only' })
  })

  it('fence precedes the method check: a remote POST is still 403', async () => {
    const { shells } = await heldShell('session-abc')
    const route = makeShellsRoute(shells)
    const captured = call(route.handler, fakeReq('POST', { loopback: false }))
    expect(captured.status).toBe(403)
  })

  it('loopback non-GET answers 405', async () => {
    const { shells } = await heldShell('session-abc')
    const route = makeShellsRoute(shells)
    const captured = call(route.handler, fakeReq('POST'))
    expect(captured.status).toBe(405)
    expect(captured.body).toEqual({ ok: false, error: 'method not allowed: use GET' })
  })
})

describe('snapshot() shape', () => {
  it('maps a held shell to its canonical session id, tree-root pid and birth instant', async () => {
    // Given a shell spawned for a bare (prefix-less) session id,
    const { shells } = await heldShell('c8ab6007-7e24-48e0-ad76-a7dc2f693897')
    const snapshot = shells.snapshot()
    // Then the owner, the ledger's tree-root pid and the fixed clock line up,
    expect(snapshot).toEqual([{
      sessionId: 'session-c8ab6007-7e24-48e0-ad76-a7dc2f693897',
      shellPid: FAKE_SHELL_PID,
      born: FIXED_BORN,
      exited: false,
    }])
    // And a second read is identical: the pass never mutates the registry.
    expect(shells.snapshot()).toEqual(snapshot)
    expect(shells.size).toBe(1)
  })

  it('reports null sessionId for an owner without a readable session id', async () => {
    const { shells } = await heldShell(undefined)
    expect(shells.snapshot()).toEqual([
      { sessionId: null, shellPid: FAKE_SHELL_PID, born: FIXED_BORN, exited: false },
    ])
  })

  it('reports exited once the handle outcome settles', async () => {
    const { shells, settle } = await heldShell('session-abc')
    expect(shells.snapshot()[0].exited).toBe(false)
    settle()
    await new Promise<void>(resolve => { setTimeout(resolve, 0) })
    expect(shells.snapshot()[0]).toEqual({
      sessionId: 'session-abc',
      shellPid: FAKE_SHELL_PID,
      born: FIXED_BORN,
      exited: true,
    })
  })
})
