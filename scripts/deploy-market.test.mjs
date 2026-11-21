/**
 * Retry contract for scripts/deploy-market.
 *
 * The Deploy Market lane went red on Cloudflare API throttling: wrangler only
 * backs off when the 429 carries a Retry-After header, so the script itself has
 * to retry transient failures and keep every other failure on the fail-fast
 * path. The CLI turns a false "ok" into fail(), which prints the message and
 * exits 1, so these tests drive the policy through an injected attempt list and
 * an injected wait: no child process, no network, no clock.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
  TAIL_LINES,
  classifyTransientFailure,
  createTail,
  failureMessage,
  rayIdFrom,
  retryDelayMs,
  runWithRetries,
  spawnAttempt,
} = require('./deploy-market')

/** The exact text the failing Deploy Market runs stopped on. */
const THROTTLED = 'Received a malformed response from the API - GET /accounts/***/workers/services/dsh-market -> 429 Too Many Requests'

const WRANGLER = 'wrangler'
const DEPLOY_ARGS = ['deploy']

/**
 * Drive the retry policy over a planned child history: each entry is the
 * { status, tail } one attempt would produce, and the last entry repeats once
 * the policy asks for more runs than the plan holds. The recording wait and
 * retry callbacks stand in for the clock and the job log.
 */
async function runPlan(entries, overrides) {
  const runs = []
  const waits = []
  const retries = []
  const runAttempt = async () => {
    const entry = entries[Math.min(runs.length, entries.length - 1)]
    runs.push(entry)
    return entry
  }
  const wait = async (ms) => { waits.push(ms) }
  const onRetry = (info) => { retries.push(info) }
  const result = await runWithRetries(runAttempt, Object.assign({ wait, onRetry }, overrides))
  return { result, runs, waits, retries }
}

test('the retry schedule pauses 5s, 20s, then 60s and stops with the attempt cap', () => {
  // Given the documented budget of four runs per wrangler invocation
  assert.equal(MAX_ATTEMPTS, 4)
  assert.deepEqual(RETRY_BACKOFF_MS, [5000, 20000, 60000])
  // When each failed attempt asks for the pause before the next one
  // Then the schedule is spent by attempt three and attempt four waits for nothing
  assert.deepEqual([1, 2, 3, 4].map((attempt) => retryDelayMs(attempt)), [5000, 20000, 60000, null])
})

test('a throttled wrangler call that clears on the next attempt ends with status 0 and logs the retry', async () => {
  // Given a 429 without a Retry-After header on the first run and success on the second
  const { result, runs, waits, retries } = await runPlan([
    { status: 1, tail: THROTTLED },
    { status: 0, tail: 'Uploaded dsh-market (3.21 sec)' },
  ])
  // When the deploy runs the command
  // Then it ends with exit status 0 after one retry, and the retry is visible to the operator
  assert.equal(result.ok, true)
  assert.equal(result.status, 0)
  assert.equal(result.attempts, 2)
  assert.equal(runs.length, 2)
  assert.deepEqual(waits, [5000])
  assert.deepEqual(retries, [{ attempt: 1, attempts: 4, reason: 'http-429', pauseMs: 5000 }])
})

test('a malformed API response that clears on the next attempt ends with status 0 and logs the retry', async () => {
  // Given wrangler reported an unparsable API response on the first run
  const { result, runs, waits, retries } = await runPlan([
    { status: 1, tail: 'Received a malformed response from the API - GET /accounts/***/workers/services/dsh-market' },
    { status: 0, tail: 'Deployed dsh-market triggers' },
  ])
  // When the deploy runs the command
  // Then the same single retry carries it to exit status 0
  assert.equal(result.ok, true)
  assert.equal(result.status, 0)
  assert.equal(runs.length, 2)
  assert.deepEqual(waits, [5000])
  assert.equal(retries[0].reason, 'malformed-api-response')
})

