/**
 * Minimal ZIP container for rule bundles. Bundles hold a handful of small
 * YAML/JSON files, so archives are written uncompressed (`store`) and no
 * compression dependency is pulled in; reading still accepts `deflate` so
 * bundles produced by the Android client remain importable.
 */

const LOCAL_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_HEADER_SIGNATURE = 0x02014b50
const END_OF_CENTRAL_DIR_SIGNATURE = 0x06054b50

const LOCAL_HEADER_SIZE = 30
const CENTRAL_HEADER_SIZE = 46
const END_OF_CENTRAL_DIR_SIZE = 22

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/** ZIP requires a DOS timestamp; a fixed epoch keeps archives byte-reproducible. */
const DOS_EPOCH_TIME = 0
const DOS_EPOCH_DATE = 0x0021

export class ZipFormatError extends Error {}

export interface ZipEntry {
  name: string
  data: Uint8Array
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let value = i
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[i] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })

export function encodeUtf8(text: string): Uint8Array {
  return textEncoder.encode(text)
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return textDecoder.decode(bytes)
  } catch {
    throw new ZipFormatError('entry is not valid UTF-8 text')
  }
}

export async function createZipArchive(
  entries: ZipEntry[],
): Promise<Uint8Array> {
  const localChunks: Uint8Array[] = []
  const centralChunks: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = textEncoder.encode(entry.name)
    const checksum = crc32(entry.data)

    const localHeader = new Uint8Array(LOCAL_HEADER_SIZE + nameBytes.length)
    const localView = new DataView(localHeader.buffer)
    localView.setUint32(0, LOCAL_HEADER_SIGNATURE, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(6, 0, true)
    localView.setUint16(8, METHOD_STORE, true)
    localView.setUint16(10, DOS_EPOCH_TIME, true)
    localView.setUint16(12, DOS_EPOCH_DATE, true)
    localView.setUint32(14, checksum, true)
    localView.setUint32(18, entry.data.length, true)
    localView.setUint32(22, entry.data.length, true)
    localView.setUint16(26, nameBytes.length, true)
    localView.setUint16(28, 0, true)
    localHeader.set(nameBytes, LOCAL_HEADER_SIZE)

    const centralHeader = new Uint8Array(CENTRAL_HEADER_SIZE + nameBytes.length)
    const centralView = new DataView(centralHeader.buffer)
    centralView.setUint32(0, CENTRAL_HEADER_SIGNATURE, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(8, 0, true)
    centralView.setUint16(10, METHOD_STORE, true)
    centralView.setUint16(12, DOS_EPOCH_TIME, true)
    centralView.setUint16(14, DOS_EPOCH_DATE, true)
    centralView.setUint32(16, checksum, true)
    centralView.setUint32(20, entry.data.length, true)
    centralView.setUint32(24, entry.data.length, true)
    centralView.setUint16(28, nameBytes.length, true)
    centralView.setUint16(30, 0, true)
    centralView.setUint16(32, 0, true)
    centralView.setUint16(34, 0, true)
    centralView.setUint16(36, 0, true)
    centralView.setUint32(38, 0, true)
    centralView.setUint32(42, offset, true)
    centralHeader.set(nameBytes, CENTRAL_HEADER_SIZE)

    localChunks.push(localHeader, entry.data)
    centralChunks.push(centralHeader)
    offset += localHeader.length + entry.data.length
  }

  const centralSize = centralChunks.reduce(
    (total, chunk) => total + chunk.length,
    0,
  )
  const endRecord = new Uint8Array(END_OF_CENTRAL_DIR_SIZE)
  const endView = new DataView(endRecord.buffer)
  endView.setUint32(0, END_OF_CENTRAL_DIR_SIGNATURE, true)
  endView.setUint16(4, 0, true)
  endView.setUint16(6, 0, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, offset, true)
  endView.setUint16(20, 0, true)

  const chunks = [...localChunks, ...centralChunks, endRecord]
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const archive = new Uint8Array(total)
  let cursor = 0
  for (const chunk of chunks) {
    archive.set(chunk, cursor)
    cursor += chunk.length
  }
  return archive
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new ZipFormatError('deflate entries need DecompressionStream support')
  }
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
  try {
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    throw new ZipFormatError('failed to inflate a deflate entry')
  }
}

function findEndOfCentralDir(view: DataView): number {
  const minimum = Math.max(
    0,
    view.byteLength - 0xffff - END_OF_CENTRAL_DIR_SIZE,
  )
  for (let i = view.byteLength - END_OF_CENTRAL_DIR_SIZE; i >= minimum; i--) {
    if (view.getUint32(i, true) === END_OF_CENTRAL_DIR_SIGNATURE) return i
  }
  return -1
}

/**
 * Entries are located through the central directory rather than by scanning
 * local headers, so archives whose local headers defer sizes to a data
 * descriptor still read correctly.
 */
export async function readZipArchive(bytes: Uint8Array): Promise<ZipEntry[]> {
  if (bytes.length < END_OF_CENTRAL_DIR_SIZE) {
    throw new ZipFormatError('file is too small to be a zip archive')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const endOffset = findEndOfCentralDir(view)
  if (endOffset < 0) {
    throw new ZipFormatError('no zip end-of-central-directory record found')
  }

  const entryCount = view.getUint16(endOffset + 10, true)
  let cursor = view.getUint32(endOffset + 16, true)
  const entries: ZipEntry[] = []

  for (let i = 0; i < entryCount; i++) {
    if (
      cursor + CENTRAL_HEADER_SIZE > bytes.length ||
      view.getUint32(cursor, true) !== CENTRAL_HEADER_SIGNATURE
    ) {
      throw new ZipFormatError('malformed zip central directory')
    }
    const method = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const uncompressedSize = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const name = decodeUtf8(
      bytes.subarray(
        cursor + CENTRAL_HEADER_SIZE,
        cursor + CENTRAL_HEADER_SIZE + nameLength,
      ),
    )
    cursor += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength

    if (name.endsWith('/')) continue

    if (
      localOffset + LOCAL_HEADER_SIZE > bytes.length ||
      view.getUint32(localOffset, true) !== LOCAL_HEADER_SIGNATURE
    ) {
      throw new ZipFormatError(`malformed local header for entry ${name}`)
    }
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataStart =
      localOffset + LOCAL_HEADER_SIZE + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > bytes.length) {
      throw new ZipFormatError(`entry ${name} extends past the archive end`)
    }
    const raw = bytes.subarray(dataStart, dataEnd)

    let data: Uint8Array
    if (method === METHOD_STORE) {
      data = raw
    } else if (method === METHOD_DEFLATE) {
      data = await inflateRaw(raw)
    } else {
      throw new ZipFormatError(
        `entry ${name} uses unsupported compression method ${method}`,
      )
    }
    if (method === METHOD_STORE && data.length !== uncompressedSize) {
      throw new ZipFormatError(`entry ${name} has an inconsistent size`)
    }

    entries.push({ name, data })
  }

  return entries
}
