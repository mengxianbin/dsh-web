#!/usr/bin/env node
/**
 * Local connector for the relay-bridge probe: a minimal cloudflared stand-in.
 *
 * It dials the probe Worker over WSS, and for every stream the Durable Object
 * asks for it speaks the upstream protocol to the host in `PROBE_UPSTREAM` --
 * plain HTTP, or a real WebSocket for the phone's `/ios/v1`.
 *
 * The one deviation from a tunnel is `/_probe/stream`: the connector answers it
 * itself with timed chunks, because the only streaming route the DSH host serves
 * to a relay client is a WebSocket and the HTTP path needs its own read.
 *
 * Frame contract mirrors src/probe.ts.
 */

import http from 'node:http';
import { randomBytes } from 'node:crypto';

const WORKER_URL = process.env.PROBE_WORKER ?? '';
const TICKET = process.env.PROBE_TICKET ?? '';
const INSTANCE = process.env.PROBE_INSTANCE ?? 'shadow-1';
const UPSTREAM = process.env.PROBE_UPSTREAM ?? 'http://127.0.0.1:55220';
const STREAM_CHUNKS = Number(process.env.PROBE_STREAM_CHUNKS ?? '5');
const STREAM_INTERVAL_MS = Number(process.env.PROBE_STREAM_INTERVAL ?? '120');

if (WORKER_URL === '' || TICKET === '') {
  console.error('PROBE_WORKER and PROBE_TICKET are required');
  process.exit(2);
}

const upstream = new URL(UPSTREAM);
/** The host sees the origin hostname, exactly as cloudflared sets it by default. */
const UPSTREAM_HOST = upstream.host;

const HTTP_BODY = 1;
const WS_BINARY = 2;
const WS_TEXT = 3;

const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-accept',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-visitor',
  'cf-ray',
  'cf-ipcity',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-real-ip',
]);

const log = (event, fields = {}) => {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + '\n');
};

// --- frame codec ------------------------------------------------------------

function encodeChunk(kind, id, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const out = Buffer.alloc(5 + body.length);
  out[0] = kind;
  out.writeUInt32BE(id >>> 0, 1);
  body.copy(out, 5);
  return out;
}

function decodeChunk(buffer) {
  const bytes = Buffer.from(buffer);
  if (bytes.length < 5) return null;
  return { kind: bytes[0], id: bytes.readUInt32BE(1), payload: bytes.subarray(5) };
}

function encodeWsFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const length = body.length;
  let head;
  if (length < 126) {
    head = Buffer.alloc(6);
    head[1] = 0x80 | length;
  } else if (length < 65536) {
    head = Buffer.alloc(8);
    head[1] = 0x80 | 126;
    head.writeUInt16BE(length, 2);
  } else {
    head = Buffer.alloc(14);
    head[1] = 0x80 | 127;
    head.writeUInt32BE(0, 2);
    head.writeUInt32BE(length, 6);
  }
  head[0] = 0x80 | opcode;
  const mask = randomBytes(4);
  mask.copy(head, head.length - 4);
  const out = Buffer.alloc(head.length + length);
  head.copy(out, 0);
  const start = head.length;
  for (let index = 0; index < length; index += 1) {
    out[start + index] = body[index] ^ mask[index % 4];
  }
  return out;
}

/** A WebSocket frame reader for the connector's own client side. */
function createFrameParser(onFrame) {
  let buffer = Buffer.alloc(0);
  let continuation = null;
  let continuationOpcode = 0x1;
  return (incoming) => {
    buffer = buffer.length === 0 ? incoming : Buffer.concat([buffer, incoming]);
    for (;;) {
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskAt = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      let payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (masked) {
        const mask = buffer.subarray(maskAt, maskAt + 4);
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x0) {
        continuation = continuation === null ? payload : Buffer.concat([continuation, payload]);
        if (!fin) continue;
        onFrame({ opcode: continuationOpcode, payload: continuation, fin: true });
        continuation = null;
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (!fin) {
          continuation = payload;
          continuationOpcode = opcode;
          continue;
        }
        onFrame({ opcode, payload, fin });
        continue;
      }
      onFrame({ opcode, payload, fin });
    }
  };
}

// --- connector -------------------------------------------------------------

