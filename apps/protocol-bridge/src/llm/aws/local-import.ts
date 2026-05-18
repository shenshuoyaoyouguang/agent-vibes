/**
 * Discover Kiro credentials cached locally by the Kiro / AWS SSO clients.
 *
 * Scan order:
 *   1. `~/.aws/sso/cache/*.json` — official AWS Builder ID + IdC tokens
 *   2. `<KIRO_USER_DATA>/globalStorage/kiro.kiroAgent/kiro-cache/*.json`
 *      (macOS / Windows / Linux variants)
 *
 * Each candidate file is parsed defensively: invalid JSON or schemas missing
 * the bare-minimum `accessToken` + `refreshToken` pair are skipped.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"

export interface DiscoveredKiroToken {
  /** Absolute path of the file that produced this entry. */
  sourcePath: string
  /**
   * Authentication method.  Determined in priority order:
   *   1. The token file's own `authMethod` field (Kiro IDE writes this).
   *   2. `kiro-auth-token.json` filename → always "social" (Kiro IDE format).
   *   3. Presence of clientId+clientSecret on the token itself or paired
   *      registration → "idc"; otherwise "social".
   */
  authMethod: "idc" | "social"
  region: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  clientId?: string
  clientSecret?: string
  startUrl?: string
  registrationExpiresAt?: number
  /** Optional metadata exposed by Kiro IDE token files. */
  provider?: string
  profileArn?: string
}

interface SsoTokenJson {
  accessToken?: string
  refreshToken?: string
  expiresAt?: string | number
  region?: string
  startUrl?: string
  clientId?: string
  clientSecret?: string
  registrationExpiresAt?: string | number
  /**
   * Kiro IDE writes this explicitly in `~/.aws/sso/cache/kiro-auth-token.json`
   * (e.g. "social" for Google/GitHub, "idc" for Builder ID / IAM IdC).  Must
   * be honored verbatim — never overridden by registration-file pairing.
   */
  authMethod?: string
  provider?: string
  profileArn?: string
}

interface SsoClientRegistrationJson {
  clientId?: string
  clientSecret?: string
  registrationExpiresAt?: string | number
}

const AWS_SSO_CACHE_DIRS: string[] = (() => {
  const home = os.homedir()
  switch (process.platform) {
    case "win32":
      return [
        path.join(process.env.USERPROFILE || home, ".aws", "sso", "cache"),
      ]
    default:
      return [path.join(home, ".aws", "sso", "cache")]
  }
})()

const KIRO_GLOBAL_CACHE_DIRS: string[] = (() => {
  const home = os.homedir()
  switch (process.platform) {
    case "darwin":
      return [
        path.join(
          home,
          "Library",
          "Application Support",
          "kiro",
          "User",
          "globalStorage",
          "kiro.kiroagent",
          "kiro-cache"
        ),
        path.join(
          home,
          "Library",
          "Application Support",
          "Kiro",
          "User",
          "globalStorage",
          "kiro.kiroagent",
          "kiro-cache"
        ),
      ]
    case "win32": {
      const appData =
        process.env.APPDATA || path.join(home, "AppData", "Roaming")
      return [
        path.join(
          appData,
          "Kiro",
          "User",
          "globalStorage",
          "kiro.kiroagent",
          "kiro-cache"
        ),
      ]
    }
    default: {
      const xdg = process.env.XDG_CONFIG_HOME?.trim()
      const dirs: string[] = []
      if (xdg) {
        dirs.push(
          path.join(
            xdg,
            "Kiro",
            "User",
            "globalStorage",
            "kiro.kiroagent",
            "kiro-cache"
          )
        )
      }
      dirs.push(
        path.join(
          home,
          ".config",
          "Kiro",
          "User",
          "globalStorage",
          "kiro.kiroagent",
          "kiro-cache"
        )
      )
      return dirs
    }
  }
})()

function parseExpiresMs(value: SsoTokenJson["expiresAt"]): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    // SSO cache stores absolute seconds; if the value clearly looks like ms,
    // accept it as-is.
    return value > 1e12 ? value : value * 1000
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function loadJsonFile<T>(filePath: string): T | null {
  try {
    const buf = fs.readFileSync(filePath, "utf-8")
    return JSON.parse(buf) as T
  } catch {
    return null
  }
}

function readDirSafe(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith(".json"))
      .map((name) => path.join(dir, name))
  } catch {
    return []
  }
}

