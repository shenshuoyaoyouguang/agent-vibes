#!/usr/bin/env node

/**
 * Cursor protocol trace baseline helper.
 *
 * Used by the smoke regression spec
 * (tests/cursor_protocol_full_regression_prompt.md) to:
 *
 *   1. Capture the current trace file size + line count + mtime + the byte
 *      offset of EOF before the smoke run starts (`baseline`).
 *   2. After the smoke run, compare against the baseline and emit a delta
 *      report containing the new line count, byte delta, and a histogram of
 *      `topCase` / `topCase.nestedCase` values for the appended records
 *      (`delta`).
 *   3. Optionally reset the smoke working directory (`reset-smoke`) to the
 *      canonical seed expected by the spec (a.txt=alpha, b.txt=beta, etc).
 *
 * The script is intentionally read-only against the trace file (it never
 * truncates the cumulative file). It only reads the bytes appended after
 * the captured baseline offset, so it works correctly even when other
 * sessions write to the same trace file.
 *
 * Usage:
 *
 *   node scripts/smoke/capture-trace-baseline.js capture
 *   node scripts/smoke/capture-trace-baseline.js delta
 *   node scripts/smoke/capture-trace-baseline.js reset-smoke
 *
 * Resolution order for the trace file (matches CursorProtocolTraceService):
 *   1. $CURSOR_PROTOCOL_TRACE_FILE
 *   2. $AGENT_VIBES_LOG_DIR/cursor_protocol_trace.jsonl
 *   3. $HOME/.agent-vibes/logs/cursor_protocol_trace.jsonl
 *
 * The smoke working dir resolves to:
 *   $AGENT_VIBES_SMOKE_DIR or $HOME/.agent-vibes/smoke
 *
 * Baseline state is persisted to:
 *   $AGENT_VIBES_SMOKE_DIR/.trace-baseline.json (alongside other smoke files
 *   so it never lands in the repo working tree).
 */

const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const readline = require("node:readline")

const REPO_ROOT = path.resolve(__dirname, "..", "..")

function resolveTracePath() {
  if (process.env.CURSOR_PROTOCOL_TRACE_FILE) {
    return path.resolve(process.env.CURSOR_PROTOCOL_TRACE_FILE)
  }
  if (process.env.AGENT_VIBES_LOG_DIR) {
    return path.resolve(
      process.env.AGENT_VIBES_LOG_DIR,
      "cursor_protocol_trace.jsonl"
    )
  }
  return path.resolve(
    os.homedir(),
    ".agent-vibes",
    "logs",
    "cursor_protocol_trace.jsonl"
  )
}

function resolveSmokeDir() {
  return process.env.AGENT_VIBES_SMOKE_DIR
    ? path.resolve(process.env.AGENT_VIBES_SMOKE_DIR)
    : path.resolve(os.homedir(), ".agent-vibes", "smoke")
}

function resolveBridgeLogPath() {
  // Mirrors apps/vscode-extension/src/services/bridge-manager.ts:
  //   path.join(os.tmpdir(), "agent-vibes-bridge.log").
  // Allow override via $BRIDGE_LOG so the smoke prompt and this script agree
  // even on hosts with non-standard tmpdirs.
  if (process.env.BRIDGE_LOG) {
    return path.resolve(process.env.BRIDGE_LOG)
  }
  return path.join(os.tmpdir(), "agent-vibes-bridge.log")
}

function baselineStatePath() {
  return path.join(resolveSmokeDir(), ".trace-baseline.json")
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath)
  } catch {
    return null
  }
}

function isInsideRepo(target) {
  const rel = path.relative(REPO_ROOT, target)
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false
  return true
}

function countLinesSync(filePath) {
  if (!fs.existsSync(filePath)) return 0
  const buf = fs.readFileSync(filePath)
  let n = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) n++
  }
  return n
}

async function readDeltaLines(tracePath, baselineBytes) {
  const stat = safeStat(tracePath)
  if (!stat) return { lines: [], stat: null }
  if (stat.size <= baselineBytes) return { lines: [], stat }
  const fd = fs.openSync(tracePath, "r")
  try {
    const length = stat.size - baselineBytes
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, baselineBytes)
    const text = buffer.toString("utf8")
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    return { lines, stat }
  } finally {
    fs.closeSync(fd)
  }
}

