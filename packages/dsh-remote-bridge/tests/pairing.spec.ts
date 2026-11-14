import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto'
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { base64UrlEncode, fingerprintOfSpki, isP256Spki, sha256Hex, tokenHash, verifyEs256 } from '../src/core/crypto.ts'
import { DeviceRoster, type PushRegistration } from '../src/core/devices.ts'
import { PairingService } from '../src/core/pairing.ts'
import { answerOf, makeConnection, requestFrame } from './support/harness.ts'

/** A real P-256 key pair, in the SPKI form a client would send. */
function p256(): { spki: string; key: KeyObject } {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return {
    spki: base64UrlEncode(pair.publicKey.export({ format: 'der', type: 'spki' })),
    key: pair.privateKey,
  }
}

/** One real ES256 signature over the given bytes. */
function es256(key: KeyObject, message: Buffer): string {
  return base64UrlEncode(cryptoSign('sha256', message, { key, dsaEncoding: 'ieee-p1363' }))
}

async function rosterFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-remote-bridge-'))
  return join(directory, 'remote-bridge', 'devices.json')
}

describe('pairing: bootstrap tokens, nonces and the device roster', () => {
  it('operator reads one pairing link and the token in it is refused a second time', () => {
    // Given a freshly issued bootstrap token
    const pairing = new PairingService()
    const ticket = pairing.issueToken()
    // When it is consumed twice
    const first = pairing.consumeToken(ticket.value)
    const second = pairing.consumeToken(ticket.value)
    // Then only the first consumption is accepted
    expect(first).toBe(true)
    expect(second).toBe(false)
  })

  it('operator waits past the token lifetime and the token is no longer accepted', () => {
    // Given a clock the test controls
    let now = 1_000_000
    const pairing = new PairingService({ now: () => now })
    const ticket = pairing.issueToken()
    // When the lifetime elapses and the token is presented
    now += 30_001
    const accepted = pairing.consumeToken(ticket.value)
    // Then the expired token is refused and nothing is left pending
    expect(accepted).toBe(false)
    expect(pairing.pending).toEqual({ tokens: 0, nonces: 0 })
  })

  it('operator waits past the nonce lifetime and the nonce is no longer accepted', () => {
    // Given a nonce issued at a controlled instant
    let now = 5_000
    const pairing = new PairingService({ now: () => now })
    const nonce = pairing.issueNonce()
    // When the nonce lifetime elapses and it is consumed
    now += 60_001
    const accepted = pairing.consumeNonce(nonce.value)
    // Then it is refused
    expect(accepted).toBe(false)
  })

  it('user beginning pairing twice with one bootstrap token has the second attempt refused', async () => {
    // Given an unpaired connection and one token
    const harness = makeConnection()
    const ticket = harness.pairing.issueToken()
    // When the user begins pairing with it twice
    await harness.connection.handleText(requestFrame(1, 'pair.begin', { token: ticket.value }))
    await harness.connection.handleText(requestFrame(2, 'pair.begin', { token: ticket.value }))
    // Then the second attempt is told the token is gone
    expect(answerOf(harness, 1).ok).toBe(true)
    expect(answerOf(harness, 2).e?.code).toBe('token-invalid')
  })

  it('user finishing pairing with a real ES256 signature receives a device token and id', async () => {
    // Given an unpaired connection that consumed a bootstrap token
    const harness = makeConnection({ rosterFile: await rosterFile() })
    const key = p256()
    await harness.connection.handleText(requestFrame(3, 'pair.begin', { token: harness.pairing.issueToken().value }))
    const nonce = (answerOf(harness, 3).r as { nonce: string }).nonce
    // When the user signs the nonce bytes and finishes pairing
    await harness.connection.handleText(requestFrame(4, 'pair.finish', { devicePubKey: key.spki, signature: es256(key.key, Buffer.from(nonce, 'base64url')) }))
    // Then the enrollment answers with a token and an id, and the connection is now paired
    const answer = answerOf(harness, 4)
    const enrollment = answer.r as { deviceToken: string; deviceId: string }
    expect(answer.ok).toBe(true)
    expect(enrollment.deviceToken.length).toBeGreaterThan(20)
    expect(enrollment.deviceId).toMatch(/^dev_/)
    expect(harness.connection.paired).toBe(true)
  })

  it('user finishing pairing with a signature over other bytes is refused', async () => {
    // Given an unpaired connection with an open nonce
    const harness = makeConnection({ rosterFile: await rosterFile() })
    const key = p256()
    await harness.connection.handleText(requestFrame(5, 'pair.begin', { token: harness.pairing.issueToken().value }))
    // When the user signs the wrong message
    await harness.connection.handleText(requestFrame(6, 'pair.finish', { devicePubKey: key.spki, signature: es256(key.key, Buffer.from('some other message')) }))
    // Then the signature is refused and the enrollment never happened
    expect(answerOf(harness, 6).e?.code).toBe('signature-invalid')
    expect(harness.connection.paired).toBe(false)
  })

  it('user finishing pairing twice with the same nonce is refused the second time', async () => {
    // Given a connection that completed one pairing
    const harness = makeConnection({ rosterFile: await rosterFile() })
    const key = p256()
    await harness.connection.handleText(requestFrame(7, 'pair.begin', { token: harness.pairing.issueToken().value }))
    const nonce = (answerOf(harness, 7).r as { nonce: string }).nonce
    const signature = es256(key.key, Buffer.from(nonce, 'base64url'))
    await harness.connection.handleText(requestFrame(8, 'pair.finish', { devicePubKey: key.spki, signature }))
    // When the handshake is replayed
    await harness.connection.handleText(requestFrame(9, 'pair.finish', { devicePubKey: key.spki, signature }))
    // Then the replay is refused rather than enrolling a second device
    expect(answerOf(harness, 8).ok).toBe(true)
    expect(answerOf(harness, 9).e?.code).toBe('nonce-invalid')
  })

  it('user finishing pairing while no nonce is open is refused', async () => {
    // Given an unpaired connection that never began pairing
    const harness = makeConnection({ rosterFile: await rosterFile() })
    // When it sends a finish outright
    await harness.connection.handleText(requestFrame(10, 'pair.finish', { devicePubKey: p256().spki, signature: 'AAAA' }))
    // Then there is no challenge to answer
    expect(answerOf(harness, 10).e?.code).toBe('nonce-invalid')
  })

  it('operator keeps only the token hash and resolves the device from the presented token', async () => {
    // Given an enrolled device
    const file = await rosterFile()
    const roster = new DeviceRoster({ file })
    const key = p256()
    const enrollment = await roster.enroll(key.spki)
    if (enrollment === undefined) throw new Error('enrollment was refused')
    // When the roster file is read and the token is presented back
    const text = await readFile(file, 'utf8')
    const device = new DeviceRoster({ file })
    // Then the file carries the hash, never the token, and the token still resolves the device
    expect(text.includes(enrollment.deviceToken)).toBe(false)
    expect(text.includes(tokenHash(enrollment.deviceToken))).toBe(true)
    await device.load()
    expect(device.authenticate(enrollment.deviceToken)?.deviceId).toBe(enrollment.deviceId)
    expect(device.authenticate('not-the-token')).toBeUndefined()
  })

  it('operator pairs the same phone a second time and it keeps the row it already had', async () => {
    // Given a phone that paired once at a clock this suite owns, and registered
    // for notifications
    let now = 1_700_000_000_000
    const file = await rosterFile()
    const roster = new DeviceRoster({ file, now: () => now })
    const key = p256()
    const first = await roster.enroll(key.spki)
    if (first === undefined) throw new Error('enrollment was refused')
    const registration: PushRegistration = {
      deviceToken: 'aabbccdd',
      environment: 'sandbox',
      bundle: 'dev.dsh.Whale',
      registeredAt: now,
    }
    await roster.registerPush(first.deviceId, registration)
    // When the same key pairs again an hour later
    now += 3_600_000
    const second = await roster.enroll(key.spki)
    if (second === undefined) throw new Error('the second enrollment was refused')
    // Then one row is still the whole phone: same id, same creation time, its
    // registration untouched, and the newest sighting
    expect(roster.devices()).toHaveLength(1)
    expect(second.deviceId).toBe(first.deviceId)
    expect(roster.devices()[0]?.createdAt).toBe(1_700_000_000_000)
    expect(roster.devices()[0]?.lastSeenAt).toBe(now)
    expect(roster.pushTargets()).toEqual([{ deviceId: first.deviceId, push: registration }])
    // And only the credential moved: the token from before the pairing no longer
    // authenticates the device, the one it was just issued does
    expect(roster.authenticate(first.deviceToken)).toBeUndefined()
    expect(roster.authenticate(second.deviceToken)?.deviceId).toBe(first.deviceId)
    // And a fresh process reads that same single row back out of the file
    const reloaded = new DeviceRoster({ file })
    await reloaded.load()
    expect(reloaded.devices().map(row => row.deviceId)).toEqual([first.deviceId])
    expect(reloaded.devices()).toHaveLength(1)
  })

  it('operator opens the roster file and finds it private, atomic and free of leftovers', async () => {
    // Given a roster that has been written once
    const file = await rosterFile()
    const roster = new DeviceRoster({ file })
    await roster.enroll(p256().spki)
    // When the file and its directory are inspected
    const entries = await readdir(dirname(file))
    // Then the temporary file was renamed away
    expect(entries).toEqual(['devices.json'])
    // POSIX privacy bits: on win32 stat.mode cannot observe them (Node maps
    // chmod onto the read-only attribute alone), so the 0600/0700 assertion
    // only runs where permission bits exist.
    if (process.platform !== 'win32') {
      const fileMode = (await stat(file)).mode & 0o777
      const directoryMode = (await stat(dirname(file))).mode & 0o777
      // Then the file is 0600 inside a 0700 directory
      expect(fileMode).toBe(0o600)
      expect(directoryMode).toBe(0o700)
    }
  })

  it('operator finds a corrupt roster and it is moved aside instead of being emptied', async () => {
    // Given a roster file that is not JSON
    const file = await rosterFile()
    const roster = new DeviceRoster({ file })
    await roster.enroll(p256().spki)
    await writeFile(file, 'not a roster', 'utf8')
    // When a fresh process loads it
    const reloaded = new DeviceRoster({ file })
    await reloaded.load()
    // Then the roster is empty AND the unreadable file survives under a quarantine name
    const entries = await readdir(dirname(file))
    expect(reloaded.devices()).toEqual([])
    expect(entries.some(entry => entry.startsWith('devices.json.corrupt-'))).toBe(true)
  })

  it('operator reads a fingerprint that is the digest of the public key it stored', async () => {
    // Given an enrolled device
    const roster = new DeviceRoster({ file: await rosterFile() })
    const key = p256()
    const enrollment = await roster.enroll(key.spki)
    // When the stored row is read
    const device = roster.devices()[0]
    // Then the fingerprint is the SHA-256 of the SPKI bytes, not of its text
    expect(device?.fingerprint).toBe(sha256Hex(Buffer.from(key.spki, 'base64url')))
    expect(fingerprintOfSpki(key.spki)).toBe(device?.fingerprint)
    expect(device?.deviceId).toBe(enrollment?.deviceId)
  })

  it('operator hands the roster a key that is not P-256 and it is refused', () => {
    // Given a P-384 key and a P-256 key in the same SPKI form
    const wide = base64UrlEncode(generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ format: 'der', type: 'spki' }))
    const narrow = p256().spki
    // When both are offered as device keys
    const accepted = [narrow, wide, 'not-base64!!'].map(isP256Spki)
    // Then only the P-256 key is acceptable
    expect(accepted).toEqual([true, false, false])
  })

  it('user signing the nonce in DER form has the signature refused', () => {
    // Given a real P-256 signature emitted in the DER encoding node defaults to
    const key = p256()
    const message = Buffer.from('nonce-bytes')
    const derSignature = base64UrlEncode(cryptoSign('sha256', message, { key: key.key }))
    // When it is verified the way this bridge verifies ES256
    const accepted = verifyEs256(key.spki, derSignature, message)
    // Then the raw r||s requirement rejects it rather than accepting a second encoding
    expect(accepted).toBe(false)
    expect(verifyEs256(key.spki, es256(key.key, message), message)).toBe(true)
  })

  it('operator verifies a signature made by another key and it is rejected', () => {
    // Given two P-256 key pairs and a message signed by the first
    const signer = p256()
    const impostor = p256()
    const message = Buffer.from('nonce-bytes')
    // When the signature is checked against the impostor's key
    const accepted = verifyEs256(impostor.spki, es256(signer.key, message), message)
    // Then the signature belongs to the signer only
    expect(accepted).toBe(false)
  })

  it('user pairing while the roster cannot be written is told the failure instead of hanging', async () => {
    // Given a roster whose write path always fails (a read-only DSH home, a full disk)
    const unwritable = {
      load: async () => undefined,
      devices: () => [],
      authenticate: () => undefined,
      touch: async () => undefined,
      enroll: async () => { throw new Error('EACCES: the roster directory is not writable') },
    } as unknown as DeviceRoster
    const harness = makeConnection({ roster: unwritable })
    const key = p256()
    await harness.connection.handleText(requestFrame(1, 'pair.begin', { token: harness.pairing.issueToken().value }))
    const nonce = (answerOf(harness, 1).r as { nonce: string }).nonce
    // When the user finishes pairing and the enrollment throws
    await harness.connection.handleText(requestFrame(2, 'pair.finish', {
      devicePubKey: key.spki,
      signature: es256(key.key, Buffer.from(nonce, 'base64url')),
    }))
    // Then the failure is answered as a refusal rather than leaving the client waiting
    expect(answerOf(harness, 2).ok).toBe(false)
    expect(answerOf(harness, 2).e?.code).toBe('internal')
    expect(harness.logs.some(line => line.includes('EACCES'))).toBe(true)
    // And the connection is still usable afterwards
    await harness.connection.handleText(requestFrame(3, 'hello', { proto: 1 }))
    expect(answerOf(harness, 3).ok).toBe(true)
  })
})
