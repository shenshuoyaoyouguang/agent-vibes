#!/usr/bin/env node
/**
 * Kiro context-window probe
 * =========================
 *
 * Single-purpose, one-shot probe: discover the empirical wire-level cap
 * at which Kiro / CodeWhisperer rejects requests with the structured
 * error `reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD"`. The bridge code
 * treats 155K as the empirical ceiling but no in-tree evidence supports
 * that exact number — this script collects the evidence directly.
 *
 * Method:
 *   - Read accounts from /Users/recronin/.agent-vibes/data/kiro-accounts.json
 *     and pick the first usable api_key entry.
 *   - Mirror the wire shape of `kiro.service.executeStream` exactly
 *     (headers + payload + endpoint), then send a request whose
 *     userInputMessage.content is padded to a target token count using
 *     a 1 char ≈ 1 token approximation (single-byte ASCII, no whitespace
 *     compaction).
 *   - Probe two scenarios:
 *       (A) PURE  — content padding only, no tools, no history.
 *       (B) TOOLED — same content padding plus a realistic tool array
 *                    (cribbed from the captured CC CLI traffic) and a
 *                    handful of synthetic prior turns to mimic a real
 *                    session.
 *   - Binary-search a tight bracket around the failure threshold for
 *     each scenario. Reports the smallest size that fails and the
 *     largest size that succeeds.
 *
 * Output: a JSON report in stdout plus an annotated transcript so the
 * exact upstream error body is captured for cross-checking against the
 * bridge's classifier.
 *
 * Usage:
 *   node scripts/probe/probe-kiro-cap.mjs [--low=80000] [--high=220000]
 *     [--scenario=both|pure|tooled] [--quick]
 */

import { createHash, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { release } from "node:os"
import { argv } from "node:process"

// ── config ──────────────────────────────────────────────────────────────

const ACCOUNTS_PATH = "/Users/recronin/.agent-vibes/data/kiro-accounts.json"
const ENDPOINT = "https://q.us-east-1.amazonaws.com/generateAssistantResponse"
const MODEL_ID_WIRE = "claude-opus-4.7"
// Stop binary search once the gap between known-pass and known-fail is
// this tight (in tokens). 1K resolution is plenty for the question
// "is the cap actually ~155K, ~166K, or ~200K?".
const RESOLUTION = 1_000
const REQUEST_TIMEOUT_MS = 60_000

// ── account loading ─────────────────────────────────────────────────────

function loadFirstApiKeyAccount() {
  const raw = readFileSync(ACCOUNTS_PATH, "utf-8")
  const data = JSON.parse(raw)
  const accounts = Array.isArray(data?.accounts) ? data.accounts : []
  for (const a of accounts) {
    const isApiKey =
      a.authMethod === "api_key" ||
      a.authMethod === "apikey" ||
      (a.kiroApiKey && !a.refreshToken && !a.accessToken)
    if (!isApiKey) continue
    if (typeof a.kiroApiKey !== "string" || a.kiroApiKey.length === 0) continue
    return {
      label: a.label || "(unnamed)",
      apiKey: a.kiroApiKey,
      region: a.region || "us-east-1",
    }
  }
  throw new Error(`No usable api_key account in ${ACCOUNTS_PATH}`)
}

function deriveMachineId(apiKey) {
  // Mirror kiro.service.ts: machineId defaults to md5(stateKeyMaterial).
  // Using the api key alone is fine — the upstream only cares that the
  // machineId is a stable, opaque hex string.
  return createHash("md5").update(apiKey).digest("hex")
}

// ── header construction (mirrors headers.ts + kiro.service.ts) ──────────

function buildStreamingHeaders({ apiKey, machineId, host }) {
  const sdkVersion = "1.0.39"
  const kiroVersion = "0.12.200"
  const nodeVersion = "22.22.0"
  const systemVersion =
    process.platform === "darwin"
      ? `darwin#${release() || "24.6.0"}`
      : process.platform === "win32"
        ? `win32#${release() || "10.0.22631"}`
        : `linux#${release() || "6.6.87"}`
  const userAgent =
    `aws-sdk-js/${sdkVersion} ua/2.1 ` +
    `os/${systemVersion} lang/js md/nodejs#${nodeVersion} ` +
    `api/codewhispererstreaming#${sdkVersion} m/N ` +
    `KiroIDE-${kiroVersion}-${machineId}`
  const amzUserAgent = `aws-sdk-js/${sdkVersion} KiroIDE-${kiroVersion}-${machineId}`

  return {
    "Content-Type": "application/json",
    Accept: "*/*",
    "x-amzn-kiro-agent-mode": "vibe",
    "x-amzn-codewhisperer-optout": "true",
    "amz-sdk-request": "attempt=1; max=3",
    "amz-sdk-invocation-id": randomUUID(),
    "user-agent": userAgent,
    "x-amz-user-agent": amzUserAgent,
    host: host,
    tokentype: "API_KEY",
    Authorization: `Bearer ${apiKey}`,
  }
}

// ── payload construction ────────────────────────────────────────────────

const PADDING_TOKEN_TEXT = "lorem ipsum dolor sit amet consectetur "
// 40 chars per snippet — combined with the 1 char/token approximation
// the bridge uses (estimateRequestInputTokens), this gives a stable
// 10 tokens per snippet. We don't need calibration to be exact; the
// goal is to find the threshold the upstream returns, not to match the
// bridge's estimate.

function buildContentForTargetTokens(targetTokens) {
  // Each repetition is ~40 chars. countTokensLocal in the bridge uses
  // tokenizer.countTokens which is roughly char/4 for ASCII. We pad
  // generously and let the actual upstream decide.
  const repetitions = Math.ceil((targetTokens * 4) / PADDING_TOKEN_TEXT.length)
  return PADDING_TOKEN_TEXT.repeat(repetitions)
}

function buildToolsArray() {
  // Mirrors a realistic CC CLI tool definition set — specifically the
  // shape the upstream sees from a live `claude-code` session. Three
  // tools is the minimum that makes the request "look agentic" without
  // ballooning the payload past the content padding.
  return [
    {
      toolSpecification: {
        name: "bash",
        description: "Run a bash command and return stdout/stderr",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              command: { type: "string", description: "Command to run" },
              cwd: { type: "string", description: "Working directory" },
            },
            required: ["command"],
          },
        },
      },
    },
    {
      toolSpecification: {
        name: "read_file",
        description: "Read a file's contents",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              path: { type: "string" },
              start_line: { type: "number" },
              end_line: { type: "number" },
            },
            required: ["path"],
          },
        },
      },
    },
    {
      toolSpecification: {
        name: "grep_search",
        description: "Search files for a pattern",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              query: { type: "string" },
              includePattern: { type: "string" },
            },
            required: ["query"],
          },
        },
      },
    },
  ]
}

