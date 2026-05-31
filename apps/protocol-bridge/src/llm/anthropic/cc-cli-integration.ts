/**
 * Wire Claude Code CLI to use this Bridge as its upstream — and unwire it.
 *
 * CC CLI reads its environment in this priority order:
 *   1. process.env (highest)
 *   2. `~/.claude/settings.json` `env` map (CC CLI exports these into its
 *      own process at startup)
 *   3. shell profile exports
 *
 * We target #2: the only way to make CC CLI durably use the Bridge
 * without polluting user dotfiles.  Everything we write is wrapped in a
 * sentinel field (`__agentVibes`) so Disconnect can cleanly remove just
 * our additions; on first Connect we also snapshot the user's original
 * settings to a sibling file so a hard-restore is always possible.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "fs/promises"
import * as os from "os"
import * as path from "path"

const SETTINGS_FILE = "settings.json"
const BACKUP_FILE = "settings.agent-vibes.backup.json"

const SENTINEL_KEY = "__agentVibes"

const MANAGED_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "NODE_EXTRA_CA_CERTS",
] as const

type ManagedEnvKey = (typeof MANAGED_ENV_KEYS)[number]

interface AgentVibesSentinel {
  /** Schema version for future migrations. */
  version: 1
  /** ISO timestamp when this Connect ran. */
  managedAt: string
  /**
   * Keys we wrote into `env`. Disconnect uses this list to know what to
   * remove without touching unrelated keys.
   */
  managedEnvKeys: ManagedEnvKey[]
  /** The Bridge URL we wrote — for diff-detection on subsequent Connects. */
  bridgeUrl: string
}

interface ClaudeSettings {
  env?: Record<string, unknown>
  [key: string]: unknown
}

export interface ClaudeCliEnvSnapshot {
  /** ANTHROPIC_BASE_URL currently written to ~/.claude/settings.json. */
  baseUrl?: string
  /** Masked form of ANTHROPIC_API_KEY currently in settings.json (last 4 chars visible). */
  apiKeyMasked?: string
  /** Length of ANTHROPIC_API_KEY (helps spot an empty / placeholder string). */
  apiKeyLength?: number
  /** Masked form of ANTHROPIC_AUTH_TOKEN if it co-exists (auth conflict signal). */
  authTokenMasked?: string
  /** Length of ANTHROPIC_AUTH_TOKEN if present. */
  authTokenLength?: number
  /** NODE_EXTRA_CA_CERTS path currently written. */
  nodeExtraCaCerts?: string
}

export interface ClaudeCliIntegrationStatus {
  /** True when the settings file has our sentinel and points at the given Bridge URL. */
  connected: boolean
  /** Absolute path to the settings file we manage. */
  settingsPath: string
  /** Absolute path to the backup file (may not exist yet). */
  backupPath: string
  /** Bridge URL currently written, if any. */
  managedBridgeUrl?: string
  /** ISO timestamp of the last Connect. */
  managedAt?: string
  /** True when a backup file exists on disk. */
  backupExists: boolean
  /** True when the settings file exists at all. */
  settingsExists: boolean
  /**
   * Snapshot of the env values currently written into settings.json.
   * Secrets are masked. Used by the dashboard's API tab diagnostics
   * panel so the user can confirm CC CLI is reading what we wrote.
   */
  envWritten?: ClaudeCliEnvSnapshot
  /**
   * True when both ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are set
   * in settings.json — CC CLI emits a noisy "Auth conflict" warning in
   * that case and we should surface it explicitly.
   */
  authConflict?: boolean
  /**
   * Whether the bridge process itself has PROXY_API_KEY configured.
   * When true, requests without a matching x-api-key get rejected with
   * 401 (the most common cause of a CC CLI "Invalid API key" error
   * after Connect).
   */
  bridgeApiKeyConfigured?: boolean
  /**
   * Whether the API key written to settings.json matches the bridge's
   * expected PROXY_API_KEY:
   *   - "match"    — settings.json key equals bridge runtime key
   *   - "mismatch" — bridge has a key but settings.json's value differs
   *   - "no-guard" — bridge runs in loopback no-auth mode (any key works)
   *   - "unknown"  — settings.json missing or not managed by us
   */
  bridgeApiKeyMatch?: "match" | "mismatch" | "no-guard" | "unknown"
}