test('an exhausted retry budget fails with the captured evidence and the Cloudflare Ray ID', async () => {
  // Given every run is throttled and Cloudflare printed its Ray ID
  const throttledTail = [
    'X [ERROR] A request to the Cloudflare API (/accounts/abc/workers/services/dsh-market) failed.',
    '  ' + THROTTLED,
    '  Ray ID: 8a1b2c3d4e5f6789',
  ].join(String.fromCharCode(10))
  const { result, runs, waits } = await runPlan([{ status: 1, tail: throttledTail }])
  // When the budget runs out
  // Then the command is reported failed after the fourth run, with no pause left to spend
  assert.equal(result.ok, false)
  assert.equal(result.status, 1)
  assert.equal(result.reason, 'http-429')
  assert.equal(runs.length, 4)
  assert.deepEqual(waits, [5000, 20000, 60000])
  // And the failure message quotes the attempt count, the evidence, and the Ray ID
  const message = failureMessage(WRANGLER, DEPLOY_ARGS, result)
  assert.match(message, /^wrangler deploy failed \(exit 1\)/)
  assert.match(message, /still transient \(http-429\) after 4 attempts/)
  assert.match(message, /429 Too Many Requests/)
  assert.match(message, /malformed response from the API/)
  assert.equal(message.split('Ray ID: 8a1b2c3d4e5f6789').length - 1, 2)
  assert.match(message, /captured output tail \(at most 200 lines\):/)
})

test('a non-transient failure is attempted exactly once and keeps the fail-fast message', async () => {
  // Given wrangler rejected the token, which no retry can fix
  const authFailure = [
    'X [ERROR] A request to the Cloudflare API (/accounts/abc/workers/scripts/dsh-market) failed.',
    '  Authentication error [code: 10000]',
  ].join(String.fromCharCode(10))
  const { result, runs, waits, retries } = await runPlan([{ status: 1, tail: authFailure }])
  // When the deploy runs the command
  // Then it fails on the first run without pausing for a retry
  assert.equal(result.ok, false)
  assert.equal(result.status, 1)
  assert.equal(result.attempts, 1)
  assert.equal(result.reason, null)
  assert.equal(runs.length, 1)
  assert.deepEqual(waits, [])
  assert.deepEqual(retries, [])
  // And the message is byte-identical to the one the lane printed before the retry existed
  assert.equal(failureMessage(WRANGLER, DEPLOY_ARGS, result), 'wrangler deploy failed (exit 1)')
})

test('the transient classifier recognizes throttling, server errors, malformed responses and socket failures', () => {
  // Given the failure texts wrangler prints for a transient API condition
  const transient = [
    [THROTTLED, 'http-429'],
    ['GET /accounts/abc/workers/services/dsh-market -> 429 Too Many Requests', 'http-429'],
    ['HTTP 503 Service Unavailable', 'http-5xx'],
    ['status: 500', 'http-5xx'],
    ['statusCode: 502', 'http-5xx'],
    ['request failed -> 522 Connection timed out', 'http-5xx'],
    ['Received a malformed response from the API - unexpected end of JSON input', 'malformed-api-response'],
    ['read ECONNRESET', 'socket-error'],
    ['connect ETIMEDOUT 104.16.0.1:443', 'socket-error'],
    ['write EPIPE', 'socket-error'],
    ['Error: socket hang up', 'socket-error'],
  ]
  // When each text is classified
  // Then every one of them names the condition worth another attempt
  for (const [text, reason] of transient) {
    assert.equal(classifyTransientFailure(text), reason, text)
  }
})

test('the transient classifier leaves auth, config, and content failures to fail fast', () => {
  // Given failures that another attempt cannot change
  const failFast = [
    'Authentication error [code: 10000]',
    'You are not authorized to access this resource',
    'Missing entry-point to Worker script or to assets directory',
    'workers.api.error.duplicate [code: 10504]',
    'Deploy failed: invalid value for "assets.directory"',
    'The D1 database 1b2c3d4e5f6a was not found in account abc',
    'Uploaded 1500 assets (500 new)',
    'at Object.<anonymous> (/app/node_modules/wrangler/wrangler-dist/cli.js:500:12)',
  ]
  // When each text is classified
  // Then none of them is treated as transient
  for (const text of failFast) {
    assert.equal(classifyTransientFailure(text), null, text)
  }
})

