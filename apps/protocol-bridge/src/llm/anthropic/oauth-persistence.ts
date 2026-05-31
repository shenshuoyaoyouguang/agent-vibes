/**
 * Atomically persist a rotated Anthropic OAuth token bundle back to the
 * `claude-api-accounts.json` file the bridge originally loaded the
 * account from.
 *
 * Anthropic's OAuth refresh tokens single-rotate: every successful call
 * to `/v1/oauth/token` issues a fresh refresh token and the old one is
 * immediately void. The runtime keeps the new bundle in memory, but if
 * the bridge restarts before we write back, the next refresh attempt
 * fails with `invalid_grant` and the user has to re-login.
 *
 * Algorithm:
 *   1. Read the current file fresh — do NOT clobber concurrent edits
 *      from the user or other tooling (e.g. the VSCode extension's
 *      account sync command).
 *   2. Locate the account by deterministic state key
 *      (`sha256(baseUrl + "\0" + prefix + "\0" + apiKey)`). Both the
 *      legacy `apiKey` (= access token, since OAuth-mode treats it as
 *      one) and the new `apiKey` are tried, because the bundle we are
 *      writing typically contains a freshly rotated access token whose
 *      previous value is what is on disk.
 *   3. Splice the rotated fields (`apiKey`, `oauth.refreshToken`,
 *      `oauth.accessTokenExpiresAt`) into the matching entry; leave
 *      every other field — including unrelated accounts — untouched.
 *   4. Write to `<file>.tmp.<rand>` and rename atomically. If anything
 *      fails, surface the error to the caller; the in-memory rotation
 *      still stands so the next request continues to succeed.
 */

import { createHash, randomBytes } from "crypto"
import { readFile, rename, unlink, writeFile } from "fs/promises"

export interface OAuthPersistRequest {
  /** Absolute path to `claude-api-accounts.json` (already loaded). */
  configFilePath: string
  /** Match key components — must reproduce the original loader's state-key hash. */
  baseUrl: string
  prefix?: string
  /** Previous access token (= apiKey on disk before this rotation). */
  previousApiKey: string
  /** New access token to write back. */
  rotatedApiKey: string
  /** New refresh token (single-rotated by Anthropic). */
  rotatedRefreshToken: string
  /** New `expires_at` ms-epoch derived from `expires_in`. */
  rotatedAccessTokenExpiresAt: number
}

interface ConfigFileShape {
  forceModelPrefix?: unknown
  accounts?: unknown[]
}

interface AccountEntryShape {
  apiKey?: unknown
  baseUrl?: unknown
  prefix?: unknown
  oauth?: {
    refreshToken?: unknown
    accessTokenExpiresAt?: unknown
    accountUuid?: unknown
    organizationUuid?: unknown
  }
  [k: string]: unknown
}

/**
 * Best-effort atomic persistence of a single account's rotated OAuth
 * bundle. Throws when the file cannot be safely rewritten so the caller
 * can log and back off; never partially writes.
 */
export async function persistOauthRotation(
  req: OAuthPersistRequest
): Promise<void> {
  const raw = await readFile(req.configFilePath, "utf8")
  const parsed = parseConfig(raw)
  if (!parsed) {
    throw new Error(
      `claude-api-accounts.json at ${req.configFilePath} is not a valid JSON object`
    )
  }

  const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : []
  const targetKey = computeStateKey(req.baseUrl, req.prefix, req.previousApiKey)

  let matchedIdx = -1
  for (let i = 0; i < accounts.length; i++) {
    const entry = accounts[i] as AccountEntryShape | null | undefined
    if (!entry || typeof entry !== "object") continue
    const entryKey = computeStateKey(
      typeof entry.baseUrl === "string" ? entry.baseUrl : req.baseUrl,
      typeof entry.prefix === "string" ? entry.prefix : undefined,
      typeof entry.apiKey === "string" ? entry.apiKey : ""
    )
    if (entryKey === targetKey) {
      matchedIdx = i
      break
    }
  }

  if (matchedIdx < 0) {
    // Nothing to rewrite — the on-disk file no longer references the
    // credential we hold in memory. Could happen when the user manually
    // edits the JSON between bridge starts. Surface this so the caller
    // logs and stops trying for this credential.
    throw new Error(
      `no matching account in ${req.configFilePath}: the on-disk credential differs from the in-memory one`
    )
  }

  const entry = accounts[matchedIdx] as AccountEntryShape
  entry.apiKey = req.rotatedApiKey
  const oauth = (entry.oauth as Record<string, unknown> | undefined) || {}
  oauth.refreshToken = req.rotatedRefreshToken
  oauth.accessTokenExpiresAt = req.rotatedAccessTokenExpiresAt
  entry.oauth = oauth as AccountEntryShape["oauth"]
  accounts[matchedIdx] = entry

  parsed.accounts = accounts

  const serialised = JSON.stringify(parsed, null, 2) + "\n"
  await atomicWrite(req.configFilePath, serialised)
}