export interface ClaudeCliConnectRequest {
  bridgeUrl: string
  apiKey?: string
  /**
   * Optional path to the bridge's CA certificate. When set, written into
   * `NODE_EXTRA_CA_CERTS` so Node trusts the mkcert root used by the
   * Bridge's HTTPS listener.
   */
  caCertPath?: string
}

export interface ClaudeCliConnectResult {
  status: "connected"
  settingsPath: string
  backupCreated: boolean
  managedBridgeUrl: string
}

export interface ClaudeCliDisconnectResult {
  status: "disconnected" | "not-managed" | "settings-missing"
  settingsPath: string
  restoredFromBackup: boolean
}

function getClaudeDir(): string {
  // Resolve HOME at call time so tests can redirect via env vars without
  // monkey-patching `os.homedir()` (which Node caches on first read).
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir()
  return path.join(home, ".claude")
}

function getSettingsPath(): string {
  return path.join(getClaudeDir(), SETTINGS_FILE)
}

function getBackupPath(): string {
  return path.join(getClaudeDir(), BACKUP_FILE)
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf8")
    if (!raw.trim()) return null
    return JSON.parse(raw) as T
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") return null
    throw err
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, "utf8")
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") return false
    return true
  }
}

async function atomicWriteJson(
  targetPath: string,
  contents: unknown
): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 })
  const serialised = JSON.stringify(contents, null, 2) + "\n"
  const tempPath = `${targetPath}.tmp.${Date.now().toString(36)}`
  try {
    await writeFile(tempPath, serialised, { encoding: "utf8", mode: 0o600 })
    await rename(tempPath, targetPath)
  } catch (err) {
    try {
      await unlink(tempPath)
    } catch {
      // ignore
    }
    throw err
  }
}

/**
 * Mask a secret string for display: keep last 4 chars visible, replace
 * the rest with `*`. Returns undefined for empty / non-string input.
 *
 * Examples:
 *   maskSecret("sk-ant-1234567890abcd") => "***************abcd"
 *   maskSecret("agent-vibes-bridge-no-auth") => "**********************-auth"
 *   maskSecret("abc") => "***"
 */
function maskSecret(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.length <= 4) return "*".repeat(trimmed.length)
  const tail = trimmed.slice(-4)
  return "*".repeat(trimmed.length - 4) + tail
}

function snapshotEnv(env: Record<string, unknown>): ClaudeCliEnvSnapshot {
  const snapshot: ClaudeCliEnvSnapshot = {}
  const baseUrl = env.ANTHROPIC_BASE_URL
  if (typeof baseUrl === "string" && baseUrl.trim().length > 0) {
    snapshot.baseUrl = baseUrl.trim()
  }
  const apiKey = env.ANTHROPIC_API_KEY
  if (typeof apiKey === "string" && apiKey.trim().length > 0) {
    snapshot.apiKeyMasked = maskSecret(apiKey)
    snapshot.apiKeyLength = apiKey.trim().length
  }
  const authToken = env.ANTHROPIC_AUTH_TOKEN
  if (typeof authToken === "string" && authToken.trim().length > 0) {
    snapshot.authTokenMasked = maskSecret(authToken)
    snapshot.authTokenLength = authToken.trim().length
  }
  const caCerts = env.NODE_EXTRA_CA_CERTS
  if (typeof caCerts === "string" && caCerts.trim().length > 0) {
    snapshot.nodeExtraCaCerts = caCerts.trim()
  }
  return snapshot
}

function readSentinel(settings: ClaudeSettings): AgentVibesSentinel | null {
  const raw = settings[SENTINEL_KEY]
  if (!raw || typeof raw !== "object") return null
  const candidate = raw as Record<string, unknown>
  if (candidate.version !== 1) return null
  const managedAt =
    typeof candidate.managedAt === "string" ? candidate.managedAt : ""
  const bridgeUrl =
    typeof candidate.bridgeUrl === "string" ? candidate.bridgeUrl : ""
  const managedEnvKeysRaw = Array.isArray(candidate.managedEnvKeys)
    ? candidate.managedEnvKeys
    : []
  const managedEnvKeys = managedEnvKeysRaw.filter(
    (value): value is ManagedEnvKey =>
      (MANAGED_ENV_KEYS as readonly string[]).includes(String(value))
  )
  if (!managedAt || !bridgeUrl) return null
  return { version: 1, managedAt, bridgeUrl, managedEnvKeys }
}