function buildIdcToken(
  filePath: string,
  parsed: SsoTokenJson,
  registration?: SsoClientRegistrationJson
): DiscoveredKiroToken | null {
  const accessToken = (parsed.accessToken || "").trim()
  const refreshToken = (parsed.refreshToken || "").trim()
  if (!accessToken || !refreshToken) return null

  // Resolve authMethod with explicit precedence so a stray Builder ID
  // registration file in ~/.aws/sso/cache cannot mis-classify a Kiro IDE
  // social token (or vice-versa).
  const declared = (parsed.authMethod || "").trim().toLowerCase()
  const looksLikeKiroSocialFile =
    path.basename(filePath).toLowerCase() === "kiro-auth-token.json"

  let authMethod: "idc" | "social"
  if (declared === "social" || declared === "idc" || declared === "builderid") {
    authMethod = declared === "social" ? "social" : "idc"
  } else if (looksLikeKiroSocialFile) {
    // Kiro IDE always writes this filename for OAuth-with-Google/GitHub
    // sessions; treat anything that lands here without an explicit
    // declaration as social so we never marry it to a Builder ID
    // registration sitting next to it.
    authMethod = "social"
  } else if (
    (parsed.clientId && parsed.clientSecret) ||
    (registration?.clientId && registration.clientSecret)
  ) {
    authMethod = "idc"
  } else {
    authMethod = "social"
  }

  // Only carry clientId/clientSecret for IdC accounts.  Social refresh hits
  // a Kiro-hosted endpoint that does not accept (or need) those fields.
  let clientId: string | undefined
  let clientSecret: string | undefined
  if (authMethod === "idc") {
    clientId =
      (parsed.clientId || registration?.clientId || "").trim() || undefined
    clientSecret =
      (parsed.clientSecret || registration?.clientSecret || "").trim() ||
      undefined
  }

  const region = (parsed.region || "us-east-1").trim() || "us-east-1"
  const expiresMs = parseExpiresMs(parsed.expiresAt)
  const registrationExpiresMs = parseExpiresMs(
    parsed.registrationExpiresAt || registration?.registrationExpiresAt
  )

  return {
    sourcePath: filePath,
    authMethod,
    region,
    accessToken,
    refreshToken,
    expiresAt: Math.floor(expiresMs / 1000) || 0,
    clientId,
    clientSecret,
    startUrl: (parsed.startUrl || "").trim() || undefined,
    registrationExpiresAt: registrationExpiresMs
      ? Math.floor(registrationExpiresMs / 1000)
      : undefined,
    provider: (parsed.provider || "").trim() || undefined,
    profileArn: (parsed.profileArn || "").trim() || undefined,
  }
}

/**
 * Walk a single cache directory, pairing token files with their matching
 * client-registration JSON when one exists.
 *
 * Pairing rules (deliberately conservative — we'd rather emit a "social"
 * entry without registration than mis-marry tokens):
 *   - The token file must NOT explicitly declare `authMethod: "social"`.
 *   - We never pair `kiro-auth-token.json`; that filename is reserved by
 *     Kiro IDE for OAuth-with-Google/GitHub sessions and any neighboring
 *     `<sha1>.json` registration belongs to a different identity.
 *   - Otherwise we pair when (a) both files share the same SHA-1-prefixed
 *     basename (AWS CLI cache layout) or (b) both files declare the same
 *     non-empty `startUrl`.
 *
 * The previous "if there's exactly one registration in the dir, assume it's
 * the one we want" fallback is gone: it caused Google/GitHub social tokens
 * to be tagged as IdC after a prior Builder ID login left a registration
 * behind in `~/.aws/sso/cache/`.
 */
function harvestDirectory(dir: string): DiscoveredKiroToken[] {
  const files = readDirSafe(dir)
  if (files.length === 0) return []

  const tokenFiles: Array<{ filePath: string; parsed: SsoTokenJson }> = []
  const regFiles: Array<{
    filePath: string
    parsed: SsoClientRegistrationJson & { startUrl?: string }
  }> = []
  for (const filePath of files) {
    const parsed = loadJsonFile<
      SsoTokenJson & SsoClientRegistrationJson & { startUrl?: string }
    >(filePath)
    if (!parsed) continue
    if (parsed.accessToken && parsed.refreshToken) {
      tokenFiles.push({ filePath, parsed })
    } else if (parsed.clientId && parsed.clientSecret) {
      regFiles.push({ filePath, parsed })
    }
  }

  if (tokenFiles.length === 0) return []

  const result: DiscoveredKiroToken[] = []
  for (const { filePath, parsed } of tokenFiles) {
    const baseName = path.basename(filePath).toLowerCase()
    const declared = (parsed.authMethod || "").trim().toLowerCase()
    const isExplicitSocial = declared === "social"
    const isKiroSocialFile = baseName === "kiro-auth-token.json"

    let registration: SsoClientRegistrationJson | undefined
    const tokenAlreadyHasClient = !!(parsed.clientId && parsed.clientSecret)
    const allowPairing =
      !isExplicitSocial && !isKiroSocialFile && !tokenAlreadyHasClient

    if (allowPairing) {
      const baseStem = path.basename(filePath, path.extname(filePath))
      registration = regFiles.find(
        ({ filePath: rp }) =>
          path.basename(rp, path.extname(rp)) === baseStem && rp !== filePath
      )?.parsed
      if (!registration && parsed.startUrl) {
        const targetUrl = parsed.startUrl.trim()
        if (targetUrl) {
          registration = regFiles.find(
            ({ parsed: rp }) =>
              typeof rp.startUrl === "string" &&
              rp.startUrl.trim() === targetUrl
          )?.parsed
        }
      }
    }

    const built = buildIdcToken(filePath, parsed, registration)
    if (built) result.push(built)
  }
  return result
}

/**
 * Discover all Kiro tokens cached locally.  Order is: AWS SSO cache first
 * (most authoritative for IdC / Builder ID), then Kiro IDE cache.
 */
export function discoverLocalKiroTokens(): DiscoveredKiroToken[] {
  const dirs = [...AWS_SSO_CACHE_DIRS, ...KIRO_GLOBAL_CACHE_DIRS]
  const all: DiscoveredKiroToken[] = []
  const seen = new Set<string>()
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue
    for (const entry of harvestDirectory(dir)) {
      // Dedupe by refresh token + region — same identity may be cached in
      // multiple files (one per scope).
      const key = `${entry.region}|${entry.refreshToken}`
      if (seen.has(key)) continue
      seen.add(key)
      all.push(entry)
    }
  }
  return all
}

/**
 * Convenience wrapper: pick the freshest discovered token (by `expiresAt`).
 * Returns null when no usable token is cached locally.
 */
export function pickFreshestLocalKiroToken(): DiscoveredKiroToken | null {
  const tokens = discoverLocalKiroTokens()
  if (tokens.length === 0) return null
  return [...tokens].sort((left, right) => right.expiresAt - left.expiresAt)[0]!
}
