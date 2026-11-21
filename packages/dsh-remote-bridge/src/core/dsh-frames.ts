/**
 * DSH session frames to protocol v1 `session.delta` payloads, plus the reverse
 * projection of a follow baseline into `session.snapshot` turns.
 *
 * Only frame SHAPES are read here, never DSH classes: the frame argument is
 * `unknown` and every field is narrowed structurally, so a cohort that adds a
 * field to a chunk cannot break the bridge and a cohort that renames one fails
 * loudly at the mapping instead of emitting a half-filled delta.
 * @module dsh-remote-bridge/core/dsh-frames
 */

/** One image a durable `user/message` carried, as far as a client renders it. */
export interface UserMessageAttachment {
  readonly attachmentId: string
  readonly mediaType: string
  readonly name?: string
}

/** Token usage one finished `assistant/message` reported, passed through unconverted. */
export interface MessageUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

/**
 * Where one user message came from, as the host's durable `source` says.
 *
 * The three kinds are the only classification this protocol makes, and they are
 * read off `source.kind` mechanically: `user` and `user-approval` are a human,
 * `agent-message` and `subagent-settled` are an agent, and every other kind —
 * including one this bridge has never seen — is the system. `sourceKind` is the
 * host's own string, verbatim, so a client can tell "the system" apart without
 * the bridge inventing a taxonomy it cannot keep current.
 */
export interface MessageActor {
  readonly kind: 'human' | 'agent' | 'system'
  readonly sourceKind: string
  /** Durable id of the session that sent the message; only known for an agent. */
  readonly sessionId?: string
  /** The host's own display label for the source, when it wrote one. */
  readonly label?: string
}

/** One protocol v1 delta, before the session id and event sequence are attached. */
export type SessionDelta =
  | { readonly kind: 'text'; readonly text: string; readonly blockIndex: number }
  | { readonly kind: 'reasoning'; readonly text: string; readonly blockIndex: number }
  | { readonly kind: 'tool-call'; readonly callId: string; readonly name: string; readonly argumentsDelta: string }
  | { readonly kind: 'tool-result'; readonly callId: string; readonly output: string; readonly isError: boolean }
  | { readonly kind: 'turn-end'; readonly reason: string }
  | { readonly kind: 'user-message'; readonly text: string; readonly messageId?: string; readonly attachments?: readonly UserMessageAttachment[]; readonly actor?: MessageActor }
  | { readonly kind: 'subagent'; readonly childId: string; readonly label?: string; readonly mode?: string; readonly callId?: string }
  | { readonly kind: 'usage'; readonly usage: MessageUsage; readonly turn?: number; readonly step?: number }

/** Highest number of tool calls one connection remembers by id. */
export const TOOL_CALL_MEMORY = 512
/** Highest number of published user messages one connection remembers by id. */
export const USER_MESSAGE_MEMORY = 512

/**
 * The durable entry types a protocol v1 client renders — `user/message`,
 * `assistant/message`, `tool/call`, `tool/result` and `subagent/catalog`.
 * Everything else in a turn's entries is the harness's own bookkeeping, which
 * the client can only count as unknown, so a client that asks for a trimmed
 * baseline is not sent it.
 *
 * The catalog entry is here because it is the baseline half of the subagent
 * thread: a phone that opens a session after children were spawned has no other
 * way to learn that they exist, their labels, their modes or the call that
 * spawned them. Without it the thread header can only be inferred from agent
 * messages, and every field the catalog carries is lost.
 */
export const RENDERED_ENTRY_TYPES: ReadonlySet<string> = new Set([
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'subagent/catalog',
])

/** One raw durable event inside a snapshot turn. */
export interface SnapshotEntry {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly data: unknown
  /** Where a `user/message` came from; absent on every other entry type. */
  readonly actor?: MessageActor
}

/** One turn of a session snapshot: the durable events from `turn/start` to `turn/end`. */
export interface SnapshotTurn {
  /** Seq of the `turn/start` event, or 0 for the lead-in before the first turn. */
  readonly seq: number
  readonly time: number
  /** Seq of the `turn/end` event, or 0 while the turn is still open. */
  readonly endSeq: number
  readonly endTime: number
  /** `turn/end` reason kind, or the empty string while the turn is open. */
  readonly reason: string
  readonly entries: readonly SnapshotEntry[]
}