test('a smaller injected attempt budget spends only the pauses it still has', async () => {
  // Given a budget of two runs that both fail transiently
  const { result, runs, waits } = await runPlan([{ status: 1, tail: THROTTLED }], { attempts: 2 })
  // When the policy runs out of attempts
  // Then it stops after the second run with the single pause it was entitled to
  assert.equal(result.ok, false)
  assert.equal(result.attempts, 2)
  assert.equal(runs.length, 2)
  assert.deepEqual(waits, [5000])
})

test('the captured tail keeps the last lines and drops the earlier ones', () => {
  // Given more output lines than the evidence bound allows
  const printed = []
  for (let i = 1; i <= TAIL_LINES + 5; i++) printed.push('line ' + i)
  // When the run finishes
  const tail = createTail()
  tail.chunk(printed.join(String.fromCharCode(10)) + String.fromCharCode(10))
  const kept = tail.flush().split(String.fromCharCode(10))
  // Then exactly the tail is kept, starting at the first line inside the bound
  assert.equal(kept.length, TAIL_LINES)
  assert.equal(kept[0], 'line 6')
  assert.equal(kept[kept.length - 1], 'line ' + (TAIL_LINES + 5))
})

test('a line split across two chunks stays one captured line', () => {
  // Given a child whose output arrives in the middle of a line
  const tail = createTail(3)
  tail.chunk('alpha' + String.fromCharCode(10) + 'be')
  tail.chunk('ta' + String.fromCharCode(10) + 'gamma')
  // When the run finishes
  // Then the split line is reassembled instead of quoted twice
  assert.deepEqual(tail.flush().split(String.fromCharCode(10)), ['alpha', 'beta', 'gamma'])
})

test('the Ray ID is read from each shape Cloudflare prints it in', () => {
  // Given the header, JSON and console shapes of the same Ray ID
  const shapes = [
    'X [ERROR] A request to the Cloudflare API (/accounts/abc/workers/services/dsh-market) failed.' + String.fromCharCode(10) + '  Ray ID: 8a1b2c3d4e5f6789',
    '{"success":false,"errors":[],"messages":[],"ray_id":"8a1b2c3d4e5f6789"}',
    'cf-ray: 8a1b2c3d4e5f6789-SJC',
  ]
  // When each shape is read
  // Then the Ray ID comes out of every one of them
  for (const text of shapes) {
    assert.match(rayIdFrom(text), /^8a1b2c3d4e5f6789/)
  }
  // And a text without a Ray ID yields nothing to quote
  assert.equal(rayIdFrom('workers api returned an unknown error'), null)
})

test('the child runner relays a real command and reports its exit status with the captured tail', async () => {
  // Given a command that writes to both streams and exits non-zero
  const script = 'console.log("stdout marker"); console.error("stderr marker"); process.exit(3)'
  // When the runner executes it in capture mode
  const result = await spawnAttempt(process.execPath, ['-e', script], undefined, { capture: true })
  // Then the status travels back and both streams land in the captured output and the tail
  assert.equal(result.status, 3)
  assert.match(result.output, /stdout marker/)
  assert.match(result.output, /stderr marker/)
  assert.match(result.tail, /stderr marker/)
})

test('the child runner writes the stdin payload the secret bindings depend on', async () => {
  // Given a command that echoes whatever it reads on stdin
  const script = 'let seen = ""; process.stdin.on("data", (chunk) => { seen += chunk }); process.stdin.on("end", () => { process.stdout.write("read:" + seen) })'
  // When the runner feeds it a payload
  const result = await spawnAttempt(process.execPath, ['-e', script], undefined, { input: 'turnstile-value', capture: true })
  // Then the child received the payload instead of an empty stream
  assert.equal(result.status, 0)
  assert.match(result.output, /read:turnstile-value/)
})
