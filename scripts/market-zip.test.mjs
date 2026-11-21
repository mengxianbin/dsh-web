/**
 * market-zip: verify the zipStore() function used by market-build produces
 * standard-compliant ZIP archives that can be parsed by any spec-conforming
 * extractor. This catches the offset misalignment that previously broke
 * 360 Zip, WinRAR, 7-Zip, and Windows Explorer (#1050).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crc32 } from 'node:zlib'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import { zipStore, zipSkinArchive, MAX_SERVED_ASSET_BYTES } from './lib/market-zip.cjs'

// --- Minimal ZIP parser for structural verification ---

function parseLFH(buf, offset) {
  assert.equal(buf.readUInt32LE(offset), 0x04034b50, 'LFH signature')
  return {
    versionNeeded: buf.readUInt16LE(offset + 4),
    flags: buf.readUInt16LE(offset + 6),
    compression: buf.readUInt16LE(offset + 8),
    modTime: buf.readUInt16LE(offset + 10),
    modDate: buf.readUInt16LE(offset + 12),
    crc32: buf.readUInt32LE(offset + 14),
    compressedSize: buf.readUInt32LE(offset + 18),
    uncompressedSize: buf.readUInt32LE(offset + 22),
    fileNameLength: buf.readUInt16LE(offset + 26),
    extraFieldLength: buf.readUInt16LE(offset + 28),
  }
}

function parseCDE(buf, offset) {
  assert.equal(buf.readUInt32LE(offset), 0x02014b50, 'CDE signature')
  return {
    versionMadeBy: buf.readUInt16LE(offset + 4),
    versionNeeded: buf.readUInt16LE(offset + 6),
    flags: buf.readUInt16LE(offset + 8),
    compression: buf.readUInt16LE(offset + 10),
    modTime: buf.readUInt16LE(offset + 12),
    modDate: buf.readUInt16LE(offset + 14),
    crc32: buf.readUInt32LE(offset + 16),
    compressedSize: buf.readUInt32LE(offset + 20),
    uncompressedSize: buf.readUInt32LE(offset + 24),
    fileNameLength: buf.readUInt16LE(offset + 28),
    extraFieldLength: buf.readUInt16LE(offset + 30),
    commentLength: buf.readUInt16LE(offset + 32),
    diskStart: buf.readUInt16LE(offset + 34),
    internalAttrs: buf.readUInt16LE(offset + 36),
    externalAttrs: buf.readUInt32LE(offset + 38),
    localHeaderOffset: buf.readUInt32LE(offset + 42),
  }
}

function parseEOCD(buf) {
  // Scan backwards for EOCD signature
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      return {
        offset: i,
        diskNumber: buf.readUInt16LE(i + 4),
        cdDisk: buf.readUInt16LE(i + 6),
        recordsOnDisk: buf.readUInt16LE(i + 8),
        totalRecords: buf.readUInt16LE(i + 10),
        cdSize: buf.readUInt32LE(i + 12),
        cdOffset: buf.readUInt32LE(i + 16),
        commentLength: buf.readUInt16LE(i + 20),
      }
    }
  }
  throw new Error('EOCD not found')
}

// --- Tests ---

test('market download keeps an empty archive byte-stable', () => {
  // Given no skin files, when serialized, then emit the fixed empty ZIP.
  assert.equal(zipStore([]).toString('hex'), '504b0506000000000000000000000000000000000000')
})

test('market download preserves deterministic UTF-8, binary and empty-file bytes', () => {
  // Given ordered skin files covering each byte shape.
  const files = [
    { name: 'hello.txt', data: Buffer.from('Hello, World!') },
    { name: 'subdir/binary.bin', data: Buffer.from([0, 1, 2, 255, 254, 253]) },
    { name: 'empty.dat', data: Buffer.alloc(0) },
    { name: '\u96ea/\u043f\u0440\u0438\u0432\u0435\u0442.txt', data: Buffer.from('\u4f60\u597d\n') },
  ]
  // When the production writer emits the archive.
  const zip = zipStore(files)
  // Then preserve the shipped format fingerprint and readable UTF-8 name/data.
  assert.equal(createHash('sha256').update(zip).digest('hex'), '7107f2beade5d9193846410c1bf6a20c070da28cf233daf74a522e164794a1e0')
  let offset = 0
  for (const file of files) {
    const header = parseLFH(zip, offset)
    const start = offset + 30
    assert.equal(zip.subarray(start, start + header.fileNameLength).toString('utf8'), file.name)
    const dataStart = start + header.fileNameLength
    assert.deepEqual(zip.subarray(dataStart, dataStart + header.compressedSize), file.data)
    offset = dataStart + header.compressedSize
  }
})

const testFiles = [
  { name: 'hello.txt', data: Buffer.from('Hello, World!') },
  { name: 'subdir/binary.bin', data: Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]) },
  { name: 'empty.dat', data: Buffer.alloc(0) },
]

test('zipStore produces valid ZIP with correct EOCD', () => {
  const zip = zipStore(testFiles)
  const eocd = parseEOCD(zip)
  assert.equal(eocd.totalRecords, 3, 'total file count')
  assert.equal(eocd.recordsOnDisk, 3, 'records on disk')
  assert.equal(eocd.diskNumber, 0)
  assert.equal(eocd.cdDisk, 0)
  assert.ok(eocd.cdOffset > 0, 'CD offset must be positive')
  assert.ok(eocd.cdSize > 0, 'CD size must be positive')
})

test('Local File Headers have correct field offsets and values', () => {
  const zip = zipStore(testFiles)
  let offset = 0
  for (const file of testFiles) {
    const lfh = parseLFH(zip, offset)
    const expectedCrc = crc32(file.data) >>> 0
    assert.equal(lfh.compression, 0, `${file.name}: store method`)
    assert.equal(lfh.crc32, expectedCrc, `${file.name}: CRC-32`)
    assert.equal(lfh.compressedSize, file.data.length, `${file.name}: compressed size`)
    assert.equal(lfh.uncompressedSize, file.data.length, `${file.name}: uncompressed size`)
    assert.equal(lfh.fileNameLength, Buffer.byteLength(file.name), `${file.name}: name length`)
    assert.equal(lfh.extraFieldLength, 0, `${file.name}: no extra field`)
    assert.equal(lfh.flags & 0x0800, 0x0800, `${file.name}: UTF-8 flag`)
    // Verify file name
    const nameStart = offset + 30
    const nameStr = zip.subarray(nameStart, nameStart + lfh.fileNameLength).toString('utf8')
    assert.equal(nameStr, file.name, `${file.name}: name matches`)
    // Verify data content
    const dataStart = nameStart + lfh.fileNameLength
    const dataSlice = zip.subarray(dataStart, dataStart + lfh.compressedSize)
    assert.deepEqual(dataSlice, file.data, `${file.name}: data intact`)
    offset = dataStart + lfh.compressedSize
  }
})

test('Central Directory entries have correct field offsets and values', () => {
  const zip = zipStore(testFiles)
  const eocd = parseEOCD(zip)
  let cdOffset = eocd.cdOffset
  let expectedLfhOffset = 0
  for (const file of testFiles) {
    const cde = parseCDE(zip, cdOffset)
    const expectedCrc = crc32(file.data) >>> 0
    assert.equal(cde.compression, 0, `${file.name}: store method`)
    assert.equal(cde.crc32, expectedCrc, `${file.name}: CRC-32`)
    assert.equal(cde.compressedSize, file.data.length, `${file.name}: compressed size`)
    assert.equal(cde.uncompressedSize, file.data.length, `${file.name}: uncompressed size`)
    assert.equal(cde.fileNameLength, Buffer.byteLength(file.name), `${file.name}: name length`)
    assert.equal(cde.extraFieldLength, 0, `${file.name}: no extra field`)
    assert.equal(cde.commentLength, 0, `${file.name}: no comment`)
    assert.equal(cde.localHeaderOffset, expectedLfhOffset, `${file.name}: LFH offset`)
    assert.equal(cde.versionMadeBy, 0x0314, `${file.name}: UNIX 2.0`)
    // External attrs: POSIX file mode rw-r--r-- (0o100644 << 16) | DOS archive (0x20)
    assert.equal(cde.externalAttrs, ((0o100644 << 16) | 0x20) >>> 0, `${file.name}: POSIX attrs`)
    // Verify file name
    const nameStart = cdOffset + 46
    const nameStr = zip.subarray(nameStart, nameStart + cde.fileNameLength).toString('utf8')
    assert.equal(nameStr, file.name, `${file.name}: name matches`)
    cdOffset = nameStart + cde.fileNameLength
    expectedLfhOffset += 30 + Buffer.byteLength(file.name) + file.data.length
  }
})

test('DOS timestamps are legal (1980-01-01)', () => {
  const zip = zipStore(testFiles)
  const lfh = parseLFH(zip, 0)
  // dosDate 0x0021 = (0 << 9) | (1 << 5) | 1 = 1980-01-01
  assert.equal(lfh.modDate, 0x0021, 'LFH DOS date is 1980-01-01')
  assert.equal(lfh.modTime, 0x0000, 'LFH DOS time is 00:00:00')
  const eocd = parseEOCD(zip)
  const cde = parseCDE(zip, eocd.cdOffset)
  assert.equal(cde.modDate, 0x0021, 'CDE DOS date is 1980-01-01')
  assert.equal(cde.modTime, 0x0000, 'CDE DOS time is 00:00:00')
})

test('roundtrip: extracted data matches original input', () => {
  const zip = zipStore(testFiles)
  const eocd = parseEOCD(zip)
  let cdOffset = eocd.cdOffset
  const extracted = []
  for (let i = 0; i < eocd.totalRecords; i++) {
    const cde = parseCDE(zip, cdOffset)
    const nameStart = cdOffset + 46
    const name = zip.subarray(nameStart, nameStart + cde.fileNameLength).toString('utf8')
    // Read data from LFH
    const lfh = parseLFH(zip, cde.localHeaderOffset)
    const dataStart = cde.localHeaderOffset + 30 + lfh.fileNameLength + lfh.extraFieldLength
    const data = zip.subarray(dataStart, dataStart + lfh.uncompressedSize)
    extracted.push({ name, data: Buffer.from(data) })
    cdOffset = nameStart + cde.fileNameLength + cde.extraFieldLength + cde.commentLength
  }
  assert.equal(extracted.length, testFiles.length, 'same number of files')
  for (let i = 0; i < testFiles.length; i++) {
    assert.equal(extracted[i].name, testFiles[i].name, `file ${i} name`)
    assert.deepEqual(extracted[i].data, testFiles[i].data, `file ${i} data`)
  }
})

test('single empty file ZIP is valid', () => {
  const zip = zipStore([{ name: 'a.txt', data: Buffer.alloc(0) }])
  const eocd = parseEOCD(zip)
  assert.equal(eocd.totalRecords, 1)
  const cde = parseCDE(zip, eocd.cdOffset)
  assert.equal(cde.compressedSize, 0)
  assert.equal(cde.uncompressedSize, 0)
})

test('a skin archive under the served-asset cap is produced', () => {
  const entries = [
    { name: 'demo/skin.json', data: Buffer.from('{"id":"demo"}') },
    { name: 'demo/preview/light.jpg', data: Buffer.alloc(64, 7) },
  ]
  const archive = zipSkinArchive(entries)
  assert.ok(Buffer.isBuffer(archive), 'archive is produced when it fits')
  const eocd = parseEOCD(archive)
  assert.equal(eocd.totalRecords, 2)
})

test('a skin archive above the served-asset cap is not produced', () => {
  const entries = [{ name: 'demo/assets/heavy.bin', data: Buffer.alloc(4096, 1) }]
  assert.equal(zipSkinArchive(entries, 2048), null, 'over-cap archive is skipped instead of breaking the deploy')
  assert.ok(Buffer.isBuffer(zipSkinArchive(entries, 8192)), 'the same entries fit under a larger cap')
})

test('the served-asset cap is the 25 MiB Workers per-file limit', () => {
  assert.equal(MAX_SERVED_ASSET_BYTES, 25 * 1024 * 1024)
})

test('large file roundtrip (64 KB)', () => {
  const bigData = Buffer.alloc(65536)
  for (let i = 0; i < bigData.length; i++) bigData[i] = i & 0xff
  const zip = zipStore([{ name: 'big.bin', data: bigData }])
  const eocd = parseEOCD(zip)
  const cde = parseCDE(zip, eocd.cdOffset)
  assert.equal(cde.compressedSize, 65536)
  assert.equal(cde.uncompressedSize, 65536)
  assert.equal(cde.crc32, crc32(bigData) >>> 0)
})