/** The opening frame of a `session/follow` stream. */
export interface FollowBaseline {
  readonly cursor: number
  readonly records: readonly unknown[]
  readonly hasMore: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === 'string' ? field : undefined
}

/**
 * Remembers which tool calls have already streamed their arguments, so the
 * durable `tool/call` event that follows the stream is not replayed as a second
 * copy of the same arguments. Bounded: a long-lived connection must not grow
 * with every call it ever saw.
 */
export class ToolCallIndex {
  readonly #names = new Map<string, string>()

  /** @returns whether this call already contributed a delta. */
  has(callId: string): boolean {
    return this.#names.has(callId)
  }

  /** @returns the last name seen for this call, if any. */
  nameOf(callId: string): string | undefined {
    return this.#names.get(callId)
  }

  /** Remember one call, evicting the oldest entry past {@link TOOL_CALL_MEMORY}. */
  remember(callId: string, name: string): void {
    if (name !== '') this.#names.set(callId, name)
    else if (!this.#names.has(callId)) this.#names.set(callId, '')
    while (this.#names.size > TOOL_CALL_MEMORY) {
      const oldest = this.#names.keys().next()
      if (oldest.done === true) break
      this.#names.delete(oldest.value)
    }
  }
}

/**
 * Remembers which durable user messages this connection already published.
 *
 * A client only ever appends a transcript, so one durable `user/message` must
 * reach the wire once: a replayed event would draw the same prompt a second
 * time. Bounded for the same reason {@link ToolCallIndex} is — a long-lived
 * connection must not grow with every message it ever saw.
 */
export class MessageIndex {
  readonly #ids = new Set<string>()

  /** @returns whether this message already contributed a delta. */
  has(id: string): boolean {
    return this.#ids.has(id)
  }

