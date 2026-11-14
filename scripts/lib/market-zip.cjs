'use strict'

const { crc32 } = require('node:zlib')

/**
 * Minimal standard-compliant ZIP writer (store method, no compression).
 * Output is fully deterministic (fixed 1980-01-01 DOS timestamps).
 *
 * Previous implementation had a fatal 2-byte shift in both Local File Header
 * and Central Directory Entry (extra writeUInt16LE at offset 14/16 pushed all
 * subsequent fields by 2 bytes), causing most extractors to reject the
 * archive. This rewrite aligns every field to the PKWARE APPNOTE.TXT spec.
 */
function zipStore(files) {
  const chunks = []
  const central = []
  let offset = 0

  // 1980-01-01 00:00:00 in MS-DOS format
  const DOS_TIME = 0x0000
  const DOS_DATE = 0x0021 // (0 << 9) | (1 << 5) | 1

  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, 'utf8')
    const crc = crc32(data) >>> 0

    // Local File Header (30 bytes)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)       // Signature
    header.writeUInt16LE(20, 4)               // Version needed (2.0)
    header.writeUInt16LE(0x0800, 6)           // General purpose flag (UTF-8)
    header.writeUInt16LE(0, 8)                // Compression method (Store)
    header.writeUInt16LE(DOS_TIME, 10)        // Last mod time
    header.writeUInt16LE(DOS_DATE, 12)        // Last mod date
    header.writeUInt32LE(crc, 14)             // CRC-32
    header.writeUInt32LE(data.length, 18)     // Compressed size
    header.writeUInt32LE(data.length, 22)     // Uncompressed size
    header.writeUInt16LE(nameBytes.length, 26) // File name length
    header.writeUInt16LE(0, 28)               // Extra field length
    chunks.push(header, nameBytes, data)

    // Central Directory Header (46 bytes)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)          // Signature
    cen.writeUInt16LE(0x0314, 4)              // Version made by (UNIX 2.0)
    cen.writeUInt16LE(20, 6)                  // Version needed (2.0)
    cen.writeUInt16LE(0x0800, 8)              // General purpose flag (UTF-8)
    cen.writeUInt16LE(0, 10)                  // Compression method (Store)
    cen.writeUInt16LE(DOS_TIME, 12)           // Last mod time
    cen.writeUInt16LE(DOS_DATE, 14)           // Last mod date
    cen.writeUInt32LE(crc, 16)                // CRC-32
    cen.writeUInt32LE(data.length, 20)        // Compressed size
    cen.writeUInt32LE(data.length, 24)        // Uncompressed size
    cen.writeUInt16LE(nameBytes.length, 28)   // File name length
    cen.writeUInt16LE(0, 30)                  // Extra field length
    cen.writeUInt16LE(0, 32)                  // File comment length
    cen.writeUInt16LE(0, 34)                  // Disk number start
    cen.writeUInt16LE(0, 36)                  // Internal file attributes
    cen.writeUInt32LE(((0o100644 << 16) | 0x20) >>> 0, 38) // External attrs (POSIX rw-r--r-- + DOS archive)
    cen.writeUInt32LE(offset, 42)             // Relative offset of LFH
    central.push(cen, nameBytes)

    offset += 30 + nameBytes.length + data.length
  }

  let cenSize = 0
  for (const c of central) cenSize += c.length

  // End of Central Directory Record (22 bytes)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)           // Signature
  eocd.writeUInt16LE(0, 4)                    // Disk number
  eocd.writeUInt16LE(0, 6)                    // Disk with start of central dir
  eocd.writeUInt16LE(files.length, 8)         // Records on this disk
  eocd.writeUInt16LE(files.length, 10)        // Total records
  eocd.writeUInt32LE(cenSize, 12)             // Size of central directory
  eocd.writeUInt32LE(offset, 16)              // Offset of central directory
  eocd.writeUInt16LE(0, 20)                   // Comment length

  return Buffer.concat([...chunks, ...central, eocd])
}

/**
 * Largest single file the market can serve: Cloudflare Workers static assets
 * reject any asset above 25 MiB, and every skin archive rides that same tree.
 * rainy-night was re-baked to 16.97 MB and shuimo-danqing was kept at 21.03 MiB
 * to stay under it.
 */
const MAX_SERVED_ASSET_BYTES = 25 * 1024 * 1024

/**
 * Store-method archive for one skin, or null when the archive would exceed the
 * served-asset cap. Null is not a failure: the installer reads the manifest file
 * list and downloads the skin file by file, and every one of those files stays
 * under the per-file cap, so the skin still installs — it just ships without a
 * one-archive download.
 */
function zipSkinArchive(entries, maxBytes = MAX_SERVED_ASSET_BYTES) {
  const bytes = zipStore(entries)
  return bytes.length > maxBytes ? null : bytes
}

module.exports = { zipStore, zipSkinArchive, MAX_SERVED_ASSET_BYTES }