const requests = new Map();
const peers = new Map();

function headerPairs(raw) {
  const pairs = [];
  if (!Array.isArray(raw)) return pairs;
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [name, value] = entry;
    if (typeof name !== 'string' || typeof value !== 'string') continue;
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    pairs.push([name, value]);
  }
  return pairs;
}

function toNodeHeaders(pairs) {
  const headers = {};
  for (const [name, value] of pairs) {
    headers[name] = value;
  }
  return headers;
}

/**
 * The Host the client presented. It is carried through unchanged, never rewritten
 * to the loopback name: the host's local control plane (`/remote-bridge/pair/token`,
 * `/api/pair/*`) is gated on socket address AND loopback Host, so a connector
 * that rewrites Host publishes that control plane on the public origin. The
 * production relay fails that gate for the same reason -- it rewrites Host to the
 * tunnel hostname.
 */
function presentedHost(raw) {
  if (!Array.isArray(raw)) return UPSTREAM_HOST;
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    if (String(entry[0]).toLowerCase() === 'host') return String(entry[1]);
  }
  return UPSTREAM_HOST;
}

function flattenRawHeaders(raw) {
  const pairs = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    pairs.push([raw[index], raw[index + 1]]);
  }
  return pairs;
}

function startHttp(id, method, path, raw) {
  const headers = toNodeHeaders(headerPairs(raw));
  headers.host = presentedHost(raw);
  log('forward', { id, method, path, host: headers.host });
  const req = http.request(
    { host: upstream.hostname, port: upstream.port, path, method, headers },
    (res) => {
      requests.delete(id);
      send(JSON.stringify({ t: 'res', id, status: res.statusCode, statusText: res.statusMessage ?? '', headers: flattenRawHeaders(res.rawHeaders) }));
      res.on('data', (chunk) => send(encodeChunk(HTTP_BODY, id, chunk)));
      res.on('end', () => send(JSON.stringify({ t: 'fin', id })));
      res.on('error', (error) => send(JSON.stringify({ t: 'fail', id, message: String(error?.message ?? error) })));
    },
  );
  req.on('error', (error) => {
    requests.delete(id);
    send(JSON.stringify({ t: 'fail', id, message: String(error?.message ?? error) }));
  });
  requests.set(id, req);
}

/** The probe's own streaming read: five chunks, one every 120 ms by default. */
function serveStreamProbe(id) {
  send(JSON.stringify({ t: 'res', id, status: 200, statusText: 'OK', headers: [['content-type', 'text/plain; charset=utf-8'], ['cache-control', 'no-store']] }));
  let sent = 0;
  const timer = setInterval(() => {
    sent += 1;
    send(encodeChunk(HTTP_BODY, id, Buffer.from(`chunk-${sent} ${Date.now()}\n`)));
    if (sent < STREAM_CHUNKS) return;
    clearInterval(timer);
    send(JSON.stringify({ t: 'fin', id }));
  }, STREAM_INTERVAL_MS);
}

function dialUpstreamSocket(path, raw) {
  return new Promise((resolve, reject) => {
    const headers = toNodeHeaders(headerPairs(raw));
    headers.host = presentedHost(raw);
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
    headers['sec-websocket-key'] = randomBytes(16).toString('base64');
    headers['sec-websocket-version'] = '13';
    const req = http.request({ host: upstream.hostname, port: upstream.port, path, method: 'GET', headers });
    req.on('upgrade', (res, socket, head) => resolve({ res, socket, head }));
    req.on('response', (res) => {
      res.resume();
      reject(new Error(`upstream answered ${res.statusCode} instead of 101`));
    });
    req.on('error', (error) => reject(error));
    req.end();
  });
}