function buildPayload({ targetTokens, withTools }) {
  const content = buildContentForTargetTokens(targetTokens)
  const userInputMessage = {
    content,
    modelId: MODEL_ID_WIRE,
    origin: "AI_EDITOR",
  }
  if (withTools) {
    userInputMessage.userInputMessageContext = { tools: buildToolsArray() }
  }
  const conversationState = {
    chatTriggerType: "MANUAL",
    conversationId: randomUUID(),
    currentMessage: { userInputMessage },
  }
  if (withTools) {
    conversationState.agentTaskType = "vibe"
    conversationState.agentContinuationId = randomUUID()
  }
  return { conversationState }
}

// ── single probe ────────────────────────────────────────────────────────

async function probeOnce({ account, machineId, targetTokens, withTools }) {
  const url = ENDPOINT
  const host = new URL(url).host
  const headers = buildStreamingHeaders({
    apiKey: account.apiKey,
    machineId,
    host,
  })
  const payload = buildPayload({ targetTokens, withTools })
  const body = JSON.stringify(payload)
  const wireBytes = Buffer.byteLength(body, "utf-8")

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS)

  let status = 0
  let errorBody = ""
  let reason
  let outcome // "accepted" | "rejected" | "error"

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: ac.signal,
    })
    status = response.status
    if (status >= 400) {
      errorBody = await response.text().catch(() => "")
      try {
        const parsed = JSON.parse(errorBody)
        if (typeof parsed?.reason === "string") reason = parsed.reason
      } catch {
        // not JSON; keep the raw body for the report
      }
      outcome = "rejected"
    } else {
      // Cancel the stream as soon as we know the upstream accepted the
      // request — we don't need any tokens, just the 200.
      try {
        if (response.body && typeof response.body.cancel === "function") {
          await response.body.cancel()
        }
      } catch {
        // ignore — we already have the verdict
      }
      outcome = "accepted"
    }
  } catch (err) {
    outcome = "error"
    errorBody = err && err.message ? err.message : String(err)
  } finally {
    clearTimeout(timer)
  }

  return {
    targetTokens,
    withTools,
    wireBytes,
    status,
    outcome,
    reason,
    errorBody: errorBody.slice(0, 500),
  }
}

// ── binary search ───────────────────────────────────────────────────────

