/**
 * dsh-portable — a small, dependency-free POSIX tar (ustar + PAX) codec.
 *
 * Why tar rather than zip: a DSH profile's node_modules is a pnpm tree that may
 * contain directory junctions. tar carries symlinks as first-class entries
 * (typeflag '2'), so a package made on one machine restores the same shape on
 * another; zip would need unix external attributes that most JS writers do not
 * emit. gzip comes from node:zlib, so the plugin keeps zero runtime
 * dependencies and can be installed from a local tarball on an offline machine.
 *
 * Scope: regular files, directories, symlinks, PAX path records for long or
 * non-ASCII names, and a checksum on every header. Device nodes and FIFOs are
 * refused on write and skipped on read.
 */

const BLOCK = 512
const ZERO_BLOCK = Buffer.alloc(BLOCK)
const UTF8 = 'utf8'

function byteLength(text) {
  return Buffer.byteLength(text, UTF8)
}

/** Encode a number as a right-aligned octal field, falling back to base-256. */
function octalField(value, length) {
  const n = Math.max(0, Math.floor(value))
  const text = n.toString(8)
  if (text.length <= length - 1) return Buffer.from(text.padStart(length - 1, '0') + '\0', 'ascii')
  const buf = Buffer.alloc(length)
  let remaining = n
  for (let i = length - 1; i >= 0 && remaining > 0; i -= 1) {
    buf[i] = remaining % 256
    remaining = Math.floor(remaining / 256)
  }
  buf[0] |= 0x80
  return buf
}

function writeString(buffer, offset, length, value) {
  const bytes = Buffer.from(String(value), UTF8)
  bytes.copy(buffer, offset, 0, Math.min(bytes.length, length))
}

function readString(buffer, offset, length) {
  let end = offset
  const limit = offset + length
  while (end < limit && buffer[end] !== 0) end += 1
  return buffer.toString(UTF8, offset, end)
}

function readNumber(buffer, offset, length) {
  if ((buffer[offset] & 0x80) !== 0) {
    let value = buffer[offset] & 0x7f
    for (let i = 1; i < length; i += 1) value = value * 256 + buffer[offset + i]
    return value
  }
  const text = buffer.toString('ascii', offset, offset + length).split('\0')[0].trim()
  if (text.length === 0) return 0
  const parsed = Number.parseInt(text, 8)
  return Number.isNaN(parsed) ? 0 : parsed
}

/** Build a 512-byte ustar header, checksum included. */
function buildHeader({ name, prefix = '', mode, size, mtimeSeconds, typeflag, linkname = '' }) {
  const header = Buffer.alloc(BLOCK)
  writeString(header, 0, 100, name)
  octalField(mode, 8).copy(header, 100)
  octalField(0, 8).copy(header, 108)
  octalField(0, 8).copy(header, 116)
  octalField(size, 12).copy(header, 124)
  octalField(mtimeSeconds, 12).copy(header, 136)
  header.write('        ', 148, 8, 'ascii')
  header.write(typeflag, 156, 1, 'ascii')
  if (linkname.length > 0) writeString(header, 157, 100, linkname)
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  writeString(header, 265, 32, 'dsh-portable')
  writeString(header, 297, 32, 'dsh-portable')
  octalField(0, 8).copy(header, 329)
  octalField(0, 8).copy(header, 337)
  if (prefix.length > 0) writeString(header, 345, 155, prefix)

  let sum = 0
  for (let i = 0; i < BLOCK; i += 1) sum += header[i]
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return header
}

/** Fit a path into ustar name(100)/prefix(155); null when a PAX record is needed. */
function splitUstarPath(relativePath) {
  if (byteLength(relativePath) <= 100) return { name: relativePath, prefix: '' }
  const segments = relativePath.split('/')
  for (let i = segments.length - 1; i > 0; i -= 1) {
    const tail = segments.slice(i).join('/')
    const head = segments.slice(0, i).join('/')
    if (byteLength(tail) <= 100 && byteLength(head) <= 155) return { name: tail, prefix: head }
  }
  return null
}

/** One PAX extended record: "<total-len> <key>=<value>\n". */
function paxRecord(key, value) {
  const payload = ' ' + key + '=' + value + '\n'
  const payloadBytes = byteLength(payload)
  let digits = 1
  let total = digits + payloadBytes
  while (String(total).length !== digits) {
    digits = String(total).length
    total = digits + payloadBytes
  }
  return String(total) + payload
}

function paddingFor(size) {
  return (BLOCK - (size % BLOCK)) % BLOCK
}

/**
 * Writes tar blocks to an async sink. Each entry is written completely (header,
 * body, padding) before the next one starts, so the byte stream stays ordered
 * without any deferred padding bookkeeping.
 */
export class TarWriter {
  /** @param {(chunk: Buffer) => Promise<void> | void} sink */
  constructor(sink) {
    this.sink = sink
    this.bytesWritten = 0
  }

  async emit(chunk) {
    if (chunk.length === 0) return
    this.bytesWritten += chunk.length
    await this.sink(chunk)
  }

