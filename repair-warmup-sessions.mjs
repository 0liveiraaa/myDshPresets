/**
 * Offline repair for sessions damaged by the old `warmupbetter` /
 * `warmupbetter-replay` presets.
 *
 * The bug: before commit c844c2c, the warmup plugins injected a synthetic
 * `user/message` without an `id`. DeepSeek Harness rejects such events when it
 * restores a persisted session (`seed user/message at index N lacks an
 * identified message`), so every session that ran the old warmup round cannot
 * be loaded again — even after the preset files are updated.
 *
 * This script backfills exactly those events: it scans
 * `<dshHome>/sessions/**\/session.jsonl` and `session.jsonl.zstd`, and for
 * each `user/message` whose `data.source` is a warmup plugin
 * (`warmup-replay` / `warmup-tool-bootstrap`) and whose `data.id` is missing
 * or empty, it inserts `data.id = randomUUID()`. Nothing else is changed.
 *
 * Usage (run while dsh is NOT running):
 *   node repair-warmup-sessions.mjs --dry-run
 *   node repair-warmup-sessions.mjs
 *
 * Options:
 *   --root <dir>     DSH home directory (default: $env:DSH_HOME or ~/.dsh)
 *   --dry-run        Report only; never write
 *   --no-backup      Replace logs without keeping a .bak copy
 *   --plugins <csv>  Plugin names to treat as warmup injectors
 *                    (default: warmup-replay,warmup-tool-bootstrap)
 *
 * The physical format is preserved: for zstd logs the first frame (exactly one
 * header line) is kept byte-for-byte and the patched event rows are written as
 * a new checksummed body frame. Plain `.jsonl` logs are patched in place.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xFD2FB528
const DEFAULT_PLUGINS = ['warmup-replay', 'warmup-tool-bootstrap']

// ── CLI ─────────────────────────────────────────────────────────────────────

const HELP = `repair-warmup-sessions.mjs - backfill missing ids on persisted warmup messages

Usage:
  node repair-warmup-sessions.mjs [--dry-run] [--root <dshHome>] [--no-backup] [--plugins <csv>]

Options:
  --root <dir>     DSH home directory. Defaults to $env:DSH_HOME, then ~/.dsh.
  --dry-run        Scan and report only; never writes.
  --no-backup      Do not keep a timestamped .bak copy before replacing a log.
  --plugins <csv>  Comma-separated plugin names to repair
                   (default: ${DEFAULT_PLUGINS.join(',')}).

Exit dsh completely before running without --dry-run.`

function parseArgs(argv) {
  const options = {
    root: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    dryRun: false,
    backup: true,
    plugins: [...DEFAULT_PLUGINS],
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const value = () => {
      const next = argv[++index]
      if (next === undefined) throw new Error(`${arg} requires a value`)
      return next
    }
    switch (arg) {
      case '-h':
      case '--help':
        console.log(HELP)
        process.exit(0)
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--no-backup':
        options.backup = false
        break
      case '--root':
        options.root = value()
        break
      case '--plugins': {
        const plugins = value().split(',').map(plugin => plugin.trim()).filter(Boolean)
        if (plugins.length === 0) throw new Error('--plugins requires at least one name')
        options.plugins = [...new Set(plugins)]
        break
      }
      default:
        throw new Error(`unknown option: ${arg}\n${HELP}`)
    }
  }
  return options
}

// ── zstd frame helpers ──────────────────────────────────────────────────────

/**
 * Locate complete Zstandard frames in a concatenated-frame container.
 * Mirrors `scanZstdFrames` in dsh-session-persistence-jsonl: a structurally
 * incomplete final frame is reported through `tornStart`.
 */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** Decompress the recoverable prefix of a torn final frame (may be empty). */
function decodeTornPrefix(buffer, start) {
  return zstdDecompressSync(buffer.subarray(start), {
    finishFlush: zlibConstants.ZSTD_e_flush,
  })
}

// ── JSONL helpers ───────────────────────────────────────────────────────────

