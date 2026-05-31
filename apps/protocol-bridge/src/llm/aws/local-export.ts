/**
 * Write Kiro credentials back into the local Kiro IDE login cache so the
 * desktop Kiro IDE signs in as a pool account.
 *
 * This is the inverse of `local-import.ts`: instead of discovering tokens the
 * Kiro IDE wrote, we author the same files the IDE reads at startup to resolve
 * its current identity.
 *
 * Kiro IDE resolves its active login from
 * `~/.aws/sso/cache/kiro-auth-token.json`. Two shapes are written depending on
 * how the account was authorized (verified against live Kiro IDE caches):
 *
 *   - social (Google / GitHub):
 *       { accessToken, refreshToken, profileArn?, expiresAt,
 *         authMethod: "social", provider: "Google" | "GitHub" | ... }
 *   - idc / Builder ID:
 *       { accessToken, refreshToken, expiresAt, clientIdHash,
 *         authMethod: "IdC", provider: "BuilderId", region }
 *       plus a sibling `<clientIdHash>.json` client-registration file
 *       holding { clientId, clientSecret, expiresAt } so the IDE can refresh.
 */

import * as crypto from "crypto"
import * as fs from "fs"
import { createRequire } from "module"
import * as os from "os"
import * as path from "path"

const nodeRequire = createRequire(__filename)

export type KiroExportAuthMethod = "idc" | "social"

export interface KiroIdeExportInput {
  authMethod: KiroExportAuthMethod
  region: string
  accessToken: string
  refreshToken: string
  /** Absolute expiry in epoch seconds (0/undefined when unknown). */
  expiresAt?: number
  profileArn?: string
  provider?: string
  /** IdC only — required for the IDE to refresh the token later. */
  clientId?: string
  clientSecret?: string
  /** IdC client-registration expiry in epoch seconds (best effort). */
  registrationExpiresAt?: number
}

export interface KiroIdeExportResult {
  tokenPath: string
  registrationPath?: string
  profilePath?: string
  backupPath?: string
}

export interface KiroCliExportResult {
  dbPath: string
  tokenPath: string
  backupPath?: string
  tokenBackupPath?: string
}

/**
 * Return the directory Kiro IDE reads its auth token from. The token file is
 * always `~/.aws/sso/cache/kiro-auth-token.json` on every platform (the IDE
 * reuses the AWS SSO cache layout).
 */
function getKiroSsoCacheDir(): string {
  const home = os.homedir()
  if (process.platform === "win32") {
    return path.join(process.env.USERPROFILE || home, ".aws", "sso", "cache")
  }
  return path.join(home, ".aws", "sso", "cache")
}

function getKiroCliDataDir(): string {
  const home = os.homedir()
  switch (process.platform) {
    case "win32": {
      const base =
        process.env.LOCALAPPDATA ||
        process.env.APPDATA ||
        path.join(home, "AppData", "Local")
      return path.join(base, "kiro-cli")
    }
    case "darwin":
      return path.join(home, "Library", "Application Support", "kiro-cli")
    default: {
      const xdg = process.env.XDG_DATA_HOME?.trim()
      return path.join(xdg || path.join(home, ".local", "share"), "kiro-cli")
    }
  }
}

function getKiroProfilePaths(): string[] {
  const home = os.homedir()
  switch (process.platform) {
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
          "profile.json"
        ),
      ]
    }
    case "darwin":
      return [
        path.join(
          home,
          "Library",
          "Application Support",
          "Kiro",
          "User",
          "globalStorage",
          "kiro.kiroagent",
          "profile.json"
        ),
        path.join(
          home,
          "Library",
          "Application Support",
          "kiro",
          "User",
          "globalStorage",
          "kiro.kiroagent",
          "profile.json"
        ),
      ]
    default: {
      const paths: string[] = []
      const xdg = process.env.XDG_CONFIG_HOME?.trim()
      if (xdg) {
        paths.push(
          path.join(
            xdg,
            "Kiro",
            "User",
            "globalStorage",
            "kiro.kiroagent",
            "profile.json"
          )
        )
      }
      paths.push(
        path.join(
          home,
          ".config",
          "Kiro",
          "User",
          "globalStorage",
          "kiro.kiroagent",
          "profile.json"
        )
      )
      return paths
    }
  }
}

/** Format an epoch-seconds value as the ISO string the IDE cache stores. */
function toIsoExpiry(expiresAtSeconds: number | undefined): string {
  const sec =
    typeof expiresAtSeconds === "number" && expiresAtSeconds > 0
      ? expiresAtSeconds
      : Math.floor(Date.now() / 1000) + 3600
  return new Date(sec * 1000).toISOString()
}