  /** Write a PAX extended header carrying \`path\`, then return nothing. */
  async writePaxPath(relativePath, mtimeSeconds) {
    const body = Buffer.from(paxRecord('path', relativePath), UTF8)
    const label = relativePath.slice(-90).replace(/[\r\n]/g, '_')
    await this.emit(buildHeader({
      name: 'PaxHeaders/' + label, mode: 0o644, size: body.length, mtimeSeconds, typeflag: 'x',
    }))
    await this.emit(body)
    const pad = paddingFor(body.length)
    if (pad > 0) await this.emit(Buffer.alloc(pad))
  }

  /** fallbackName must be <= 100 bytes; it is only a human-readable label. */
  fallbackLabel(relativePath) {
    const base = relativePath.split('/').pop() || 'entry'
    let label = base
    while (byteLength(label) > 100) label = label.slice(0, -1)
    return label.length > 0 ? label : 'entry'
  }

  async addDirectory(relativePath, { mode = 0o755, mtimeSeconds = 0 } = {}) {
    const clean = relativePath.replace(/\/+$/, '')
    if (clean.length === 0) return
    const fit = splitUstarPath(clean)
    if (fit === null) {
      await this.writePaxPath(clean, mtimeSeconds)
      await this.emit(buildHeader({
        name: this.fallbackLabel(clean) + '/', mode, size: 0, mtimeSeconds, typeflag: '5',
      }))
      return
    }
    await this.emit(buildHeader({
      name: fit.name + '/', prefix: fit.prefix, mode, size: 0, mtimeSeconds, typeflag: '5',
    }))
  }

  /**
   * Add one regular file.
   * @param {string} relativePath archive path (POSIX separators)
   * @param {number} size exact byte length of the body
   * @param {AsyncIterable<Buffer>} chunks body chunks, consumed in order
   */
  async addFile(relativePath, size, chunks, { mode = 0o644, mtimeSeconds = 0 } = {}) {
    const fit = splitUstarPath(relativePath)
    if (fit === null) {
      await this.writePaxPath(relativePath, mtimeSeconds)
      await this.emit(buildHeader({
        name: this.fallbackLabel(relativePath), mode, size, mtimeSeconds, typeflag: '0',
      }))
    } else {
      await this.emit(buildHeader({
        name: fit.name, prefix: fit.prefix, mode, size, mtimeSeconds, typeflag: '0',
      }))
    }
    let written = 0
    for await (const chunk of chunks) {
      written += chunk.length
      await this.emit(chunk)
    }
    if (written !== size) {
      throw new Error('size mismatch for ' + relativePath + ': header ' + size + ', body ' + written)
    }
    const pad = paddingFor(size)
    if (pad > 0) await this.emit(Buffer.alloc(pad))
  }

  async addSymlink(relativePath, target, { mtimeSeconds = 0 } = {}) {
    const fit = splitUstarPath(relativePath)
    if (fit === null) {
      await this.writePaxPath(relativePath, mtimeSeconds)
      await this.emit(buildHeader({
        name: this.fallbackLabel(relativePath), mode: 0o777, size: 0, mtimeSeconds,
        typeflag: '2', linkname: target,
      }))
      return
    }
    await this.emit(buildHeader({
      name: fit.name, prefix: fit.prefix, mode: 0o777, size: 0, mtimeSeconds,
      typeflag: '2', linkname: target,
    }))
  }

  async end() {
    await this.emit(ZERO_BLOCK)
    await this.emit(ZERO_BLOCK)
  }
}

function headerChecksumOk(header) {
  const stored = readNumber(header, 148, 8)
  let sum = 0
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : header[i]
  return stored === sum
}

/**
 * Streaming tar parser.
 *
 * \`onEntry(fields)\` is awaited once per real entry. For regular files the parser
 * then calls \`fields.write(chunk)\` for each body chunk and finally
 * \`fields.end()\`. Directory and symlink entries carry their metadata in
 * \`fields\` and are not followed by a body.
 */
export class TarParser {
  constructor(onEntry) {
    this.onEntry = onEntry
    this.mode = 'header'   // header | pax | body | pad
    this.need = BLOCK
    this.acc = Buffer.alloc(0)
    this.remaining = 0
    this.current = null
    this.pax = {}
    this.pendingPaxPath = undefined
    this.finished = false
    this.entriesSeen = 0
  }