/**
 * Split frame plaintext into complete JSONL lines. `incompleteTail` is set
 * when the text does not end with a newline (legal only for a torn final
 * frame; that fragment is dropped, matching the harness committed-prefix read).
 */
function completeLines(text) {
  const lines = text.split('\n')
  // The final element is either '' (text ended with a newline) or an
  // incomplete fragment that must be dropped.
  const incompleteTail = lines.at(-1) !== ''
  lines.pop()
  return { lines, incompleteTail }
}

/** Whether one parsed row is an unidentified warmup injection. */
function missingWarmupId(record, plugins) {
  if (record?.type !== 'user/message') return false
  const data = record.data
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false
  if (typeof data.id === 'string' && data.id !== '') return false
  const source = data.source
  return (
    typeof source === 'object' && source !== null
    && source.kind === 'plugin'
    && plugins.has(source.plugin)
  )
}

// ── log inspection / rewrite ────────────────────────────────────────────────

/**
 * Parse one stored log into `headerText`, ordered complete body lines, and a
 * per-line parse object. Throws for corruption this script must not rewrite.
 */
function readLog(file, buffer) {
  const bodyLines = []
  const skipped = []

  if (file.endsWith('.zstd')) {
    const { frames, tornStart } = scanZstdFrames(buffer)
    if (frames.length === 0) throw new Error('no complete zstd frames')
    const headerFrame = buffer.subarray(frames[0].start, frames[0].end)
    const headerText = zstdDecompressSync(headerFrame).toString('utf8')
    if (headerText.indexOf('\n') !== headerText.length - 1
      || headerText.slice(0, -1).includes('\n')) {
      throw new Error('first frame does not hold exactly one header line')
    }

    for (const frame of frames.slice(1)) {
      const text = zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
      const { lines, incompleteTail } = completeLines(text)
      if (incompleteTail) throw new Error('complete frame contains a torn JSONL record')
      for (const line of lines) bodyLines.push(line)
    }

    let tornDropped = 0
    if (tornStart !== undefined) {
      let recovered
      try {
        recovered = decodeTornPrefix(buffer, tornStart).toString('utf8')
      } catch {
        throw new Error('torn final frame cannot be decoded; refusing to rewrite (open the session once in dsh to let it repair)')
      }
      const { lines, incompleteTail } = completeLines(recovered)
      if (incompleteTail) tornDropped += 1
      for (const line of lines) bodyLines.push(line)
      if (tornDropped > 0) skipped.push(`dropped ${tornDropped} incomplete torn record(s)`)
    }

    return { headerBytes: headerFrame, bodyLines, skipped }
  }

  // Plaintext JSONL: first line is the header, the rest are event rows.
  const firstNewline = buffer.indexOf(0x0a)
  if (firstNewline <= 0) throw new Error('missing header line')
  const headerText = buffer.subarray(0, firstNewline).toString('utf8')
  const { lines, incompleteTail } = completeLines(buffer.subarray(firstNewline + 1).toString('utf8'))
  if (incompleteTail) skipped.push(`dropped ${1} incomplete final record(s)`)
  for (const line of lines) bodyLines.push(line)
  return { headerText, bodyLines, skipped }
}

/** Patch warmup rows in place; returns the rows that were repaired. */
function patchBodyLines(bodyLines, plugins, skipped) {
  const patched = []
  for (let index = 0; index < bodyLines.length; index++) {
    let record
    try {
      record = JSON.parse(bodyLines[index])
    } catch {
      skipped.push(`unparsable JSONL row at body line ${index + 1}`)
      return undefined
    }
    if (!missingWarmupId(record, plugins)) continue
    record.data.id = randomUUID()
    bodyLines[index] = JSON.stringify(record)
    patched.push({
      seq: typeof record.seq === 'number' ? record.seq : undefined,
      plugin: record.data.source.plugin,
    })
  }
  return patched
}