function toRegistrationIsoExpiry(expiresAtSeconds: number | undefined): string {
  const sec =
    typeof expiresAtSeconds === "number" && expiresAtSeconds > 0
      ? expiresAtSeconds
      : Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60
  return new Date(sec * 1000).toISOString()
}

/**
 * Map an internal provider hint to the casing Kiro IDE writes. Defaults are
 * conservative: BuilderId for IdC, Google for social when unknown (the most
 * common social provider), so the file always carries a plausible value.
 */
function normalizeProvider(
  authMethod: KiroExportAuthMethod,
  provider: string | undefined
): string {
  const raw = (provider || "").trim()
  if (authMethod === "idc") {
    if (!raw) return "BuilderId"
    return raw.toLowerCase() === "builderid" ? "BuilderId" : raw
  }
  if (!raw) return "Google"
  const lower = raw.toLowerCase()
  if (lower === "google") return "Google"
  if (lower === "github") return "GitHub"
  return raw
}

function normalizeCliSocialProvider(provider: string | undefined): string {
  const raw = (provider || "").trim().toLowerCase()
  if (raw === "github") return "github"
  return "google"
}

function backupExistingFile(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) return undefined
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "")
    .replace("T", "_")
    .slice(0, 15)
  const backupPath = `${filePath}.bak.${stamp}`
  fs.copyFileSync(filePath, backupPath)
  return backupPath
}

/**
 * Write the Kiro IDE login cache for the given credentials. Returns the paths
 * touched so callers can surface them to the user.
 *
 * @throws when required fields for the chosen authMethod are missing.
 */
export function writeKiroIdeLogin(
  input: KiroIdeExportInput
): KiroIdeExportResult {
  const accessToken = (input.accessToken || "").trim()
  const refreshToken = (input.refreshToken || "").trim()
  if (!accessToken || !refreshToken) {
    throw new Error(
      "Cannot force Kiro IDE login: account is missing accessToken or refreshToken"
    )
  }

  const cacheDir = getKiroSsoCacheDir()
  fs.mkdirSync(cacheDir, { recursive: true })

  const tokenPath = path.join(cacheDir, "kiro-auth-token.json")
  const region = (input.region || "us-east-1").trim() || "us-east-1"
  const expiresAtIso = toIsoExpiry(input.expiresAt)

  let registrationPath: string | undefined
  let tokenPayload: Record<string, unknown>

  if (input.authMethod === "idc") {
    const clientId = (input.clientId || "").trim()
    const clientSecret = (input.clientSecret || "").trim()
    if (!clientId || !clientSecret) {
      throw new Error(
        "Cannot force Kiro IDE login for an IdC/Builder ID account without clientId and clientSecret"
      )
    }

    // Kiro IDE points the token file at its client registration via
    // `clientIdHash`, which is the basename of the `<hash>.json` registration
    // file living next to it. Derive a stable hash from the clientId so the
    // pairing is deterministic and re-runnable.
    const clientIdHash = crypto
      .createHash("sha1")
      .update(clientId)
      .digest("hex")

    registrationPath = path.join(cacheDir, `${clientIdHash}.json`)
    const registrationPayload = {
      clientId,
      clientSecret,
      expiresAt: toRegistrationIsoExpiry(input.registrationExpiresAt),
    }
    const regBackup = backupExistingFile(registrationPath)
    void regBackup
    fs.writeFileSync(
      registrationPath,
      JSON.stringify(registrationPayload, null, 2) + "\n",
      { mode: 0o600 }
    )

    tokenPayload = {
      accessToken,
      refreshToken,
      expiresAt: expiresAtIso,
      clientIdHash,
      authMethod: "IdC",
      provider: normalizeProvider("idc", input.provider),
      region,
    }
  } else {
    tokenPayload = {
      accessToken,
      refreshToken,
      ...(input.profileArn ? { profileArn: input.profileArn } : {}),
      expiresAt: expiresAtIso,
      authMethod: "social",
      provider: normalizeProvider("social", input.provider),
      region,
    }
  }

  const backupPath = backupExistingFile(tokenPath)
  fs.writeFileSync(tokenPath, JSON.stringify(tokenPayload, null, 2) + "\n", {
    mode: 0o600,
  })

  let profilePath: string | undefined
  const profileArn = (input.profileArn || "").trim()
  if (profileArn) {
    const profilePayload = {
      arn: profileArn,
      name: normalizeProvider(input.authMethod, input.provider),
    }
    for (const candidate of getKiroProfilePaths()) {
      const parent = path.dirname(candidate)
      if (!fs.existsSync(parent) && profilePath) continue
      fs.mkdirSync(parent, { recursive: true })
      backupExistingFile(candidate)
      fs.writeFileSync(
        candidate,
        JSON.stringify(profilePayload, null, 2) + "\n",
        {
          mode: 0o600,
        }
      )
      profilePath = profilePath || candidate
    }
  }

  return { tokenPath, registrationPath, profilePath, backupPath }
}