  /** Remember one message, evicting the oldest entry past {@link USER_MESSAGE_MEMORY}. */
  remember(id: string): void {
    this.#ids.add(id)
    while (this.#ids.size > USER_MESSAGE_MEMORY) {
      const oldest = this.#ids.values().next()
      if (oldest.done === true) break
      this.#ids.delete(oldest.value)
    }
  }
}

/**
 * The child sessions one `tool/result` payload names as spawned.
 *
 * A spawn answers with a handle, and the handle is the only place a durable
 * record ties a child id to the call that made it: the catalog event names the
 * child but not the call. Two shapes are written by this harness and both are
 * read here, verbatim from a real session log —
 *
 *   - the activation handle the `subagent` tool returns, alone or nested in the
 *     object a `run_code` program returns:
 *     `{"a":{"kind":"activation","subagentId":"b0a3a569-…"}}`;
 *   - the plain notice the same tool prints when it runs without PTC:
 *     `started subagent d605390b-66f6-474b-956d-0824ec2103e0`.
 *
 * Nothing else is accepted: a `list_agents` answer that happens to list a child
 * (`[{"kind":"child","id":"…"}]`) carries neither signature, so it can never
 * lend its own call id to a thread it did not spawn.
 * @param data - one durable `tool/result` payload.
 * @returns the child ids the payload names, in the order it names them.
 */
export function spawnedChildIdsOf(data: unknown): string[] {
  const message = isRecord(data) ? data.message : undefined
  const ids: string[] = []
  for (const id of spawnIdsIn(textOfBlocks(isRecord(message) ? message.content : undefined))) {
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

/** The spawn signatures above, as the two patterns that carry a child id. */
const SPAWN_HANDLE_IDS = /"subagentId"\s*:\s*"([^"]+)"/g
const SPAWN_NOTICE_IDS = /started subagent\s+([0-9A-Za-z][0-9A-Za-z_.-]{3,})/g

/** @returns every child id one result's text names through a spawn signature. */
function spawnIdsIn(text: string): string[] {
  const ids: string[] = []
  for (const pattern of [SPAWN_HANDLE_IDS, SPAWN_NOTICE_IDS]) {
    for (const match of text.matchAll(pattern)) {
      const id = match[1]
      if (id !== undefined && id !== '' && !ids.includes(id)) ids.push(id)
    }
  }
  return ids
}

/**
 * The child-to-call evidence one session's records already carry.
 *
 * A spawn's result can be projected after the catalog it belongs to, so a
 * baseline reads the whole record list for this evidence before it resolves any
 * catalog entry: the snapshot is a session that has already happened, and the
 * answer it gives a client must not depend on where in the list it stopped
 * looking. The live subscription feeds the same evidence in as it arrives.
 * @param records - durable follow records, oldest first.
 * @returns every child id a `tool/result` names, with the call that produced it.
 */
export function spawnCallEvidence(records: readonly unknown[]): Map<string, string> {
  const evidence = new Map<string, string>()
  for (const record of records) {
    const event = isRecord(record) ? record.event : undefined
    if (!isRecord(event) || event.type !== 'tool/result') continue
    const callId = toolResultCallIdOf(event.data)
    if (callId === undefined) continue
    for (const childId of spawnedChildIdsOf(event.data)) evidence.set(childId, callId)
  }
  return evidence
}

/** @returns the call id one durable `tool/result` payload belongs to. */
function toolResultCallIdOf(data: unknown): string | undefined {
  const message = isRecord(data) ? data.message : undefined
  const callId = stringField(message, 'toolCallId')
  return callId === undefined || callId === '' ? undefined : callId
}

/**
 * Correlates one `subagent/catalog` event to the tool call that spawned the
 * child it registers.
 *
 * The catalog event names the child but not the call, so the call is read from
 * two places, in this order:
 *
 *   1. the spawn's own `tool/result`, which names the child it started
 *      ({@link spawnedChildIdsOf}). This is the decisive one: it survives a step
 *      that issued several calls, and a step whose one call started a whole team
 *      of children, because the payload says which child it is about.
 *   2. the nearest preceding `tool/call` of the same turn and step, which is
 *      decidable only while one call is the whole story. A step with several
 *      calls leaves two candidates, and a call that already produced a child
 *      leaves one call behind two children; a guessed id would point a thread at
 *      the wrong card.
 *
 * Neither holds: undefined, and the wire carries no call id at all. The same
 * index answers both paths — a subscription as it watches, and a baseline after
 * reading the session's records — so the two can never disagree about which rule
 * decides a given catalog.
 */
export class SpawnCallIndex {
  readonly #named: Map<string, string>
  #turn: number | undefined
  #step: number | undefined
  #calls: string[] = []
  readonly #correlated = new Set<string>()

  /**
   * @param evidence - child-to-call pairs already read from the session's
   * results, for the baseline path; empty for a live subscription.
   */
  constructor(evidence: ReadonlyMap<string, string> = new Map()) {
    this.#named = new Map(evidence)
  }

  /**
   * Read one durable event into the correlation state.
   *
   * A turn boundary or a new step is the only reset: a call belongs to the step
   * that issued it, so a call from an earlier step can never be the nearest
   * preceding one.
   */
  observe(type: string, data: unknown): void {
    if (type === 'turn/start') {
      this.#turn = numberOf(isRecord(data) ? data.turn : undefined)
      this.#step = undefined
      this.#calls = []
      this.#correlated.clear()
      return
    }
    if (type === 'step/start') {
      this.#turn = numberOf(isRecord(data) ? data.turn : undefined) ?? this.#turn
      this.#step = numberOf(isRecord(data) ? data.step : undefined)
      this.#calls = []
      this.#correlated.clear()
      return
    }
    if (type === 'tool/result') {
      const callId = toolResultCallIdOf(data)
      if (callId === undefined) return
      for (const childId of spawnedChildIdsOf(data)) this.#named.set(childId, callId)
      return
    }
    if (type !== 'tool/call') return
    const callId = stringField(data, 'callId')
    if (callId === undefined || callId === '') return
    this.#turn = numberOf(isRecord(data) ? data.turn : undefined) ?? this.#turn
    this.#step = numberOf(isRecord(data) ? data.step : undefined) ?? this.#step
    this.#calls.push(callId)
  }

