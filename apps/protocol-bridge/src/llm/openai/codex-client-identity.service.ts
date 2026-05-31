/**
 * CodexClientIdentityService
 * --------------------------
 * Resolves the version / User-Agent / originator headers the bridge sends to
 * `chatgpt.com/backend-api/codex` so they match what an actual openai/codex
 * CLI on this host would send.
 *
 * Why this exists:
 *   chatgpt.com gates new model availability (e.g. `gpt-5.5`) on the `version`
 *   header.  Hardcoding a version means every server-side gate eventually
 *   bricks the bridge with `HTTP 400 "requires a newer version of Codex"`.
 *   Detect the local CLI version once at boot and reuse it for the lifetime
 *   of the process.
 *
 * Resolution order (highest precedence first):
 *   1. AGENT_VIBES_CODEX_VERSION env var.
 *   2. `codex --version` on the host's PATH (cross-platform via `spawn`).
 *   3. Hardcoded fallback (kept current with upstream stable releases; bump
 *      this constant when the upstream codex CLI ships a new tag and the
 *      server starts gating on it).
 *
 * Detection failures never throw and never block startup — we log one warn
 * line and continue with the fallback.  The codex backend will surface a
 * clear server-side error if the resolved version is later rejected, which
 * is a much better failure mode than crashing the bridge at boot on a host
 * without the CLI installed.
 *
 * Originator is hardcoded to `codex_cli_rs` to match upstream's
 * `codex-rs/login/src/auth/default_client.rs:DEFAULT_ORIGINATOR`. The server
 * uses this value for first-party-client detection and treats `codex-tui`
 * (an older alias) as grandfathered but no longer canonical.
 */

import { Injectable, Logger, OnModuleInit } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { spawn } from "child_process"
import * as os from "os"

const ORIGINATOR = "codex_cli_rs"
/**
 * Last-resort version when both env override and CLI detection miss. Bump in
 * lockstep with whatever the latest upstream stable codex tag is at the time
 * of release. As of 2026-05 the latest stable is rust-v0.133.0.
 */
const FALLBACK_VERSION = "0.133.0"
const DETECTION_TIMEOUT_MS = 3_000
const ENV_OVERRIDE_KEY = "AGENT_VIBES_CODEX_VERSION"

export type CodexClientIdentitySource = "env" | "detected" | "fallback"

@Injectable()
export class CodexClientIdentityService implements OnModuleInit {
  private readonly logger = new Logger(CodexClientIdentityService.name)
  private resolvedVersion: string = FALLBACK_VERSION
  private resolvedUserAgent: string = this.buildUserAgent(FALLBACK_VERSION)
  private resolvedSource: CodexClientIdentitySource = "fallback"

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const override = (
      this.configService.get<string>(ENV_OVERRIDE_KEY, "") || ""
    ).trim()
    if (override) {
      this.applyResolution(override, "env")
      this.logger.log(
        `Codex client identity: version=${override} (source=env, ${ENV_OVERRIDE_KEY})`
      )
      return
    }

    const detected = await this.detectFromCli()
    if (detected) {
      this.applyResolution(detected, "detected")
      this.logger.log(
        `Codex client identity: version=${detected} (source=local codex --version)`
      )
      return
    }