  async push(chunk) {
    if (this.finished) return
    let rest = chunk
    while (rest.length > 0) {
      if (this.mode === 'body') {
        const take = Math.min(this.remaining, rest.length)
        if (take > 0) {
          await this.current.write(rest.subarray(0, take))
          this.remaining -= take
          rest = rest.subarray(take)
        }
        if (this.remaining === 0) {
          if (this.current?.end) await this.current.end()
          this.current = null
          const pad = this.padAfterBody
          this.mode = pad > 0 ? 'pad' : 'header'
          this.need = pad > 0 ? pad : BLOCK
          this.acc = Buffer.alloc(0)
        }
        continue
      }

      if (this.mode === 'pad') {
        // Padding can be split across chunks like anything else, so consume it
        // incrementally instead of assuming one chunk covers it all.
        const take = Math.min(this.need, rest.length)
        rest = rest.subarray(take)
        this.need -= take
        if (this.need === 0) {
          this.mode = 'header'
          this.need = BLOCK
        }
        continue
      }

      // header or pax: accumulate exactly \`need\` bytes
      const take = Math.min(this.need - this.acc.length, rest.length)
      if (take > 0) {
        this.acc = this.acc.length === 0 ? rest.subarray(0, take) : Buffer.concat([this.acc, rest.subarray(0, take)])
        rest = rest.subarray(take)
      }
      if (this.acc.length < this.need) continue
      const block = this.acc
      this.acc = Buffer.alloc(0)
      if (this.mode === 'pax') {
        this.parsePax(block)
        // A PAX body is padded to a block boundary exactly like file data; not
        // skipping that padding shifts every following header off its boundary.
        const pad = paddingFor(block.length)
        this.mode = pad > 0 ? 'pad' : 'header'
        this.need = pad > 0 ? pad : BLOCK
        this.acc = Buffer.alloc(0)
        continue
      }
      await this.parseHeader(block)
    }
  }

  parsePax(block) {
    // Records are length-prefixed byte counts, and a value may itself contain
    // '=' or a newline (a long path with unicode, for instance), so they are
    // walked by length rather than split on newlines.
    let offset = 0
    while (offset < block.length) {
      const space = block.indexOf(32, offset)
      if (space < 0) break
      const length = Number(block.toString('ascii', offset, space))
      if (!Number.isFinite(length) || length <= 0 || offset + length > block.length) break
      const record = block.subarray(offset, offset + length)
      const eq = record.indexOf(61)
      if (eq > space - offset) {
        const key = record.toString(UTF8, space - offset + 1, eq)
        const value = record.toString(UTF8, eq + 1).replace(/\n$/, '')
        this.pax[key] = value
      }
      offset += length
    }
  }

  async parseHeader(header) {
    if (header.every((byte) => byte === 0)) {
      this.finished = true
      this.mode = 'header'
      return
    }
    if (!headerChecksumOk(header)) throw new Error('tar header checksum mismatch')
    const typeflag = header.toString('ascii', 156, 157)
    const size = readNumber(header, 124, 12)
    const name = readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const ustarPath = prefix.length > 0 ? prefix + '/' + name : name
    const mode = readNumber(header, 100, 8)
    const mtimeSeconds = readNumber(header, 136, 12)

    if (typeflag === 'x' || typeflag === 'g') {
      if (size > 8 * 1024 * 1024) throw new Error('tar PAX header too large: ' + size)
      this.mode = 'pax'
      this.need = size
      this.acc = Buffer.alloc(0)
      return
    }

    const entryPath = this.pax.path !== undefined ? this.pax.path : ustarPath
    const entryMtime = this.pax.mtime !== undefined ? Math.floor(Number(this.pax.mtime)) : mtimeSeconds
    this.pax = {}

    if (typeflag === '5') {
      this.entriesSeen += 1
      await this.onEntry({
        path: entryPath.replace(/\/+$/, ''), type: 'dir', mode, size: 0, mtimeSeconds: entryMtime,
      })
      this.mode = 'header'
      this.need = BLOCK
      return
    }

    if (typeflag === '2') {
      this.entriesSeen += 1
      await this.onEntry({
        path: entryPath, type: 'symlink', mode, size: 0, mtimeSeconds: entryMtime,
        linkname: readString(header, 157, 100),
      })
      this.mode = 'header'
      this.need = BLOCK
      return
    }

    if (typeflag === '0' || typeflag === '\0' || typeflag === '7') {
      this.entriesSeen += 1
      const fields = {
        path: entryPath, type: 'file', mode, size, mtimeSeconds: entryMtime,
      }
      fields.write = async () => {}
      fields.end = async () => {}
      await this.onEntry(fields)
      this.current = fields
      this.remaining = size
      this.padAfterBody = paddingFor(size)
      if (size === 0) {
        if (fields.end) await fields.end()
        this.current = null
        const pad = this.padAfterBody
        this.mode = pad > 0 ? 'pad' : 'header'
        this.need = pad > 0 ? pad : BLOCK
        return
      }
      this.mode = 'body'
      return
    }

    // Unknown type (device, fifo, ...): skip its body.
    this.entriesSeen += 1
    const padded = size + paddingFor(size)
    this.mode = padded > 0 ? 'pad' : 'header'
    this.need = padded > 0 ? padded : BLOCK
    this.acc = Buffer.alloc(0)
  }

  /** Final flush — throws when the archive ends in the middle of an entry. */
  async finish() {
    if (this.mode === 'body' && this.remaining > 0) throw new Error('tar truncated: ' + this.remaining + ' bytes missing')
  }
}