/** Replace one log atomically, keeping a .bak unless disabled. */
function writeLog(file, output, keepBackup) {
  if (keepBackup) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    let backup = `${file}.${stamp}.bak`
    if (existsSync(backup)) backup = `${backup}.${randomBytes(2).toString('hex')}`
    copyFileSync(file, backup)
  }
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      writeFileSync(fd, output)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

// ── main ────────────────────────────────────────────────────────────────────

function* sessionLogs(sessionsDir) {
  const stack = [sessionsDir]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(file)
      else if (entry.isFile()
        && (entry.name === 'session.jsonl' || entry.name === 'session.jsonl.zstd')) {
        yield file
      }
    }
  }
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
    return
  }
  const plugins = new Set(options.plugins)
  const sessionsDir = path.join(options.root, 'sessions')
  if (!existsSync(sessionsDir)) {
    console.error(`sessions directory not found: ${sessionsDir}`)
    process.exitCode = 1
    return
  }
  if (!options.dryRun) {
    console.warn(`WARNING: repairing ${sessionsDir}. Make sure every dsh process is fully stopped first.`)
  }

  let scanned = 0
  let affectedFiles = 0
  let repairedEvents = 0
  let repairedFiles = 0
  let skippedFiles = 0

  for (const file of sessionLogs(sessionsDir)) {
    scanned += 1
    const label = path.relative(sessionsDir, file)
    let read
    try {
      read = readLog(file, readFileSync(file))
    } catch (error) {
      skippedFiles += 1
      console.warn(`SKIP ${label}: ${error.message}`)
      continue
    }

    const patched = patchBodyLines(read.bodyLines, plugins, read.skipped)
    if (patched === undefined) {
      skippedFiles += 1
      console.warn(`SKIP ${label}: ${read.skipped.at(-1)}`)
      continue
    }
    for (const note of read.skipped) console.warn(`NOTE ${label}: ${note}`)

    if (patched.length === 0) continue
    affectedFiles += 1
    repairedEvents += patched.length
    const detail = patched.map(row => `seq ${row.seq} plugin ${row.plugin}`).join(', ')
    console.log(`FOUND ${label}: ${patched.length} warmup message(s) missing id (${detail})`)
    if (options.dryRun) continue

    let output
    if (file.endsWith('.zstd')) {
      const body = read.bodyLines.join('\n') + (read.bodyLines.length > 0 ? '\n' : '')
      const bodyFrame = zstdCompressSync(Buffer.from(body, 'utf8'), {
        params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 },
      })
      output = Buffer.concat([read.headerBytes, bodyFrame])
    } else {
      output = Buffer.from(
        `${read.headerText}\n${read.bodyLines.join('\n')}${read.bodyLines.length > 0 ? '\n' : ''}`,
        'utf8',
      )
    }
    try {
      writeLog(file, output, options.backup)
    } catch (error) {
      console.error(`REPAIR FAILED ${label}: ${error.message}`)
      process.exitCode = 1
      continue
    }
    repairedFiles += 1
    console.log(`REPAIRED ${label} (${patched.length} event(s); backup: ${options.backup ? 'yes' : 'no'})`)

    // Re-open the replacement and make sure no matching bad row survived.
    let verified
    try {
      verified = readLog(file, readFileSync(file))
    } catch (error) {
      console.error(`VERIFY FAILED ${label}: ${error.message}`)
      process.exitCode = 1
      continue
    }
    const remaining = patchBodyLines(verified.bodyLines, plugins, verified.skipped)
    if (remaining === undefined) {
      console.error(`VERIFY FAILED ${label}: ${verified.skipped.at(-1)}`)
      process.exitCode = 1
    } else if (remaining.length > 0) {
      console.error(`VERIFY FAILED ${label}: ${remaining.length} warmup message(s) still lack an id`)
      process.exitCode = 1
    }
  }

  console.log(
    `SUMMARY scanned=${scanned} affectedFiles=${affectedFiles} repairedEvents=${repairedEvents} `
    + `repairedFiles=${repairedFiles} skippedFiles=${skippedFiles} mode=${options.dryRun ? 'dry-run' : 'repair'}`,
  )
}

main()
