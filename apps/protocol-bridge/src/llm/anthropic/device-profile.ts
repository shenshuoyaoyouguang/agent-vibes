/**
 * Claude Code CLI device-fingerprint headers.
 *
 * Real CC CLI emits the full Stainless SDK device-profile header set on
 * every request:
 *
 *   User-Agent:                claude-cli/<cc-version> (external, cli)
 *   X-Stainless-Lang:          js
 *   X-Stainless-Runtime:       node
 *   X-Stainless-Runtime-Version: v24.3.0
 *   X-Stainless-Package-Version: 0.94.0
 *   X-Stainless-Os:            MacOS | Linux | Windows | FreeBSD | Other::<go-os>
 *   X-Stainless-Arch:          x64 | arm64 | x86 | other::<go-arch>
 *   X-Stainless-Retry-Count:   0
 *   X-Stainless-Timeout:       600
 *
 * Anthropic uses the OS/Arch pair plus the package + runtime versions as a
 * fingerprinting signal; missing or non-canonical values nudge the request
 * into the "third-party SDK" classification bucket.
 *
 * `cc-version` is resolved dynamically from the locally-installed Claude
 * Code binary via `claude --version` (see `getDefaultCcVersion`), with a
 * pinned fallback. The Stainless package version is read from the
 * embedded `UB = "0.94.0"` constant in the bundled `@anthropic-ai/sdk`
 * chunk; that hasn't moved across recent CC releases so we hold it
 * steady, but allow override via env var so it can be rolled forward
 * without a code change.
 */

import { getDefaultCcVersion } from "./claude-code-instructions"

export interface ClaudeDeviceProfile {
  userAgent: string
  packageVersion: string
  runtimeVersion: string
  os: string
  arch: string
}

const DEFAULT_PACKAGE_VERSION =
  process.env.AGENT_VIBES_STAINLESS_PACKAGE_VERSION_OVERRIDE?.trim() || "0.94.0"
const DEFAULT_RUNTIME_VERSION =
  process.env.AGENT_VIBES_STAINLESS_RUNTIME_VERSION_OVERRIDE?.trim() ||
  "v24.3.0"

/**
 * Map Node's `process.platform` to the Stainless SDK OS string CC CLI
 * emits.
 */
export function stainlessOsName(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "MacOS"
    case "win32":
      return "Windows"
    case "linux":
      return "Linux"
    case "freebsd":
      return "FreeBSD"
    default:
      return `Other::${platform}`
  }
}

/**
 * Map Node's `process.arch` to the Stainless SDK arch string.
 */
export function stainlessArchName(arch: NodeJS.Architecture): string {
  switch (arch) {
    case "x64":
      return "x64"
    case "arm64":
      return "arm64"
    case "ia32":
      return "x86"
    default:
      return `other::${arch}`
  }
}

let cachedProfile: ClaudeDeviceProfile | null = null

/**
 * Return the canonical CC CLI device fingerprint for the current process.
 * Memoised because the values are stable for the lifetime of the bridge,
 * and resolving the CC version spawns the local `claude` binary once.
 */
export function getDefaultClaudeDeviceProfile(): ClaudeDeviceProfile {
  if (cachedProfile) return cachedProfile
  cachedProfile = {
    userAgent: `claude-cli/${getDefaultCcVersion()} (external, cli)`,
    packageVersion: DEFAULT_PACKAGE_VERSION,
    runtimeVersion: DEFAULT_RUNTIME_VERSION,
    os: stainlessOsName(process.platform),
    arch: stainlessArchName(process.arch),
  }
  return cachedProfile
}

/**
 * Reset the memoised profile. Exposed for tests.
 */
export function resetClaudeDeviceProfileCache(): void {
  cachedProfile = null
}

/**
 * Apply the device-profile fingerprint to an outbound request header bag,
 * never overriding values the upstream caller already supplied.
 */
export function applyClaudeDeviceProfileHeaders(
  headers: Record<string, string>,
  profile: ClaudeDeviceProfile = getDefaultClaudeDeviceProfile()
): void {
  setIfMissing(headers, "user-agent", profile.userAgent)
  setIfMissing(headers, "x-stainless-lang", "js")
  setIfMissing(headers, "x-stainless-runtime", "node")
  setIfMissing(headers, "x-stainless-runtime-version", profile.runtimeVersion)
  setIfMissing(headers, "x-stainless-package-version", profile.packageVersion)
  setIfMissing(headers, "x-stainless-os", profile.os)
  setIfMissing(headers, "x-stainless-arch", profile.arch)
  setIfMissing(headers, "x-stainless-retry-count", "0")
  setIfMissing(headers, "x-stainless-timeout", "600")
}

function setIfMissing(
  headers: Record<string, string>,
  name: string,
  value: string
): void {
  if (!headers[name]) {
    headers[name] = value
  }
}