function histogram(values) {
  const counts = new Map()
  for (const v of values) {
    counts.set(v, (counts.get(v) || 0) + 1)
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, count }))
}

function summarizeRecords(lines) {
  const topCases = []
  const nestedCases = []
  const directions = { inbound: 0, outbound: 0, other: 0 }
  let parseErrors = 0
  let firstTs = null
  let lastTs = null
  for (const line of lines) {
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      parseErrors++
      continue
    }
    if (rec.ts) {
      firstTs = firstTs || rec.ts
      lastTs = rec.ts
    }
    if (rec.direction === "inbound") directions.inbound++
    else if (rec.direction === "outbound") directions.outbound++
    else directions.other++
    if (typeof rec.topCase === "string") topCases.push(rec.topCase)
    if (typeof rec.nestedCase === "string") {
      nestedCases.push(`${rec.topCase || "?"}.${rec.nestedCase}`)
    }
  }
  return {
    line_count: lines.length,
    parse_errors: parseErrors,
    first_ts: firstTs,
    last_ts: lastTs,
    direction_counts: directions,
    top_cases: histogram(topCases).slice(0, 25),
    nested_cases: histogram(nestedCases).slice(0, 25),
  }
}

function ensureSmokeDir() {
  const dir = resolveSmokeDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(path.join(dir, "subdir"), { recursive: true })
  return dir
}

function writeIfChanged(target, content) {
  let current = null
  try {
    current = fs.readFileSync(target, "utf8")
  } catch {
    // Missing — write fresh.
  }
  if (current === content) return false
  fs.writeFileSync(target, content, "utf8")
  return true
}

function resetSmokeFixtures() {
  const dir = ensureSmokeDir()
  // Refuse to wipe state if the smoke dir is actually inside the repo —
  // catches misconfigured $AGENT_VIBES_SMOKE_DIR overrides early.
  if (isInsideRepo(dir)) {
    throw new Error(
      `Refusing to reset smoke fixtures: AGENT_VIBES_SMOKE_DIR resolved to a path inside the repo working tree (${dir}). Spec forbids smoke files in repo paths.`
    )
  }
  const ops = []
  ops.push({
    path: path.join(dir, "a.txt"),
    changed: writeIfChanged(path.join(dir, "a.txt"), "alpha"),
  })
  ops.push({
    path: path.join(dir, "b.txt"),
    changed: writeIfChanged(path.join(dir, "b.txt"), "beta"),
  })
  ops.push({
    path: path.join(dir, "delete_me.txt"),
    changed: writeIfChanged(path.join(dir, "delete_me.txt"), "delete"),
  })
  ops.push({
    path: path.join(dir, "todo-seed.md"),
    changed: writeIfChanged(
      path.join(dir, "todo-seed.md"),
      "todo line 1\ntodo line 2\ntodo line 3\n"
    ),
  })
  ops.push({
    path: path.join(dir, "subdir", "nested.txt"),
    changed: writeIfChanged(
      path.join(dir, "subdir", "nested.txt"),
      "nested alpha beta"
    ),
  })
  ops.push({
    path: path.join(dir, "env.txt"),
    changed: writeIfChanged(path.join(dir, "env.txt"), "PLACEHOLDER_ENV=old"),
  })
  // Remove any created_by_test*.txt orphans (stale from previous runs).
  // The smoke prompt's task 3d names new files like
  // `created_by_test_<RUN_ID>.txt` so multiple parallel sessions don't race
  // on a shared filename, and any of those leftovers should also be cleaned.
  for (const entry of fs.readdirSync(dir)) {
    if (
      entry === "created_by_test.txt" ||
      (entry.startsWith("created_by_test_") && entry.endsWith(".txt"))
    ) {
      const orphan = path.join(dir, entry)
      try {
        const stat = fs.statSync(orphan)
        if (stat.isFile()) {
          fs.unlinkSync(orphan)
          ops.push({ path: orphan, changed: true, removed: true })
        }
      } catch {
        // Race with another session — ignore.
      }
    }
  }
  return { dir, ops }
}

