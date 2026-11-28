import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  asJsonObject,
  CHARSET_ERROR_CODE,
  CharsetError,
  readBoundedJson,
  readJsonBody,
  withIdentityEncoding,
  writeBodyReadError,
  writeJson,
} from '../host/http.ts'

/**
 * Async-readable IncomingMessage stand-in built from byte chunks; counts
 * destroy calls. A hand-rolled async iterator keeps destroy counting exact:
 * abandoning the loop must not trigger extra destroy activity.
 */
function fakeRequest(chunks: Buffer[] = []): { request: IncomingMessage; destroyCalls: () => number } {
  let destroyCalls = 0
  const request = {
    [Symbol.asyncIterator]() {
      let index = 0
      return {
        next: async () => (index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined }),
      }
    },
    destroy() {
      destroyCalls += 1
    },
  } as unknown as IncomingMessage
  return { request, destroyCalls: () => destroyCalls }
}

function bytes(text: string): Buffer {
  return Buffer.from(text, 'utf8')
}

/** ServerResponse stand-in recording status, headers and the payload. */
function fakeResponse(): { response: ServerResponse; status: () => number; headers: () => Record<string, unknown>; body: () => string } {
  const state = { status: 0, headers: {} as Record<string, unknown>, body: '' }
  const response = {
    writeHead(status: number, headers: Record<string, unknown>) {
      state.status = status
      Object.assign(state.headers, headers)
    },
    end(payload?: string) {
      state.body = payload ?? ''
    },
  } as unknown as ServerResponse
  return {
    response,
    status: () => state.status,
    headers: () => state.headers,
    body: () => state.body,
  }
}

describe('readBoundedJson', () => {
  it('parses a JSON body', async () => {
    const { request } = fakeRequest([bytes('{"a":1}')])
    await expect(readBoundedJson(request, 1024)).resolves.toEqual({ a: 1 })
  })

  it('throws past the byte cap', async () => {
    const { request } = fakeRequest([bytes('{"a":1}')])
    await expect(readBoundedJson(request, 4)).rejects.toThrow('body too large')
  })

  it('throws on invalid JSON', async () => {
    const { request } = fakeRequest([bytes('not json')])
    await expect(readBoundedJson(request, 1024)).rejects.toThrow()
  })

  it('throws on an empty body', async () => {
    const { request } = fakeRequest([])
    await expect(readBoundedJson(request, 1024)).rejects.toThrow()
  })
})

describe('readJsonBody', () => {
  it('parses a JSON body', async () => {
    const { request } = fakeRequest([bytes('{"a":1}')])
    await expect(readJsonBody(request)).resolves.toEqual({ a: 1 })
  })

  it('returns null for an empty body without destroying the request', async () => {
    const { request, destroyCalls } = fakeRequest([])
    await expect(readJsonBody(request)).resolves.toBeNull()
    expect(destroyCalls()).toBe(0)
  })

  it('returns null for invalid JSON without destroying the request', async () => {
    const { request, destroyCalls } = fakeRequest([bytes('not json')])
    await expect(readJsonBody(request)).resolves.toBeNull()
    expect(destroyCalls()).toBe(0)
  })

  it('defaults to a 64 KiB cap', async () => {
    const atCap = fakeRequest([bytes('{"a":"' + 'x'.repeat(64 * 1024 - 8) + '"}')])
    await expect(readJsonBody(atCap.request)).resolves.not.toBeNull()
    const over = fakeRequest([bytes('{"a":"' + 'x'.repeat(64 * 1024 - 6) + '"}')])
    await expect(readJsonBody(over.request)).resolves.toBeNull()
    expect(over.destroyCalls()).toBe(1)
  })

  it('returns null and destroys the request when the body exceeds a custom cap', async () => {
    const { request, destroyCalls } = fakeRequest([bytes('{"a":1}')])
    await expect(readJsonBody(request, { maxBytes: 4 })).resolves.toBeNull()
    expect(destroyCalls()).toBe(1)
  })

  it('returns null for a non-object payload in objectOnly mode', async () => {
    for (const payload of ['[1,2]', '"text"', '42', 'null', 'true']) {
      const { request, destroyCalls } = fakeRequest([bytes(payload)])
      await expect(readJsonBody(request, { objectOnly: true })).resolves.toBeNull()
      expect(destroyCalls()).toBe(0)
    }
  })

  it('accepts an object payload in objectOnly mode', async () => {
    const { request } = fakeRequest([bytes('{"a":1}')])
    await expect(readJsonBody(request, { objectOnly: true })).resolves.toEqual({ a: 1 })
  })

  it('accepts non-object payloads without objectOnly', async () => {
    const { request } = fakeRequest([bytes('[1,2]')])
    await expect(readJsonBody(request)).resolves.toEqual([1, 2])
  })
})

describe('asJsonObject', () => {
  it('narrows plain objects', () => {
    expect(asJsonObject({ a: 1 })).toEqual({ a: 1 })
  })

  it('returns undefined for arrays, primitives and null', () => {
    expect(asJsonObject([1, 2])).toBeUndefined()
    expect(asJsonObject('text')).toBeUndefined()
    expect(asJsonObject(42)).toBeUndefined()
    expect(asJsonObject(true)).toBeUndefined()
    expect(asJsonObject(null)).toBeUndefined()
    expect(asJsonObject(undefined)).toBeUndefined()
  })
})