/**
 * Inspect `~/.claude/settings.json` and report the current integration
 * state without making any changes.
 *
 * @param bridgeApiKey  Bridge runtime PROXY_API_KEY (or null/undefined
 *                      when the bridge runs in loopback no-auth mode).
 *                      The controller injects this from ConfigService so
 *                      we can compute whether the value written into
 *                      settings.json will actually pass ApiKeyGuard.
 */
export async function getClaudeCliIntegrationStatus(
  bridgeApiKey?: string | null
): Promise<ClaudeCliIntegrationStatus> {
  const settingsPath = getSettingsPath()
  const backupPath = getBackupPath()

  const settings = await readJsonIfExists<ClaudeSettings>(settingsPath)
  const settingsExists = settings != null
  const backupExists = await pathExists(backupPath)

  const trimmedBridgeKey =
    typeof bridgeApiKey === "string" ? bridgeApiKey.trim() : ""
  const bridgeApiKeyConfigured = trimmedBridgeKey.length > 0

  if (!settings) {
    return {
      connected: false,
      settingsPath,
      backupPath,
      backupExists,
      settingsExists,
      bridgeApiKeyConfigured,
      bridgeApiKeyMatch: bridgeApiKeyConfigured ? "unknown" : "no-guard",
    }
  }

  const env: Record<string, unknown> =
    settings.env && typeof settings.env === "object" ? settings.env : {}
  const envWritten = snapshotEnv(env)
  const authConflict =
    typeof env.ANTHROPIC_API_KEY === "string" &&
    env.ANTHROPIC_API_KEY.trim().length > 0 &&
    typeof env.ANTHROPIC_AUTH_TOKEN === "string" &&
    env.ANTHROPIC_AUTH_TOKEN.trim().length > 0

  const settingsApiKey =
    typeof env.ANTHROPIC_API_KEY === "string"
      ? env.ANTHROPIC_API_KEY.trim()
      : ""

  let bridgeApiKeyMatch: ClaudeCliIntegrationStatus["bridgeApiKeyMatch"]
  if (!bridgeApiKeyConfigured) {
    bridgeApiKeyMatch = "no-guard"
  } else if (!settingsApiKey) {
    bridgeApiKeyMatch = "unknown"
  } else if (settingsApiKey === trimmedBridgeKey) {
    bridgeApiKeyMatch = "match"
  } else {
    bridgeApiKeyMatch = "mismatch"
  }

  const sentinel = readSentinel(settings)
  if (!sentinel) {
    return {
      connected: false,
      settingsPath,
      backupPath,
      backupExists,
      settingsExists,
      envWritten,
      authConflict,
      bridgeApiKeyConfigured,
      bridgeApiKeyMatch,
    }
  }

  return {
    connected: true,
    settingsPath,
    backupPath,
    backupExists,
    settingsExists,
    managedBridgeUrl: sentinel.bridgeUrl,
    managedAt: sentinel.managedAt,
    envWritten,
    authConflict,
    bridgeApiKeyConfigured,
    bridgeApiKeyMatch,
  }
}

/**
 * Wire CC CLI to use the Bridge. Idempotent — running it twice with the
 * same input is a no-op apart from the timestamp.
 *
 * Algorithm:
 *   1. Read existing `~/.claude/settings.json` (or treat as empty).
 *   2. If our sentinel is absent, snapshot the file to backup.json (only
 *      when backup does not already exist — never clobber an earlier
 *      snapshot).
 *   3. Splice ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY / NODE_EXTRA_CA_CERTS
 *      into `env`, leaving other env entries untouched.
 *   4. Write the sentinel block.
 *   5. Atomic write back.
 */