function captureCommand() {
  const tracePath = resolveTracePath()
  const stat = safeStat(tracePath)
  const bridgeLogPath = resolveBridgeLogPath()
  const bridgeLogStat = safeStat(bridgeLogPath)
  const baseline = {
    captured_at: new Date().toISOString(),
    // Echo the smoke run id so post-hoc tooling can correlate this baseline
    // with the agent's report. The spec exports SMOKE_RUN_ID before calling
    // capture; if it isn't set we emit null so consumers can detect that
    // RUN_ID-based isolation wasn't used.
    smoke_run_id: process.env.SMOKE_RUN_ID || null,
    smoke_dir: resolveSmokeDir(),
    trace_path: tracePath,
    trace_exists: !!stat,
    bytes: stat ? stat.size : 0,
    line_count: stat ? countLinesSync(tracePath) : 0,
    mtime: stat ? stat.mtime.toISOString() : null,
    // Bridge log offset so smoke prompts can grep only bytes written after
    // baseline capture. Helpful when multiple smoke sessions share the same
    // bridge process (and thus the same global bridge log).
    bridge_log_path: bridgeLogPath,
    bridge_log_exists: !!bridgeLogStat,
    bridge_log_size_bytes: bridgeLogStat ? bridgeLogStat.size : 0,
    bridge_log_mtime: bridgeLogStat ? bridgeLogStat.mtime.toISOString() : null,
  }
  const dir = ensureSmokeDir()
  if (isInsideRepo(dir)) {
    throw new Error(
      `Refusing to capture baseline: AGENT_VIBES_SMOKE_DIR resolved to a path inside the repo (${dir}).`
    )
  }
  if (isInsideRepo(tracePath)) {
    // Surface the contamination in the baseline output so the regression
    // report can flag it as an environment defect, but do not throw — the
    // bridge service guards against this at write-time as well.
    baseline.warning = `trace_path appears to be inside the repo working tree (${tracePath}); the bridge will redirect writes to the canonical default.`
  }
  fs.writeFileSync(baselineStatePath(), JSON.stringify(baseline, null, 2))
  // Emit a compact JSON line for tooling, plus a human-friendly summary.
  process.stdout.write(`${JSON.stringify(baseline)}\n`)
  return 0
}

async function deltaCommand() {
  const baselinePath = baselineStatePath()
  if (!fs.existsSync(baselinePath)) {
    process.stderr.write(
      `[capture-trace-baseline] no baseline at ${baselinePath}; run 'capture' first\n`
    )
    return 1
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"))
  const tracePath = resolveTracePath()
  const stat = safeStat(tracePath)
  const result = {
    baseline,
    final: {
      trace_path: tracePath,
      trace_exists: !!stat,
      bytes: stat ? stat.size : 0,
      line_count: stat ? countLinesSync(tracePath) : 0,
      mtime: stat ? stat.mtime.toISOString() : null,
    },
    delta: {
      bytes: stat ? stat.size - baseline.bytes : 0,
      lines: 0,
      summary: null,
    },
  }
  if (
    stat &&
    baseline.trace_path === tracePath &&
    baseline.trace_exists &&
    stat.size >= baseline.bytes
  ) {
    const { lines } = await readDeltaLines(tracePath, baseline.bytes)
    result.delta.lines = lines.length
    result.delta.summary = summarizeRecords(lines)
  } else if (stat && baseline.trace_path !== tracePath) {
    result.delta.note = `trace_path changed between capture and delta; cannot compute appended-only delta. baseline=${baseline.trace_path} final=${tracePath}`
  } else if (stat && stat.size < baseline.bytes) {
    result.delta.note = `trace file shrank (rotation?); recomputing from start.`
    result.delta.lines = result.final.line_count
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return 0
}

function resetSmokeCommand() {
  const result = resetSmokeFixtures()
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return 0
}

async function main() {
  const cmd = (process.argv[2] || "").trim()
  switch (cmd) {
    case "capture":
      return captureCommand()
    case "delta":
      return deltaCommand()
    case "reset-smoke":
      return resetSmokeCommand()
    case "":
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(
        [
          "usage: capture-trace-baseline.js <command>",
          "",
          "commands:",
          "  capture       record current trace file size/lines/mtime to baseline",
          "  delta         diff baseline against current trace file (JSON report)",
          "  reset-smoke   reset $AGENT_VIBES_SMOKE_DIR to the canonical seed",
          "",
        ].join("\n")
      )
      return 0
    default:
      process.stderr.write(`[capture-trace-baseline] unknown command: ${cmd}\n`)
      return 2
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`[capture-trace-baseline] ${err.stack || err}\n`)
    process.exit(1)
  })