describe('writeJson', () => {
  it('writes the family-default headers with the status and JSON body', () => {
    const { response, status, headers, body } = fakeResponse()
    writeJson(response, 200, { ok: true })
    expect(status()).toBe(200)
    expect(headers()).toEqual({
      'content-type': 'application/json; charset=utf-8',
      'referrer-policy': 'no-referrer',
    })
    expect(body()).toBe('{"ok":true}')
  })

  it('lets caller headers append to and override the defaults', () => {
    const { response, headers } = fakeResponse()
    writeJson(response, 201, { ok: true }, { 'x-trace-id': 't1', 'content-type': 'application/problem+json' })
    expect(headers()).toMatchObject({
      'referrer-policy': 'no-referrer',
      'x-trace-id': 't1',
      'content-type': 'application/problem+json',
    })
  })
})

describe('withIdentityEncoding', () => {
  it('forces identity encoding even with no caller init', () => {
    const init = withIdentityEncoding()
    expect(new Headers(init.headers).get('accept-encoding')).toBe('identity')
  })

  it('keeps caller headers, method and signal while overriding a caller accept-encoding', () => {
    const controller = new AbortController()
    const init = withIdentityEncoding({
      method: 'POST',
      signal: controller.signal,
      headers: { authorization: 'Bearer token', 'accept-encoding': 'gzip' },
    })
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe('Bearer token')
    expect(headers.get('accept-encoding')).toBe('identity')
    expect(init.method).toBe('POST')
    expect(init.signal).toBe(controller.signal)
  })
})

/**
 * A JSON body whose value carries GBK bytes ("中文"): `Buffer.toString("utf8")`
 * would substitute U+FFFD per invalid byte and let JSON.parse succeed, which is
 * the silent transcode this guard exists to stop.
 */
function gbkBody(): Buffer {
  return Buffer.concat([bytes('{"a":"'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), bytes('"}')])
}

describe('charset guard', () => {
  it('rejects a non-UTF-8 body with E_CHARSET_INVALID instead of transcoding', async () => {
    const { request } = fakeRequest([gbkBody()])
    const error = await readBoundedJson(request, 1024).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CharsetError)
    expect((error as CharsetError).code).toBe(CHARSET_ERROR_CODE)
    expect((error as Error).message).toContain(CHARSET_ERROR_CODE)
    expect((error as Error).message).toContain('UTF-8')
    expect((error as Error).message).toContain('Fix the sender')
  })

  it('keeps parsing a valid UTF-8 Chinese body', async () => {
    const { request } = fakeRequest([bytes('{"a":"继续"}')])
    await expect(readBoundedJson(request, 1024)).resolves.toEqual({ a: '继续' })
  })

  it('reports a non-UTF-8 body as null in the lenient reader without destroying', async () => {
    const { request, destroyCalls } = fakeRequest([gbkBody()])
    await expect(readJsonBody(request)).resolves.toBeNull()
    expect(destroyCalls()).toBe(0)
  })

  it('keeps the reject-as-null default when throwOnCharset is not set (zero contract drift)', async () => {
    const { request } = fakeRequest([gbkBody()])
    await expect(readJsonBody(request, { objectOnly: true })).resolves.toBeNull()
    await expect(readJsonBody(request, { maxBytes: 1024 })).resolves.toBeNull()
  })

  it('throws CharsetError under throwOnCharset: true so a route can surface the code', async () => {
    const { request, destroyCalls } = fakeRequest([gbkBody()])
    const error = await readJsonBody(request, { throwOnCharset: true }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CharsetError)
    expect((error as CharsetError).code).toBe(CHARSET_ERROR_CODE)
    expect(destroyCalls()).toBe(0)
  })

  it('still parses a valid UTF-8 Chinese body under throwOnCharset: true', async () => {
    const { request } = fakeRequest([bytes('{"a":"继续"}')])
    await expect(readJsonBody(request, { throwOnCharset: true })).resolves.toEqual({ a: '继续' })
  })

  it('keeps yielding null for malformed/empty/oversized bodies under throwOnCharset: true', async () => {
    const malformed = fakeRequest([bytes('{not json')])
    await expect(readJsonBody(malformed.request, { throwOnCharset: true })).resolves.toBeNull()
    const empty = fakeRequest([Buffer.alloc(0)])
    await expect(readJsonBody(empty.request, { throwOnCharset: true })).resolves.toBeNull()
    const over = fakeRequest([bytes('x'.repeat(8))])
    await expect(readJsonBody(over.request, { maxBytes: 4, throwOnCharset: true })).resolves.toBeNull()
  })

  it('writes400 with the code and guidance for a charset failure', () => {
    const { response, status, body } = fakeResponse()
    writeBodyReadError(response, new CharsetError())
    expect(status()).toBe(400)
    const parsed = JSON.parse(body()) as { ok: boolean; code?: string; error?: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.code).toBe(CHARSET_ERROR_CODE)
    expect(parsed.error).toContain(CHARSET_ERROR_CODE)
    expect(parsed.error).toContain('Fix the sender')
  })

  it('keeps the generic message for every other body-read failure', () => {
    const { response, status, body } = fakeResponse()
    writeBodyReadError(response, new Error('body too large'))
    expect(status()).toBe(400)
    expect(JSON.parse(body())).toEqual({ ok: false, error: 'body must be valid JSON' })
  })

  it('passes caller headers through (a family can keep its cache-control)', () => {
    const { response, status, headers } = fakeResponse()
    writeBodyReadError(response, new CharsetError(), { 'cache-control': 'no-store' })
    expect(status()).toBe(400)
    expect(headers()['cache-control']).toBe('no-store')
  })
})
