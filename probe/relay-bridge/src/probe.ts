/**
 * Non-production probe: a Durable Object meeting point behind a stateless Worker.
 *
 * The Worker stays at the door. It validates the connector ticket, then hands the
 * request to the object named by `PROBE_INSTANCE` and never looks inside again.
 * The object holds one connector socket (the plugin side) and pipes every other
 * request -- plain HTTP, request and response bodies, WebSocket upgrades -- to it.
 *
 * Frame contract, one socket, multiplexed by stream id:
 *   control frames are JSON text  {t, id, ...}
 *   payload frames are binary     [kind:u8][streamId:u32be][payload]
 *   kinds: 1 HTTP body chunk, 2 WebSocket binary, 3 WebSocket text (UTF-8)
 *
 * This file is the whole Worker. It is a measurement instrument, not a design.
 */

interface Env {
  BRIDGE: DurableObjectNamespace;
  PROBE_INSTANCE: string;
  CONNECTOR_TICKET: string;
}

const HTTP_BODY = 1;
const WS_BINARY = 2;
const WS_TEXT = 3;

/** Response headers a streaming Response may not carry, or that the connector's
 * own transport already spoke. */
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

const NO_STORE = {
  "content-type": "text/plain; charset=utf-8",
  "cache-control": "no-store",
};

/** How long a downstream request waits for the connector's response head. */
const HEAD_TIMEOUT_MS = 60_000;
/** How long a downstream WebSocket waits for the connector to accept it. */
const WS_OPEN_TIMEOUT_MS = 15_000;

function encodeChunk(kind: number, id: number, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(5 + payload.byteLength);
  bytes[0] = kind;
  new DataView(bytes.buffer).setUint32(1, id >>> 0);
  bytes.set(payload, 5);
  return bytes;
}

/**
 * A binary WebSocket message arrives as an ArrayBuffer at the edge, as a view in
 * some runtimes, and as a Blob in the local one; the Blob case is why every
 * reader is async.
 */
async function readIncoming(data: unknown): Promise<string | Uint8Array | null> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof Blob !== "undefined" && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return null;
}

function decodeChunk(bytes: Uint8Array): { kind: number; id: number; payload: Uint8Array } {
  return { kind: bytes[0], id: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1), payload: bytes.subarray(5) };
}

/**
 * One serial queue per socket. A Blob read is async, and handing a byte stream
 * to its consumer out of order corrupts it, so frames are chained rather than
 * fired concurrently.
 */
class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  push(task: () => Promise<void>): void {
    this.tail = this.tail.then(task).catch((error: unknown) => {
      console.log(JSON.stringify({ probe: "frame-error", message: String(error) }));
    });
  }
}

/** Length-checked, accumulation-free comparison: a ticket probe must not leak its
 * answer through timing. */