    // Fallback already applied via field initializers; emit a single warn so
    // operators know future server-side gates may bite.
    this.logger.warn(
      `Codex CLI not detected on PATH; falling back to version ${FALLBACK_VERSION}. ` +
        `If chatgpt.com starts rejecting newer models with "requires a newer version of Codex", ` +
        `install/upgrade the codex CLI on this host or set ${ENV_OVERRIDE_KEY}.`
    )
  }

  /** Version string sent in the `version` HTTP / WebSocket header. */
  version(): string {
    return this.resolvedVersion
  }

  /** Full User-Agent header. */
  userAgent(): string {
    return this.resolvedUserAgent
  }

  /** Originator header (`codex_cli_rs`). Constant by design. */
  originator(): string {
    return ORIGINATOR
  }

  /** Where the version came from. Useful for diagnostics endpoints. */
  source(): CodexClientIdentitySource {
    return this.resolvedSource
  }

  private applyResolution(
    version: string,
    source: CodexClientIdentitySource
  ): void {
    this.resolvedVersion = version
    this.resolvedUserAgent = this.buildUserAgent(version)
    this.resolvedSource = source
  }

  /**
   * Build a User-Agent string mirroring upstream's format
   * (codex-rs/login/src/auth/default_client.rs:get_codex_user_agent):
   *
   *   {originator}/{version} ({osType} {osRelease}; {arch}) {terminal}
   *
   * Node doesn't ship marketing-name OS detection (macOS reports
   * `Darwin 25.3.0` instead of `Mac OS 26.3.1`), but the chatgpt backend
   * gates on the `version` header and only reads UA for telemetry — exact
   * OS string parity isn't required. The trailing `unknown` matches what
   * upstream's terminal-detection crate emits when it can't identify a TTY,
   * which is the right thing for a daemon process anyway.
   */
  private buildUserAgent(version: string): string {
    const osType = this.safeOsField(() => os.type()) || "unknown"
    const osRelease = this.safeOsField(() => os.release()) || "unknown"
    const arch = process.arch || "unknown"
    return `${ORIGINATOR}/${version} (${osType} ${osRelease}; ${arch}) unknown`
  }

  private safeOsField(fn: () => string): string {
    try {
      return fn()
    } catch {
      return ""
    }
  }

  /**
   * Run `codex --version` on the host. Resolves to the parsed semver string
   * (e.g. `"0.133.0"` or `"0.134.0-alpha.3"`) or `undefined` if the CLI is
   * not installed / errored / timed out.
   *
   * Implementation notes:
   * - `spawn` (not `exec`) so we can enforce a hard timeout and avoid shell
   *   interpolation. PATH lookup is the OS's job.
   * - On Windows, Node resolves `codex` to `codex.cmd` / `codex.exe`
   *   automatically when given a bare command name. `windowsHide: true`
   *   prevents a console window from flashing.
   * - ENOENT (CLI not installed) arrives via the `error` event with
   *   `err.code === "ENOENT"` — we degrade silently to fallback.
   */
  private async detectFromCli(): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve) => {
      let stdout = ""
      let stderr = ""
      let settled = false
      const settle = (value: string | undefined): void => {
        if (settled) return
        settled = true
        resolve(value)
      }

      let child: ReturnType<typeof spawn>
      try {
        child = spawn("codex", ["--version"], {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          shell: false,
        })
      } catch (err) {
        this.logger.debug(
          `codex --version spawn threw synchronously: ${String(err)}`
        )
        settle(undefined)
        return
      }

      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* ignore */
        }
        this.logger.debug(
          `codex --version timed out after ${DETECTION_TIMEOUT_MS}ms`
        )
        settle(undefined)
      }, DETECTION_TIMEOUT_MS)

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        if (err.code === "ENOENT") {
          this.logger.debug("codex CLI not on PATH")
        } else {
          this.logger.debug(`codex --version errored: ${err.message}`)
        }
        settle(undefined)
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        if (code !== 0) {
          this.logger.debug(
            `codex --version exited with code ${code}: ${stderr.trim() || "(no stderr)"}`
          )
          settle(undefined)
          return
        }
        // Output formats observed in the wild:
        //   "codex-cli 0.133.0\n"
        //   "codex 0.133.0\n"
        //   "0.134.0-alpha.3\n"
        // Match the first semver-shaped token, optionally followed by a
        // pre-release tag.
        const match = stdout.trim().match(/(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)/)
        if (!match) {
          this.logger.debug(
            `codex --version output not parseable: ${JSON.stringify(stdout.trim())}`
          )
          settle(undefined)
          return
        }
        settle(match[1])
      })
    })
  }
}