  /**
   * The call that spawned the child a catalog event registered.
   * @param childId - the child that catalog event carries.
   * @returns its call id, or undefined when nothing on the wire decides it.
   */
  spawnCallId(childId: string): string | undefined {
    const named = this.#named.get(childId)
    if (named !== undefined) {
      this.#correlated.add(named)
      return named
    }
    if (this.#turn === undefined || this.#step === undefined) return undefined
    if (this.#calls.length !== 1) return undefined
    const callId = this.#calls[0]
    if (callId === undefined || this.#correlated.has(callId)) return undefined
    this.#correlated.add(callId)
    return callId
  }
}

/**
 * Read the opening frame of a follow stream.
 * @returns the cursor and records, or undefined when this frame is not a snapshot.
 */
export function readFollowBaseline(frame: unknown): FollowBaseline | undefined {
  if (!isRecord(frame) || frame.type !== 'snapshot') return undefined
  const cursor = frame.cursor
  const records = frame.records
  if (typeof cursor !== 'number' || !Array.isArray(records)) return undefined
  return { cursor, records, hasMore: frame.hasMore === true }
}

/** What one follow stream remembers beyond its two bounded message indexes. */
export interface FollowMemory {
  /** Whether this connection declared `subagent.thread.v1`. */
  readonly subagentThread?: boolean
  /** This stream's spawning-call correlation state; absent when the kind is off. */
  readonly spawnCalls?: SpawnCallIndex
}

/**
 * Map one DSH follow frame to a delta, or undefined when the frame carries no
 * increment this protocol publishes.
 * @param frame - one `SessionFollowFrame`.
 * @param toolCalls - this connection's tool-call memory.
 * @param messages - this connection's published-user-message memory.
 * @param memory - the stream's own correlation state, and which optional kinds it declared.
 */
export function deltaOfFollowFrame(
  frame: unknown,
  toolCalls: ToolCallIndex,
  messages: MessageIndex,
  memory: FollowMemory = {},
): SessionDelta | undefined {
  if (!isRecord(frame)) return undefined
  if (frame.type === 'assistant-stream') return deltaOfAssistantStream(frame.frame, toolCalls)
  if (frame.type !== 'event') return undefined
  const event = frame.event
  if (!isRecord(event)) return undefined
  const type = event.type
  const data = event.data
  // Observed before dispatch: a turn boundary, a new step and every call update
  // the correlation state whether or not this contract publishes a delta for it.
  memory.spawnCalls?.observe(typeof type === 'string' ? type : '', data)
  if (type === 'tool/result') return toolResultDelta(data)
  if (type === 'turn/end') return turnEndDelta(data)
  if (type === 'tool/call') return assembledToolCallDelta(data, toolCalls)
  if (type === 'user/message') return userMessageDelta(data, messages)
  if (type === 'assistant/message') return usageDelta(data)
  if (type === 'subagent/catalog') return memory.subagentThread === true ? subagentDelta(data, memory.spawnCalls) : undefined
  return undefined
}

/**
 * Map one durable `subagent/catalog` to the increment that opens a thread on a
 * subscribed phone.
 *
 * The child id is the only field the host must have written: without it the
 * event registers nothing this protocol can address, so it publishes nothing
 * rather than an increment a client could not use.
 */
function subagentDelta(data: unknown, spawnCalls: SpawnCallIndex | undefined): SessionDelta | undefined {
  const childId = stringField(data, 'childId')
  if (childId === undefined || childId === '') return undefined
  const label = textField(data, 'label')
  const mode = textField(data, 'mode')
  const callId = spawnCalls?.spawnCallId(childId)
  return {
    kind: 'subagent',
    childId,
    ...(label === undefined ? {} : { label }),
    ...(mode === undefined ? {} : { mode }),
    ...(callId === undefined ? {} : { callId }),
  }
}

/**
 * Where one durable user message came from.
 *
 * Absent when the event carries no readable `source.kind`: an event from a log
 * written before sources existed has no source kind, and inventing one would
 * report an origin the host never recorded.
 */
function actorOf(data: unknown): MessageActor | undefined {
  return actorOfSource(isRecord(data) ? data.source : undefined)
}

/**
 * Derive one message's actor from the host's own `source` record, mechanically.
 * @param source - the `source` member of a durable `user/message`.
 * @returns the actor, or undefined when the source carries no kind.
 */
export function actorOfSource(source: unknown): MessageActor | undefined {
  const sourceKind = stringField(source, 'kind')
  if (sourceKind === undefined || sourceKind === '') return undefined
  const sessionId = stringField(source, 'senderSessionId')
  const label = textField(source, 'label')
  const named = {
    sourceKind,
    ...(label === undefined ? {} : { label }),
    ...(sessionId === undefined || sessionId === '' ? {} : { sessionId }),
  }
  if (sourceKind === 'user' || sourceKind === 'user-approval') return { kind: 'human', ...named }
  if (sourceKind === 'agent-message' || sourceKind === 'subagent-settled') return { kind: 'agent', ...named }
  return { kind: 'system', ...named }
}

/** @returns a non-empty string field, or undefined. */
function textField(value: unknown, key: string): string | undefined {
  const field = stringField(value, key)
  return field === undefined || field === '' ? undefined : field
}

function deltaOfAssistantStream(frame: unknown, toolCalls: ToolCallIndex): SessionDelta | undefined {
  if (!isRecord(frame) || frame.type !== 'chunk') return undefined
  const chunk = frame.chunk
  if (!isRecord(chunk)) return undefined
  const index = typeof chunk.index === 'number' ? chunk.index : 0
  if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
    return { kind: 'text', text: chunk.text, blockIndex: index }
  }
  if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
    return { kind: 'reasoning', text: chunk.text, blockIndex: index }
  }
  if (chunk.type === 'tool-call-delta' && typeof chunk.id === 'string' && chunk.id !== '') {
    const callId = chunk.id
    const announced = typeof chunk.name === 'string' && chunk.name !== '' ? chunk.name : undefined
    const name = announced ?? toolCalls.nameOf(callId) ?? ''
    toolCalls.remember(callId, name)
    return { kind: 'tool-call', callId, name, argumentsDelta: typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : '' }
  }
  return undefined
}

function toolResultDelta(data: unknown): SessionDelta | undefined {
  const message = isRecord(data) ? data.message : undefined
  if (!isRecord(message)) return undefined
  const callId = message.toolCallId
  if (typeof callId !== 'string' || callId === '') return undefined
  return { kind: 'tool-result', callId, output: textOfBlocks(message.content), isError: message.isError === true }
}

function turnEndDelta(data: unknown): SessionDelta | undefined {
  const reason = isRecord(data) ? data.reason : undefined
  const kind = isRecord(reason) ? reason.kind : undefined
  // An unreadable reason is reported as such: the client treats every non-
  // `completed` value as an abnormal end, and `unknown` is the truth here.
  return { kind: 'turn-end', reason: typeof kind === 'string' ? kind : 'unknown' }
}

/**
 * The durable `tool/call` event carries the WHOLE argument string, not an
 * increment, so it is published as a delta only when the connection never saw
 * this call's increments — otherwise the client would append the arguments a
 * second time.
 */
function assembledToolCallDelta(data: unknown, toolCalls: ToolCallIndex): SessionDelta | undefined {
  const callId = stringField(data, 'callId')
  if (callId === undefined || callId === '') return undefined
  if (toolCalls.has(callId)) return undefined
  const name = stringField(data, 'name') ?? ''
  toolCalls.remember(callId, name)
  return { kind: 'tool-call', callId, name, argumentsDelta: stringField(data, 'arguments') ?? '' }
}

/** Flatten a message's model-facing blocks to display text; non-text blocks are dropped. */
function textOfBlocks(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Map one durable `user/message` to the increment that shows it on a subscribed
 * phone, so a prompt typed on the desktop appears without a baseline reload.
 *
 * Published once per message id: a replayed event must not draw the message a
 * second time. The text is the message's text blocks and nothing else — image
 * and file blocks travel in `attachments`, never inside it.
 */
function userMessageDelta(data: unknown, messages: MessageIndex): SessionDelta | undefined {
  if (!isRecord(data)) return undefined
  const messageId = stringField(data, 'id')
  if (messageId !== undefined) {
    if (messages.has(messageId)) return undefined
    messages.remember(messageId)
  }
  const attachments = imageAttachmentsOf(data.content)
  const actor = actorOf(data)
  return {
    kind: 'user-message',
    text: textOfBlocks(data.content),
    ...(messageId === undefined ? {} : { messageId }),
    ...(attachments.length === 0 ? {} : { attachments }),
    ...(actor === undefined ? {} : { actor }),
  }
}

/**
 * The image references of one message's blocks, in content order.
 *
 * A durable image block nests its immutable reference under the block's own
 * `attachment` key, so the id and media type are read from the reference — the
 * block itself carries only its type and, once offloaded, that flag.
 */
function imageAttachmentsOf(content: unknown): UserMessageAttachment[] {
  if (!Array.isArray(content)) return []
  const attachments: UserMessageAttachment[] = []
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'image') continue
    const ref = block.attachment
    if (!isRecord(ref)) continue
    const attachmentId = stringField(ref, 'attachmentId')
    const mediaType = stringField(ref, 'mediaType')
    if (attachmentId === undefined || mediaType === undefined) continue
    const name = stringField(ref, 'name')
    attachments.push({ attachmentId, mediaType, ...(name === undefined || name === '' ? {} : { name }) })
  }
  return attachments
}

/**
 * Map one finished `assistant/message` to its usage increment, or to nothing.
 *
 * An event without `usage` publishes NO delta: absent is not zero, and a client
 * must never record a token count the harness did not report.
 */
function usageDelta(data: unknown): SessionDelta | undefined {
  if (!isRecord(data)) return undefined
  const usage = usageOf(data.usage)
  if (usage === undefined) return undefined
  const turn = numberOf(data.turn)
  const step = numberOf(data.step)
  return { kind: 'usage', usage, ...(turn === undefined ? {} : { turn }), ...(step === undefined ? {} : { step }) }
}

/** Read one `TokenUsage` verbatim; undefined when its two mandatory counters are not numbers. */
function usageOf(value: unknown): MessageUsage | undefined {
  if (!isRecord(value)) return undefined
  const inputTokens = numberOf(value.inputTokens)
  const outputTokens = numberOf(value.outputTokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const totalTokens = numberOf(value.totalTokens)
  const cacheReadTokens = numberOf(value.cacheReadTokens)
  const cacheWriteTokens = numberOf(value.cacheWriteTokens)
  const reasoningTokens = numberOf(value.reasoningTokens)
  return {
    inputTokens,
    outputTokens,
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  }
}

/** @returns a finite number field, or undefined. */
function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Project a follow baseline's records into turns.
 *
 * A `subagent/catalog` entry leaves here carrying the call that spawned its
 * child in `data.callId`, decided by the same {@link SpawnCallIndex} a live
 * subscription uses — so the baseline half and the live half of the thread
 * cannot answer differently about one catalog.
 * @param records - the baseline's durable records, oldest first.
 * @returns one turn per `turn/start`, plus a lead-in turn when records precede the first one.
 */
export function turnsOfRecords(records: readonly unknown[]): SnapshotTurn[] {
  const turns: SnapshotTurn[] = []
  // The spawn evidence is read from the whole list first: a spawn's result is
  // projected after the catalog it belongs to, and a baseline that gave up at
  // the catalog would lose the one record that names the call.
  const spawns = new SpawnCallIndex(spawnCallEvidence(records))
  let current: { seq: number; time: number; endSeq: number; endTime: number; reason: string; entries: SnapshotEntry[] } | undefined
  for (const record of records) {
    const projected = snapshotEntryOf(record)
    if (projected === undefined) continue
    spawns.observe(projected.type, projected.data)
    const entry = projected.type === 'subagent/catalog' ? catalogEntryWithCall(projected, spawns) : projected
    if (entry.type === 'turn/start' && current !== undefined && current.endSeq === 0) {
      // A previous turn never ended (an aborted resume): its tail stays with it.
      turns.push(current)
      current = undefined
    }
    if (current === undefined) {
      current = { seq: entry.type === 'turn/start' ? entry.seq : 0, time: entry.time, endSeq: 0, endTime: 0, reason: '', entries: [] }
    }
    current.entries.push(entry)
    if (entry.type === 'turn/end') {
      current.endSeq = entry.seq
      current.endTime = entry.time
      current.reason = isRecord(entry.data) && isRecord(entry.data.reason) && typeof entry.data.reason.kind === 'string'
        ? entry.data.reason.kind
        : 'unknown'
      turns.push(current)
      current = undefined
    }
  }
  if (current !== undefined && current.entries.length > 0) turns.push(current)
  return turns
}

/**
 * One `subagent/catalog` entry with the call that spawned its child, when the
 * session decides it.
 *
 * Nothing else about the entry moves: the durable payload is copied as it
 * arrived and `callId` is added beside it, exactly as the live `subagent`
 * delta carries the same field under §13.3. A catalog whose spawning call is
 * undecidable is passed through untouched rather than guessed at.
 * @param entry - one projected catalog entry.
 * @param spawns - the index holding this session's spawn evidence.
 */
function catalogEntryWithCall(entry: SnapshotEntry, spawns: SpawnCallIndex): SnapshotEntry {
  if (!isRecord(entry.data)) return entry
  const childId = stringField(entry.data, 'childId')
  if (childId === undefined || childId === '') return entry
  const callId = spawns.spawnCallId(childId)
  if (callId === undefined) return entry
  return { ...entry, data: { ...entry.data, callId } }
}

/**
 * Drop the entries of each turn that a protocol v1 client would not render.
 *
 * Only the inside of a turn changes: which turns survive, their order, their
 * `seq`/`endSeq` metadata and every kept entry's `type` and `data` are the
 * projection's own output. A turn whose entries are all unrenderable stays as a
 * turn with an empty `entries` array, so the client never sees a shape it does
 * not know how to read.
 * @param turns - the projection of a follow baseline, in order.
 * @returns the same turns, each carrying only its rendered entries.
 */
export function trimUnrenderedEntries(turns: readonly SnapshotTurn[]): SnapshotTurn[] {
  return turns.map(turn => {
    const entries = turn.entries.filter(entry => RENDERED_ENTRY_TYPES.has(entry.type))
    return entries.length === turn.entries.length ? turn : { ...turn, entries }
  })
}

/** One contiguous backwards page of a snapshot projection. */
export interface SnapshotPage {
  /** The turns this page carries, oldest first; each keeps its own turn-level fields. */
  readonly turns: SnapshotTurn[]
  /** Durable seq of this page's oldest entry: the cursor for the next, older page. */
  readonly nextBefore?: number
  readonly hasMore: boolean
}

/**
 * Slice one backwards page out of a projection, BY ENTRY rather than by turn.
 *
 * `before` is a durable watermark, not an index: the page carries the newest
 * entries whose `seq` is strictly below it, so a cursor stays meaningful across
 * connections and a projection that changed shape under it (a trimmed entry
 * that never reaches the client) cannot make a page skip or repeat data. The
 * turn list is rebuilt around exactly the entries in the page, each turn
 * keeping its own `seq`/`endSeq`/`reason`, so a turn may be split across pages.
 *
 * A single entry that exceeds the budget on its own is a page of its own: the
 * size rule never removes an entry, it only ends the page.
 * @param turns - the projection to page, in order.
 * @param before - exclusive durable watermark, or undefined for the newest page.
 * @param maxBytes - byte budget of the encoded page.
 * @param measure - exact encoded size of one page shape, owned by the caller.
 */
export function pageTurns(
  turns: readonly SnapshotTurn[],
  before: number | undefined,
  maxBytes: number,
  measure: (turns: readonly SnapshotTurn[], nextBefore: number | undefined, hasMore: boolean) => number,
): SnapshotPage {
  const flat: { readonly turn: SnapshotTurn; readonly entry: SnapshotEntry }[] = []
  for (const turn of turns) {
    for (const entry of turn.entries) {
      if (before === undefined || entry.seq < before) flat.push({ turn, entry })
    }
  }
  if (flat.length === 0) return { turns: [], hasMore: false }

  const shells = new Map<SnapshotTurn, number>()
  for (const item of flat) {
    if (!shells.has(item.turn)) shells.set(item.turn, Buffer.byteLength(JSON.stringify({ ...item.turn, entries: [] }), 'utf8'))
  }
  // Greedy from the newest entry on a conservative running estimate — every
  // entry and every contributing turn shell counted once — and then verified
  // against the real encoding, shrinking from the oldest side until it fits.
  let start = flat.length
  let estimate = 0
  const counted = new Set<SnapshotTurn>()
  for (let index = flat.length - 1; index >= 0; index -= 1) {
    const item = flat[index]
    if (item === undefined) break
    let cost = Buffer.byteLength(JSON.stringify(item.entry), 'utf8') + 1
    if (!counted.has(item.turn)) {
      counted.add(item.turn)
      cost += shells.get(item.turn) ?? 0
    }
    if (start < flat.length && estimate + cost > maxBytes) break
    estimate += cost
    start = index
  }
  for (;;) {
    const oldest = flat[start]?.entry.seq
    if (oldest === undefined) return { turns: [], hasMore: false }
    const page = groupEntries(flat.slice(start))
    const hasMore = start > 0
    if (flat.length - start === 1 || measure(page, hasMore ? oldest : undefined, hasMore) <= maxBytes) {
      return hasMore ? { turns: page, nextBefore: oldest, hasMore } : { turns: page, hasMore }
    }
    start += 1
  }
}

/**
 * Durable seq of a projection's oldest entry, or undefined when it carries none.
 *
 * The oldest entry is the first entry of the first turn that has one: a trimmed
 * turn may keep no entry at all, so the scan skips those rather than reading
 * `turns[0].entries[0]` and calling an empty-leading view an empty window.
 * @param turns - the projection to read, in order.
 */
export function oldestEntrySeq(turns: readonly SnapshotTurn[]): number | undefined {
  for (const turn of turns) {
    const first = turn.entries[0]
    if (first !== undefined) return first.seq
  }
  return undefined
}

/**
 * Cut a projection at a durable watermark, keeping what is strictly above it.
 *
 * This is the forward twin of {@link pageTurns}' own slice: the same
 * entry-level rule (`seq` is a durable watermark, not an index), the same
 * turn rebuild, so an incremental snapshot carries turns shaped exactly like
 * the baseline it continues — a turn whose remaining entries are fewer keeps
 * its own `seq`, `endSeq`, `reason` and `time`.
 * @param turns - the projection to cut, in order.
 * @param watermark - exclusive durable watermark; entries at or below it are dropped.
 */
export function turnsAbove(turns: readonly SnapshotTurn[], watermark: number): SnapshotTurn[] {
  const kept: { readonly turn: SnapshotTurn; readonly entry: SnapshotEntry }[] = []
  for (const turn of turns) {
    for (const entry of turn.entries) {
      if (entry.seq > watermark) kept.push({ turn, entry })
    }
  }
  return groupEntries(kept)
}

/** Rebuild the turn list around one contiguous run of entries. */
function groupEntries(items: readonly { readonly turn: SnapshotTurn; readonly entry: SnapshotEntry }[]): SnapshotTurn[] {
  const page: SnapshotTurn[] = []
  let current: SnapshotTurn | undefined
  let entries: SnapshotEntry[] = []
  for (const item of items) {
    if (current !== item.turn) {
      if (current !== undefined) page.push({ ...current, entries })
      current = item.turn
      entries = []
    }
    entries.push(item.entry)
  }
  if (current !== undefined) page.push({ ...current, entries })
  return page
}

function snapshotEntryOf(record: unknown): SnapshotEntry | undefined {
  const event = isRecord(record) ? record.event : undefined
  if (!isRecord(event)) return undefined
  if (typeof event.type !== 'string' || typeof event.seq !== 'number') return undefined
  // A user message is the one entry that carries its actor: the delta and the
  // baseline must report the same origin for the same message, and the entry's
  // data stays the host's own record so a client written before actors existed
  // still reads it unchanged.
  const actor = event.type === 'user/message' ? actorOf(event.data) : undefined
  return {
    seq: event.seq,
    time: typeof event.time === 'number' ? event.time : 0,
    type: event.type,
    data: event.data,
    ...(actor === undefined ? {} : { actor }),
  }
}