function ticketMatches(presented: string, expected: string): boolean {
  if (expected === "" || presented.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < presented.length; index += 1) {
    diff |= presented.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return diff === 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ResponseHead =
  | { ok: true; status: number; statusText: string; headers: Headers }
  | { ok: false; message: string };

interface HttpStream {
  head: (value: ResponseHead) => void;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  chunks: number;
  bytes: number;
}

export class RelayBridge {
  private connector: WebSocket | null = null;
  private nextId = 1;
  private readonly http = new Map<number, HttpStream>();
  private readonly sockets = new Map<number, { socket: WebSocket; queue: SerialQueue }>();
  private readonly connectorQueue = new SerialQueue();
  private readonly verdicts = new Map<number, (ok: boolean) => void>();

  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/connector") return await this.acceptConnector();
    const upgrade = (request.headers.get("upgrade") ?? "").toLowerCase();
    if (upgrade === "websocket") return await this.bridgeWebSocket(request);
    return await this.bridgeHttp(request);
  }

  /**
   * Attach the one connector socket. The ticket was already checked by the
   * Worker; spending it here is what makes it one-time -- a replay after this
   * point is refused even if the same string leaks.
   */
  private async acceptConnector(): Promise<Response> {
    const spent = await this.state.storage.get<boolean>("ticketSpent");
    if (spent === true) {
      return new Response("connector ticket already spent", { status: 409, headers: NO_STORE });
    }
    await this.state.storage.put("ticketSpent", true);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    const previous = this.connector;
    this.connector = server;
    if (previous !== null) {
      try {
        previous.close(1000, "replaced");
      } catch {
        // A socket the runtime already dropped is the expected case on reconnect.
      }
    }
    server.addEventListener("message", (event) => {
      const data = event.data;
      this.connectorQueue.push(async () => {
        await this.onConnectorMessage(data);
      });
    });
    server.addEventListener("close", () => {
      if (this.connector === server) this.connector = null;
      this.failAll("connector closed");
    });
    console.log(JSON.stringify({ probe: "connector-attached", instance: this.state.id.toString() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private async bridgeHttp(request: Request): Promise<Response> {
    const connector = this.connector;
    if (connector === null) {
      return new Response("no-connector", { status: 409, headers: NO_STORE });
    }
    const url = new URL(request.url);
    const id = this.nextId++;
    let settleHead: (value: ResponseHead) => void = () => {};
    const headPromise = new Promise<ResponseHead>((resolve) => {
      settleHead = resolve;
    });
    const entry: HttpStream = { head: settleHead, controller: null, chunks: 0, bytes: 0 };
    this.http.set(id, entry);

    connector.send(
      JSON.stringify({
        t: "req",
        id,
        method: request.method,
        url: url.pathname + url.search,
        headers: [...request.headers],
      }),
    );
    if (request.body === null) {
      connector.send(JSON.stringify({ t: "end", id }));
    } else {
      void this.pumpRequestBody(request.body, connector, id);
    }

    const timedOut = Symbol("timeout");
    const settled = await Promise.race([headPromise, sleep(HEAD_TIMEOUT_MS).then(() => timedOut)]);
    if (settled === timedOut) {
      this.http.delete(id);
      return new Response("connector timed out on the response head", { status: 504, headers: NO_STORE });
    }
    const result = settled as ResponseHead;
    if (!result.ok) {
      this.http.delete(id);
      return new Response(`connector failed: ${result.message}`, { status: 502, headers: NO_STORE });
    }
    // 204 and 304 may not carry a body at all, so no stream, no controller.
    if (result.status === 204 || result.status === 304) {
      this.http.delete(id);
      return new Response(null, { status: result.status, statusText: result.statusText });
    }
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        entry.controller = controller;
      },
      cancel: () => {
        this.http.delete(id);
        connector.send(JSON.stringify({ t: "close", id, reason: "client-cancelled" }));
      },
    });
    return new Response(stream, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  }

  /** Request body chunks become frames as they arrive, so an upload streams too. */
  private async pumpRequestBody(body: ReadableStream<Uint8Array>, connector: WebSocket, id: number): Promise<void> {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) connector.send(encodeChunk(HTTP_BODY, id, value));
      }
      connector.send(JSON.stringify({ t: "end", id }));
    } catch (error) {
      connector.send(JSON.stringify({ t: "close", id, reason: `upload: ${String(error)}` }));
    }
  }

  private async bridgeWebSocket(request: Request): Promise<Response> {
    const connector = this.connector;
    if (connector === null) {
      return new Response("no-connector", { status: 409, headers: NO_STORE });
    }
    const url = new URL(request.url);
    const id = this.nextId++;
    const verdict = new Promise<boolean>((resolve) => {
      this.verdicts.set(id, resolve);
    });
    connector.send(
      JSON.stringify({
        t: "ws-open",
        id,
        url: url.pathname + url.search,
        headers: [...request.headers],
      }),
    );
    const accepted = await Promise.race([verdict, sleep(WS_OPEN_TIMEOUT_MS).then(() => false)]);
    this.verdicts.delete(id);
    console.log(JSON.stringify({ probe: "ws-verdict", id, accepted }));
    if (!accepted) {
      return new Response("connector refused the upgrade", { status: 502, headers: NO_STORE });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    const queue = new SerialQueue();
    this.sockets.set(id, { socket: server, queue });
    server.addEventListener("message", (event) => {
      const data = event.data;
      queue.push(async () => {
        const bytes = await readIncoming(data);
        if (bytes === null) return;
        if (typeof bytes === "string") {
          connector.send(encodeChunk(WS_TEXT, id, new TextEncoder().encode(bytes)));
          return;
        }
        connector.send(encodeChunk(WS_BINARY, id, bytes));
      });
    });
    server.addEventListener("close", () => {
      this.sockets.delete(id);
      try {
        connector.send(JSON.stringify({ t: "close", id, reason: "downstream-closed" }));
      } catch {
        // The connector is gone; the object is about to fail everything anyway.
      }
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  private async onConnectorMessage(data: unknown): Promise<void> {
    const raw = await readIncoming(data);
    if (raw === null) return;
    if (typeof raw === "string") {
      this.onControl(raw);
      return;
    }
    const { kind, id, payload } = decodeChunk(raw);
    if (kind === HTTP_BODY) {
      const entry = this.http.get(id);
      if (entry === undefined || entry.controller === null) return;
      entry.chunks += 1;
      entry.bytes += payload.byteLength;
      entry.controller.enqueue(payload);
      return;
    }
    const peer = this.sockets.get(id);
    if (peer === undefined) return;
    if (kind === WS_TEXT) peer.socket.send(new TextDecoder().decode(payload));
    else peer.socket.send(payload);
  }

  private onControl(raw: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      console.log(JSON.stringify({ probe: "unparsable-control", bytes: raw.length }));
      return;
    }
    const id = typeof frame.id === "number" ? frame.id : -1;
    switch (frame.t) {
      case "res": {
        const entry = this.http.get(id);
        if (entry === undefined) return;
        entry.head({
          ok: true,
          status: typeof frame.status === "number" ? frame.status : 502,
          statusText: typeof frame.statusText === "string" ? frame.statusText : "",
          headers: responseHeaders(frame.headers),
        });
        return;
      }
      case "fin": {
        const entry = this.http.get(id);
        if (entry === undefined) return;
        console.log(JSON.stringify({ probe: "http-done", id, chunks: entry.chunks, bytes: entry.bytes }));
        this.http.delete(id);
        if (entry.controller !== null) {
          try {
            entry.controller.close();
          } catch {
            // Already closed by a cancel from the other side.
          }
        }
        return;
      }
      case "fail": {
        const entry = this.http.get(id);
        if (entry !== undefined) {
          this.http.delete(id);
          entry.head({ ok: false, message: String(frame.message ?? "unknown") });
          if (entry.controller !== null) entry.controller.error(new Error(String(frame.message ?? "connector-failed")));
          return;
        }
        this.verdicts.get(id)?.(false);
        return;
      }
      case "ws-accept":
        this.verdicts.get(id)?.(true);
        return;
      case "ws-fail":
        console.log(JSON.stringify({ probe: "ws-refused", id, message: String(frame.message ?? "unknown") }));
        this.verdicts.get(id)?.(false);
        return;
      case "ws-close": {
        const peer = this.sockets.get(id);
        if (peer === undefined) return;
        this.sockets.delete(id);
        try {
          peer.socket.close(typeof frame.code === "number" ? frame.code : 1000, String(frame.reason ?? ""));
        } catch {
          // The phone side already went away.
        }
        return;
      }
      case "close": {
        const peer = this.sockets.get(id);
        if (peer !== undefined) {
          this.sockets.delete(id);
          try {
            peer.socket.close(1000, String(frame.reason ?? "connector-cancelled"));
          } catch {
            // Same as above.
          }
          return;
        }
        this.http.delete(id);
        return;
      }
      default:
        console.log(JSON.stringify({ probe: "unknown-control", t: String(frame.t) }));
    }
  }

  /** A connector that goes away leaves no half-open streams behind. */
  private failAll(reason: string): void {
    console.log(JSON.stringify({ probe: "fail-all", reason, http: this.http.size, ws: this.sockets.size }));
    for (const [id, entry] of this.http) {
      entry.head({ ok: false, message: reason });
      if (entry.controller !== null) entry.controller.error(new Error(reason));
      this.http.delete(id);
    }
    for (const [id, peer] of this.sockets) {
      this.sockets.delete(id);
      try {
        peer.socket.close(1011, reason);
      } catch {
        // Nothing left to close it with.
      }
    }
    for (const [id, verdict] of this.verdicts) {
      this.verdicts.delete(id);
      verdict(false);
    }
  }
}

function responseHeaders(raw: unknown): Headers {
  const headers = new Headers();
  if (!Array.isArray(raw)) return headers;
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [name, value] = entry;
    if (typeof name !== "string" || typeof value !== "string") continue;
    if (DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    headers.append(name, value);
  }
  return headers;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/connector") {
      if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
        return new Response("upgrade required", { status: 426, headers: NO_STORE });
      }
      if (url.searchParams.get("instance") !== env.PROBE_INSTANCE) {
        return new Response("unknown instance", { status: 404, headers: NO_STORE });
      }
      const presented = url.searchParams.get("ticket") ?? request.headers.get("x-probe-ticket") ?? "";
      if (!ticketMatches(presented, env.CONNECTOR_TICKET)) {
        return new Response("ticket refused", { status: 403, headers: NO_STORE });
      }
      return await env.BRIDGE.get(env.BRIDGE.idFromName(env.PROBE_INSTANCE)).fetch(request);
    }
    return await env.BRIDGE.get(env.BRIDGE.idFromName(env.PROBE_INSTANCE)).fetch(request);
  },
};