export async function connectClaudeCli(
  req: ClaudeCliConnectRequest
): Promise<ClaudeCliConnectResult> {
  const settingsPath = getSettingsPath()
  const backupPath = getBackupPath()

  const existing = (await readJsonIfExists<ClaudeSettings>(settingsPath)) || {}
  const sentinel = readSentinel(existing)

  // Snapshot first-time only, when not already managed by us.
  let backupCreated = false
  if (!sentinel) {
    const backupExists = await pathExists(backupPath)
    if (!backupExists) {
      const snapshot = { ...existing }
      // Strip our own marker if somehow present without parsing — defence
      // in depth so the backup is always "the user's original".
      delete (snapshot as Record<string, unknown>)[SENTINEL_KEY]
      await atomicWriteJson(backupPath, snapshot)
      backupCreated = true
    }
  }

  const env: Record<string, unknown> =
    existing.env && typeof existing.env === "object" ? { ...existing.env } : {}

  env.ANTHROPIC_BASE_URL = req.bridgeUrl
  if (req.apiKey) {
    env.ANTHROPIC_API_KEY = req.apiKey
  } else {
    // CC CLI sometimes refuses to start without ANY auth value. The
    // Bridge's ApiKeyGuard treats missing PROXY_API_KEY as
    // "loopback-only no-auth", so any non-empty value is accepted.
    env.ANTHROPIC_API_KEY = "agent-vibes-bridge-no-auth"
  }
  // CC CLI treats ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN as mutually
  // exclusive — having both triggers a noisy "Auth conflict" warning at
  // startup. Since we always write ANTHROPIC_API_KEY, strip any
  // pre-existing AUTH_TOKEN. The first-time Connect already snapshotted
  // the user's original value to backup.json, so Disconnect-with-backup
  // can still restore it byte-for-byte.
  delete env.ANTHROPIC_AUTH_TOKEN
  if (req.caCertPath) {
    env.NODE_EXTRA_CA_CERTS = req.caCertPath
  }

  const managedEnvKeys: ManagedEnvKey[] = [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_KEY",
    // Tracked so Disconnect's surgical fallback (no backup file) also
    // clears any AUTH_TOKEN we stripped or that gets re-introduced while
    // managed.
    "ANTHROPIC_AUTH_TOKEN",
  ]
  if (req.caCertPath) {
    managedEnvKeys.push("NODE_EXTRA_CA_CERTS")
  }

  const newSentinel: AgentVibesSentinel = {
    version: 1,
    managedAt: new Date().toISOString(),
    managedEnvKeys,
    bridgeUrl: req.bridgeUrl,
  }
  const newSettings: ClaudeSettings = { ...existing, env }
  newSettings[SENTINEL_KEY] = newSentinel

  await atomicWriteJson(settingsPath, newSettings)

  return {
    status: "connected",
    settingsPath,
    backupCreated,
    managedBridgeUrl: req.bridgeUrl,
  }
}

/**
 * Unwire CC CLI. Two strategies, in priority:
 *
 *   1. If a backup file exists, restore it byte-for-byte.
 *   2. Otherwise, surgically remove only the keys we ever wrote
 *      (according to the sentinel's `managedEnvKeys`) and the sentinel
 *      itself.
 *
 * Idempotent: running on an already-disconnected file returns
 * `not-managed` without touching anything.
 */
export async function disconnectClaudeCli(): Promise<ClaudeCliDisconnectResult> {
  const settingsPath = getSettingsPath()
  const backupPath = getBackupPath()

  const existing = await readJsonIfExists<ClaudeSettings>(settingsPath)
  if (!existing) {
    return {
      status: "settings-missing",
      settingsPath,
      restoredFromBackup: false,
    }
  }

  const sentinel = readSentinel(existing)
  if (!sentinel) {
    return {
      status: "not-managed",
      settingsPath,
      restoredFromBackup: false,
    }
  }

  // Try backup-first restore.
  const backup = await readJsonIfExists<ClaudeSettings>(backupPath)
  if (backup) {
    await atomicWriteJson(settingsPath, backup)
    try {
      await unlink(backupPath)
    } catch {
      // Backup may be locked or already removed — non-fatal.
    }
    return {
      status: "disconnected",
      settingsPath,
      restoredFromBackup: true,
    }
  }

  // Surgical removal fallback.
  const env: Record<string, unknown> =
    existing.env && typeof existing.env === "object" ? { ...existing.env } : {}
  for (const key of sentinel.managedEnvKeys) {
    delete env[key]
  }

  const cleaned: ClaudeSettings = { ...existing }
  delete (cleaned as Record<string, unknown>)[SENTINEL_KEY]
  if (Object.keys(env).length > 0) {
    cleaned.env = env
  } else {
    delete cleaned.env
  }

  await atomicWriteJson(settingsPath, cleaned)

  return {
    status: "disconnected",
    settingsPath,
    restoredFromBackup: false,
  }
}
