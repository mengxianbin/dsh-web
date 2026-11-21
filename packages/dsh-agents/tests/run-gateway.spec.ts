/**
 * Two run seams' wire contracts: the `session.create` body, and the record the
 * command dispatcher answers a permission switch with.
 *
 * A squad that pins no workspace must reach the Host as a request that carries
 * no workspaceId key at all. An explicit `undefined` or an empty string would be
 * a statement about a workspace rather than the absence of a pin, and a body with
 * the key present is what makes a Host compose the session somewhere the user
 * never chose.
 */
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createHostRunGateway, type CommandDispatcherFace, type TypertGatewayFace } from '../src/host/run-gateway.ts'

interface Recorded {
  namespace: string
  method: string
  args: Record<string, unknown>
}

/** A typert gateway that records every invocation and answers one session id. */
function recordingGateway(): { calls: Recorded[]; face: TypertGatewayFace } {
  const calls: Recorded[] = []
  const face: TypertGatewayFace = {
    async invoke(request) {
      calls.push({ namespace: request.namespace, method: request.method, args: request.args })
      return { sessionId: 'session-1' }
    },
  }
  return { calls, face }
}

describe('the session.create request a run sends', () => {
  it('operator runs an unbound squad and the request carries no workspaceId key', async () => {
    // Given a run with no workspace pin, When the gateway creates the session, Then the request body has no workspaceId key at all.
    const { calls, face } = recordingGateway()
    const gateway = createHostRunGateway({ gateway: face })

    expect(await gateway.createSession({})).toEqual({ sessionId: 'session-1' })
    expect(calls.map(call => call.namespace + '/' + call.method)).toEqual(['session/create'])
    const body = calls[0]?.args.request as Record<string, unknown>
    expect(body).toEqual({})
    expect(Object.keys(body)).toEqual([])
  })

  it('operator runs a squad pinned to a workspace and the request carries exactly that pin', async () => {
    // Given a validated pin, When the gateway creates the session, Then the request body names that workspace and nothing else.
    const { calls, face } = recordingGateway()
    const gateway = createHostRunGateway({ gateway: face })

    await gateway.createSession({ workspaceId: 'ws-1' })
    expect(calls[0]?.args).toEqual({ request: { workspaceId: 'ws-1' } })
  })
})

describe('the permission command a run applies', () => {
  /** A dispatcher that answers one prepared settle record and records the line it ran. */
  function dispatcher(answer: { commandId: string; result: { kind: string; text?: string } } | undefined): {
    lines: string[]
    face: CommandDispatcherFace
  } {
    const lines: string[] = []
    const face: CommandDispatcherFace = {
      async execute(_agent, line) {
        lines.push(line)
        return answer
      },
    }
    return { lines, face }
  }

  it('operator pins a permission and the settled success record is read, not the record wrapper', async () => {
    // Given a dispatcher that answers the settle record wrapping a success, When the run applies danger-full-access, Then it neither throws nor invents a failure.
    const { lines, face } = dispatcher({ commandId: 'cmd-1', result: { kind: 'success', text: 'preset danger-full-access' } })
    const gateway = createHostRunGateway({ commands: face, agents: { get: () => ({}) as unknown as Agent } })

    await expect(gateway.applyPermission('session-1', 'danger-full-access')).resolves.toBeUndefined()
    expect(lines).toEqual(['/permission danger-full-access'])
  })

  it('operator pins a permission the Host refuses and the refusal text survives', async () => {
    // Given a dispatcher whose handler refused, When the run applies the pin, Then the handler's own text is the failure, not a generic one.
    const { face } = dispatcher({ commandId: 'cmd-2', result: { kind: 'error', text: 'unknown preset "danger-full-access"' } })
    const gateway = createHostRunGateway({ commands: face, agents: { get: () => ({}) as unknown as Agent } })

    await expect(gateway.applyPermission('session-1', 'danger-full-access')).rejects.toThrow('unknown preset "danger-full-access"')
  })

  it('operator pins a permission on a Host that answers no settle record and the run says so', async () => {
    // Given no settled command at all, When the run applies the pin, Then it reports the missing acknowledgement instead of a refused preset.
    const { face } = dispatcher(undefined)
    const gateway = createHostRunGateway({ commands: face, agents: { get: () => ({}) as unknown as Agent } })

    await expect(gateway.applyPermission('session-1', 'read-only')).rejects.toThrow('the permission command was not acknowledged')
  })
})