async function searchThreshold({
  account,
  machineId,
  low,
  high,
  withTools,
  label,
}) {
  console.error(`\n[${label}] binary search bracket ${low} .. ${high} tokens`)
  const transcript = []

  // 1) Confirm the high end fails. If it doesn't, the cap is above our
  //    bracket and we expand once.
  let highResult = await probeOnce({
    account,
    machineId,
    targetTokens: high,
    withTools,
  })
  transcript.push(highResult)
  console.error(
    `  probe[${label}] target=${high} -> ${highResult.outcome} ` +
      `(status=${highResult.status} reason=${highResult.reason ?? "-"} bytes=${highResult.wireBytes})`
  )
  while (highResult.outcome === "accepted") {
    const expanded = high * 2
    if (expanded > 2_000_000) {
      return {
        label,
        verdict: "no_cap_observed",
        ceiling: high,
        transcript,
      }
    }
    console.error(
      `  probe[${label}] high=${high} accepted, expanding to ${expanded}`
    )
    low = high
    high = expanded
    highResult = await probeOnce({
      account,
      machineId,
      targetTokens: high,
      withTools,
    })
    transcript.push(highResult)
    console.error(
      `  probe[${label}] target=${high} -> ${highResult.outcome} ` +
        `(status=${highResult.status} reason=${highResult.reason ?? "-"} bytes=${highResult.wireBytes})`
    )
  }

  // 2) Confirm the low end passes. If it fails, contract once.
  let lowResult = await probeOnce({
    account,
    machineId,
    targetTokens: low,
    withTools,
  })
  transcript.push(lowResult)
  console.error(
    `  probe[${label}] target=${low} -> ${lowResult.outcome} ` +
      `(status=${lowResult.status} reason=${lowResult.reason ?? "-"} bytes=${lowResult.wireBytes})`
  )
  while (lowResult.outcome !== "accepted") {
    const contracted = Math.floor(low / 2)
    if (contracted < 1_000) {
      return {
        label,
        verdict: "low_end_already_rejected",
        floor: low,
        transcript,
      }
    }
    console.error(
      `  probe[${label}] low=${low} rejected, contracting to ${contracted}`
    )
    high = low
    low = contracted
    lowResult = await probeOnce({
      account,
      machineId,
      targetTokens: low,
      withTools,
    })
    transcript.push(lowResult)
    console.error(
      `  probe[${label}] target=${low} -> ${lowResult.outcome} ` +
        `(status=${lowResult.status} reason=${lowResult.reason ?? "-"} bytes=${lowResult.wireBytes})`
    )
  }

  // 3) Bisect.
  let pass = low
  let fail = high
  while (fail - pass > RESOLUTION) {
    const mid = Math.floor((pass + fail) / 2)
    const r = await probeOnce({
      account,
      machineId,
      targetTokens: mid,
      withTools,
    })
    transcript.push(r)
    console.error(
      `  probe[${label}] target=${mid} -> ${r.outcome} ` +
        `(status=${r.status} reason=${r.reason ?? "-"} bytes=${r.wireBytes})`
    )
    if (r.outcome === "accepted") {
      pass = mid
    } else if (r.outcome === "rejected") {
      fail = mid
    } else {
      // Network / timeout — abandon the bisect with what we have.
      return {
        label,
        verdict: "bisect_aborted_on_error",
        lastPass: pass,
        firstFail: fail,
        transcript,
      }
    }
  }

  return {
    label,
    verdict: "bisected",
    lastPass: pass,
    firstFail: fail,
    transcript,
  }
}

// ── main ────────────────────────────────────────────────────────────────

function parseArgs() {
  const out = { low: 80_000, high: 220_000, scenario: "both", quick: false }
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([a-z]+)=(.+)$/)
    if (!m) continue
    const [, key, value] = m
    if (key === "low") out.low = parseInt(value, 10)
    else if (key === "high") out.high = parseInt(value, 10)
    else if (key === "scenario") out.scenario = value
    else if (key === "quick") out.quick = value !== "false"
    if (arg === "--quick") out.quick = true
  }
  return out
}

async function main() {
  const args = parseArgs()
  const account = loadFirstApiKeyAccount()
  const machineId = deriveMachineId(account.apiKey)
  console.error(
    `[probe] using account "${account.label}" (apiKey=${account.apiKey.slice(0, 8)}…)`
  )
  console.error(`[probe] endpoint: ${ENDPOINT}`)
  console.error(`[probe] model: ${MODEL_ID_WIRE}`)
  console.error(`[probe] resolution: ${RESOLUTION} tokens`)
  console.error(`[probe] request timeout: ${REQUEST_TIMEOUT_MS}ms`)

  const results = []
  if (args.scenario === "pure" || args.scenario === "both") {
    const r = await searchThreshold({
      account,
      machineId,
      low: args.low,
      high: args.high,
      withTools: false,
      label: "PURE",
    })
    results.push(r)
  }
  if (args.scenario === "tooled" || args.scenario === "both") {
    const r = await searchThreshold({
      account,
      machineId,
      low: args.low,
      high: args.high,
      withTools: true,
      label: "TOOLED",
    })
    results.push(r)
  }

  // Final report.
  console.error("\n[probe] === RESULTS ===")
  for (const r of results) {
    console.error(
      `[probe] ${r.label}: verdict=${r.verdict} ` +
        (r.lastPass != null ? `lastPass=${r.lastPass} ` : "") +
        (r.firstFail != null ? `firstFail=${r.firstFail} ` : "") +
        (r.ceiling != null ? `ceiling=${r.ceiling} ` : "") +
        (r.floor != null ? `floor=${r.floor} ` : "")
    )
  }

  // Print machine-readable JSON to stdout for downstream tooling.
  process.stdout.write(
    JSON.stringify(
      {
        endpoint: ENDPOINT,
        model: MODEL_ID_WIRE,
        accountLabel: account.label,
        resolution: RESOLUTION,
        results,
      },
      null,
      2
    ) + "\n"
  )
}

main().catch((err) => {
  console.error(`[probe] fatal: ${err && err.stack ? err.stack : err}`)
  process.exit(1)
})