/**
 * Write the Kiro CLI login database for the given credentials.
 *
 * Current Kiro CLI accepts the pool accounts as `kirocli:social:token`.
 * The chat/KAS path also reads `~/.aws/sso/cache/kiro-auth-token-cli.json`.
 * Writing only the SQLite row makes `whoami` switch while `/usage` can keep
 * reading the old free-account token, so both stores are updated together.
 *
 * Writing the IdC-shaped `kirocli:odic:token` makes `whoami` look signed in,
 * but chat fails with an invalid/expired bearer token. Therefore this export
 * intentionally writes the CLI social token shape even for pool entries whose
 * Agent Vibes `authMethod` is `idc`.
 */
export function writeKiroCliLogin(
  input: KiroIdeExportInput
): KiroCliExportResult {
  const { DatabaseSync } = nodeRequire(
    "node:sqlite"
  ) as typeof import("node:sqlite")
  const accessToken = (input.accessToken || "").trim()
  const refreshToken = (input.refreshToken || "").trim()
  const profileArn = (input.profileArn || "").trim()
  if (!accessToken || !refreshToken) {
    throw new Error(
      "Cannot force Kiro CLI login: account is missing accessToken or refreshToken"
    )
  }
  if (!profileArn) {
    throw new Error(
      "Cannot force Kiro CLI login: account is missing profileArn"
    )
  }

  const dbPath = path.join(getKiroCliDataDir(), "data.sqlite3")
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      "Cannot force Kiro CLI login: Kiro CLI data.sqlite3 was not found; run Kiro CLI once first"
    )
  }

  const backupPath = backupExistingFile(dbPath)
  const expiresAtIso = toIsoExpiry(input.expiresAt)
  const provider = normalizeCliSocialProvider(input.provider)
  const tokenPayload = JSON.stringify({
    access_token: accessToken,
    expires_at: expiresAtIso,
    refresh_token: refreshToken,
    provider,
    profile_arn: profileArn,
  })
  const profilePayload = JSON.stringify({
    arn: profileArn,
    profile_name: "Social_Default_Profile",
  })
  const tokenPath = path.join(getKiroSsoCacheDir(), "kiro-auth-token-cli.json")
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true })
  const tokenBackupPath = backupExistingFile(tokenPath)
  fs.writeFileSync(
    tokenPath,
    JSON.stringify(
      {
        accessToken,
        refreshToken,
        expiresAt: expiresAtIso,
        profileArn,
        authMethod: "social",
        provider,
      },
      null,
      2
    ) + "\n",
    { mode: 0o600 }
  )

  const db = new DatabaseSync(dbPath)
  try {
    db.exec("BEGIN IMMEDIATE")
    try {
      db.exec(
        "CREATE TABLE IF NOT EXISTS auth_kv (key TEXT PRIMARY KEY, value TEXT)"
      )
      db.exec(
        "CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value BLOB)"
      )
      db.prepare(
        "DELETE FROM auth_kv WHERE key IN ('kirocli:social:token', 'kirocli:odic:token', 'kirocli:external-idp:token')"
      ).run()
      db.prepare("DELETE FROM state WHERE key IN (?, ?)").run(
        "api.codewhisperer.profile",
        "telemetry-cognito-credentials"
      )
      db.prepare(
        "INSERT OR REPLACE INTO auth_kv (key, value) VALUES (?, ?)"
      ).run("kirocli:social:token", tokenPayload)
      db.prepare("INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)").run(
        "api.codewhisperer.profile",
        profilePayload
      )
      db.exec("COMMIT")
    } catch (error) {
      try {
        db.exec("ROLLBACK")
      } catch {
        // Ignore rollback failures; the original write error is more useful.
      }
      throw error
    }
  } finally {
    db.close()
  }

  return { dbPath, tokenPath, backupPath, tokenBackupPath }
}