function parseConfig(raw: string): ConfigFileShape | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null
    }
    return value as ConfigFileShape
  } catch {
    return null
  }
}

function computeStateKey(
  baseUrl: string,
  prefix: string | undefined,
  apiKey: string
): string {
  return createHash("sha256")
    .update(baseUrl)
    .update("\0")
    .update(prefix || "")
    .update("\0")
    .update(apiKey)
    .digest("hex")
}

async function atomicWrite(
  targetPath: string,
  contents: string
): Promise<void> {
  const suffix = randomBytes(6).toString("hex")
  const tempPath = `${targetPath}.tmp.${suffix}`
  try {
    await writeFile(tempPath, contents, { encoding: "utf8", mode: 0o600 })
    await rename(tempPath, targetPath)
  } catch (err) {
    // Best-effort cleanup of the temp file on failure.
    try {
      await unlink(tempPath)
    } catch {
      // Ignore — the temp may not have been created yet.
    }
    throw err
  }
}

export interface OAuthAppendRequest {
  /**
   * Absolute path to `claude-api-accounts.json`. Created if missing
   * along with its parent directory.
   */
  configFilePath: string
  label?: string
  baseUrl?: string
  proxyUrl?: string
  /** Access token (Anthropic OAuth issues one as `apiKey` for our purposes). */
  apiKey: string
  refreshToken: string
  accessTokenExpiresAt: number
  accountUuid?: string
  accountEmail?: string
  organizationUuid?: string
  organizationName?: string
}

/**
 * Append (or upsert by `email + baseUrl`) a freshly minted OAuth account
 * into `claude-api-accounts.json`. Used by the Dashboard "Login with
 * Anthropic" flow so the new account becomes available to the bridge as
 * soon as the user finishes the redirect.
 *
 * Atomic: writes to `<file>.tmp.<rand>` then renames. If the file does
 * not exist yet a fresh `{ accounts: [...] }` document is created.
 */
export async function appendOauthAccount(req: OAuthAppendRequest): Promise<{
  /** Resulting accounts array length on disk. */
  accountCount: number
  /** Whether an existing entry with the same email/baseUrl was replaced. */
  replaced: boolean
}> {
  const { mkdir } = await import("fs/promises")
  const path = await import("path")
  await mkdir(path.dirname(req.configFilePath), {
    recursive: true,
    mode: 0o700,
  })

  let parsed: ConfigFileShape | null = null
  try {
    const raw = await readFile(req.configFilePath, "utf8")
    parsed = parseConfig(raw)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "ENOENT") {
      throw err
    }
  }
  if (!parsed) {
    parsed = { accounts: [] }
  }

  const accounts = Array.isArray(parsed.accounts) ? [...parsed.accounts] : []
  const baseUrl = (req.baseUrl || "https://api.anthropic.com").trim()
  const dedupeEmail = (req.accountEmail || "").trim().toLowerCase()

  let replaced = false
  if (dedupeEmail) {
    for (let i = 0; i < accounts.length; i++) {
      const entry = accounts[i] as AccountEntryShape | null | undefined
      if (!entry || typeof entry !== "object") continue
      const entryEmail =
        typeof entry.label === "string" ? entry.label.trim().toLowerCase() : ""
      const entryBase =
        typeof entry.baseUrl === "string" ? entry.baseUrl.trim() : ""
      if (entryEmail === dedupeEmail && (!entryBase || entryBase === baseUrl)) {
        accounts.splice(i, 1)
        replaced = true
        break
      }
    }
  }

  const fresh: AccountEntryShape = {
    label: req.label || req.accountEmail || "anthropic-oauth",
    apiKey: req.apiKey,
    baseUrl,
    oauth: {
      refreshToken: req.refreshToken,
      accessTokenExpiresAt: req.accessTokenExpiresAt,
      accountUuid: req.accountUuid,
      organizationUuid: req.organizationUuid,
    },
  }
  if (req.proxyUrl) {
    fresh.proxyUrl = req.proxyUrl
  }

  accounts.push(fresh)
  parsed.accounts = accounts

  const serialised = JSON.stringify(parsed, null, 2) + "\n"
  await atomicWrite(req.configFilePath, serialised)

  return { accountCount: accounts.length, replaced }
}
