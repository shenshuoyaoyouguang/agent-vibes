/**
 * Per-request upstream logging.
 *
 * Mirrors CLIProxyAPI's `helps.RecordAPIRequest` / `AppendAPIResponseChunk`
 * / `RecordAPIResponseError` trio so that every Claude API request the
 * bridge issues — URL, headers, body, response status, response chunks,
 * upstream errors — is captured to disk for after-the-fact diagnosis.
 *
 * Logs are gated on the `CLAUDE_REQUEST_LOG=true` environment variable so
 * they are off by default (request bodies can contain user prompts and
 * credentials). When enabled, each request opens a freshly named file
 * under `<AGENT_VIBES_DATA_DIR>/logs/claude-api/`.
 */

import { randomUUID } from "crypto"
import { appendFile, mkdir, writeFile } from "fs/promises"
import * as os from "os"
import * as path from "path"

const ENV_FLAG = "CLAUDE_REQUEST_LOG"

const SECRET_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "cookie",
  "set-cookie",
  "proxy-authorization",
])

const REDACTED = "<redacted>"

let cachedDir: string | null = null
let warned = false

export interface ClaudeRequestLogContext {
  enabled: boolean
  filePath: string | null
}

export interface ClaudeRequestLogStartParams {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
  accountLabel?: string
  upstreamModel: string
}

/**
 * Open a per-request log file, write the initial header + body, and
 * return a context handle that subsequent helpers use to append events.
 *
 * Returns `{ enabled: false, filePath: null }` when logging is off so
 * call sites can be guarded with a single boolean check.
 */
export async function startClaudeRequestLog(
  params: ClaudeRequestLogStartParams
): Promise<ClaudeRequestLogContext> {
  if (!isLoggingEnabled()) {
    return { enabled: false, filePath: null }
  }

  const dir = resolveLogDir()
  try {
    await mkdir(dir, { recursive: true })
  } catch (err) {
    warnOnce(`failed to create log directory ${dir}: ${describeError(err)}`)
    return { enabled: false, filePath: null }
  }

  const fileName = buildFileName(params.upstreamModel, params.accountLabel)
  const filePath = path.join(dir, fileName)

  const initial = [
    `# Claude API request log`,
    `timestamp: ${new Date().toISOString()}`,
    `account: ${params.accountLabel || "(unlabelled)"}`,
    `model: ${params.upstreamModel}`,
    "",
    `## Request`,
    `${params.method} ${params.url}`,
    "",
    "### Headers",
    formatHeaders(params.headers),
    "",
    "### Body",
    formatBody(params.body),
    "",
    "## Response",
    "",
  ].join("\n")

  try {
    await writeFile(filePath, initial, "utf8")
  } catch (err) {
    warnOnce(`failed to write log header to ${filePath}: ${describeError(err)}`)
    return { enabled: false, filePath: null }
  }

  return { enabled: true, filePath }
}

export async function appendClaudeResponseMetadata(
  context: ClaudeRequestLogContext,
  status: number,
  headers: Record<string, string>
): Promise<void> {
  if (!context.enabled || !context.filePath) return
  const text = [
    `### Status`,
    `${status}`,
    "",
    "### Response Headers",
    formatHeaders(headers),
    "",
    "### Response Body",
    "",
  ].join("\n")
  await appendOrWarn(context.filePath, text)
}

export async function appendClaudeResponseChunk(
  context: ClaudeRequestLogContext,
  chunk: string
): Promise<void> {
  if (!context.enabled || !context.filePath) return
  await appendOrWarn(context.filePath, chunk)
}

export async function appendClaudeResponseError(
  context: ClaudeRequestLogContext,
  error: unknown
): Promise<void> {
  if (!context.enabled || !context.filePath) return
  const text = ["", "### Error", describeError(error), ""].join("\n")
  await appendOrWarn(context.filePath, text)
}

function isLoggingEnabled(): boolean {
  const raw = process.env[ENV_FLAG]
  if (!raw) return false
  const normalized = raw.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes"
}

function resolveLogDir(): string {
  if (cachedDir) return cachedDir
  const base =
    process.env.AGENT_VIBES_DATA_DIR || path.join(os.homedir(), ".agent-vibes")
  cachedDir = path.join(base, "logs", "claude-api")
  return cachedDir
}

function buildFileName(model: string, accountLabel?: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-")
  const slug = sanitizeForFilename(`${accountLabel || "anon"}-${model}`)
  const id = randomUUID().slice(0, 8)
  return `${ts}_${slug}_${id}.log`
}

function sanitizeForFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 64) || "claude"
}

function formatHeaders(headers: Record<string, string>): string {
  const lines: string[] = []
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    const display = SECRET_HEADERS.has(lower) ? REDACTED : value
    lines.push(`${name}: ${display}`)
  }
  return lines.length > 0 ? lines.join("\n") : "(none)"
}

function formatBody(body: unknown): string {
  if (body == null) return "(empty)"
  if (typeof body === "string") {
    return body
  }
  try {
    return JSON.stringify(body, null, 2)
  } catch {
    return "(unserialisable)"
  }
}

async function appendOrWarn(filePath: string, text: string): Promise<void> {
  try {
    await appendFile(filePath, text, "utf8")
  } catch (err) {
    warnOnce(`failed to append to ${filePath}: ${describeError(err)}`)
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`
  }
  if (typeof err === "string") return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function warnOnce(message: string): void {
  if (warned) return
  warned = true
  // Surface the message via stderr without going through console.warn so
  // the lint policy that bans console.* is honoured.
  process.stderr.write(`[Claude API request-log] ${message}\n`)
}