async function openSocket(id, path, raw) {
  try {
    const { socket, head } = await dialUpstreamSocket(path, raw);
    send(JSON.stringify({ t: 'ws-accept', id }));
    const peer = {
      socket,
      closed: false,
      close(code, reason) {
        if (peer.closed) return;
        peer.closed = true;
        try {
          const text = Buffer.from(reason ?? '');
          const payload = Buffer.alloc(2 + text.length);
          payload.writeUInt16BE(code ?? 1000, 0);
          text.copy(payload, 2);
          socket.write(encodeWsFrame(0x8, payload));
        } catch {
          // The socket is already gone.
        }
        socket.destroy();
      },
      text(body) {
        if (!peer.closed) socket.write(encodeWsFrame(0x1, Buffer.from(body)));
      },
      binary(body) {
        if (!peer.closed) socket.write(encodeWsFrame(0x2, body));
      },
    };
    const parse = createFrameParser(({ opcode, payload }) => {
      if (opcode === 0x1) {
        send(encodeChunk(WS_TEXT, id, payload));
        return;
      }
      if (opcode === 0x2) {
        send(encodeChunk(WS_BINARY, id, payload));
        return;
      }
      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        peers.delete(id);
        peer.closed = true;
        socket.destroy();
        send(JSON.stringify({ t: 'ws-close', id, code, reason }));
        return;
      }
      if (opcode === 0x9) socket.write(encodeWsFrame(0xa, payload));
    });
    socket.on('data', parse);
    socket.on('close', () => {
      if (!peers.delete(id)) return;
      if (peer.closed) return;
      peer.closed = true;
      send(JSON.stringify({ t: 'ws-close', id, code: 1006, reason: 'upstream-closed' }));
    });
    socket.on('error', () => {});
    peers.set(id, peer);
    if (head !== undefined && head.length > 0) parse(head);
    log('upstream-socket-open', { id, path });
  } catch (error) {
    send(JSON.stringify({ t: 'ws-fail', id, message: String(error?.message ?? error) }));
    log('upstream-socket-refused', { id, path, message: String(error?.message ?? error) });
  }
}

function onControl(frame) {
  log('control', { t: frame.t, id: frame.id });
  if (frame.t === 'req') {
    if (frame.url.startsWith('/_probe/stream')) {
      serveStreamProbe(frame.id);
      return;
    }
    startHttp(frame.id, frame.method, frame.url, frame.headers);
    return;
  }
  if (frame.t === 'end') {
    requests.get(frame.id)?.end();
    return;
  }
  if (frame.t === 'ws-open') {
    void openSocket(frame.id, frame.url, frame.headers);
    return;
  }
  if (frame.t === 'ws-close') {
    peers.get(frame.id)?.close(frame.code ?? 1000, frame.reason ?? '');
    peers.delete(frame.id);
    return;
  }
  if (frame.t === 'close') {
    const peer = peers.get(frame.id);
    if (peer !== undefined) {
      peer.close(1000, frame.reason ?? 'closed');
      peers.delete(frame.id);
      return;
    }
    const req = requests.get(frame.id);
    if (req !== undefined) {
      requests.delete(frame.id);
      req.destroy();
    }
  }
}

let socket = null;

function send(payload) {
  if (socket === null || socket.readyState !== 1) return;
  socket.send(payload);
}

function connect() {
  const url = `${WORKER_URL}/connector?instance=${encodeURIComponent(INSTANCE)}&ticket=${encodeURIComponent(TICKET)}`;
  log('connector-dial', { url: url.replace(TICKET, 'REDACTED'), upstream: UPSTREAM });
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  socket = ws;
  const dialStartedAt = performance.now();

  ws.addEventListener('open', () => {
    log('connector-open', { dialMs: Math.round(performance.now() - dialStartedAt) });
  });
  ws.addEventListener('message', (event) => {
    const data = event.data;
    if (typeof data === 'string') {
      let frame;
      try {
        frame = JSON.parse(data);
      } catch {
        log('unparsable-control');
        return;
      }
      onControl(frame);
      return;
    }
    const chunk = decodeChunk(data);
    if (chunk === null) return;
    if (chunk.kind === HTTP_BODY) {
      requests.get(chunk.id)?.write(Buffer.from(chunk.payload));
      return;
    }
    const peer = peers.get(chunk.id);
    if (peer === undefined) return;
    if (chunk.kind === WS_TEXT) peer.text(Buffer.from(chunk.payload).toString('utf8'));
    if (chunk.kind === WS_BINARY) peer.binary(chunk.payload);
  });
  ws.addEventListener('close', (event) => {
    log('connector-closed', { code: event.code, reason: event.reason });
    process.exit(event.code === 1000 ? 0 : 1);
  });
  ws.addEventListener('error', () => {
    log('connector-error');
  });
}

connect();
