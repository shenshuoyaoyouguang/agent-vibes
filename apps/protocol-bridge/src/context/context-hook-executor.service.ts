import { Injectable, Logger } from "@nestjs/common"
import { spawn } from "child_process"
import { statSync } from "fs"
import * as path from "path"

/**
 * Bridge-side analogue of the cursor IDE's `ExecuteHookRequest{preCompact}`
 * pipeline.
 *
 * The cursor protocol defines a `PreCompactRequestQuery` that travels
 * **inside the IDE process** — `cursor-agent-exec` fires it before its
 * own internal compaction runs, then a project-scoped hook executor
 * shells out to a user-defined script in `.cursor/hooks/preCompact*`
 * and threads the script's stdout into the resulting summary.
 *
 * In the agent-vibes deployment `cursor-agent-exec` is bypassed (the
 * bridge is the agent runtime), so the IDE-side hook flow never fires.
 * To stay aligned with the protocol's user-facing contract — "if you
 * drop a `.cursor/hooks/preCompact` script into your repo it runs
 * before each compaction" — the bridge mounts its own equivalent
 * executor here. This is the **bridge half of the dual-track design**:
 *
 *   - When `cursor-agent-exec` owns the conversation, the IDE runs the
 *     hook (we never see compaction at all).
 *   - When the bridge owns the conversation, this service runs the
 *     same hook script with the same shape of input + output, so the
 *     user-visible behaviour is identical.
 *
 * Hook resolution mirrors the `claude-code` convention to keep one
 * mental model for users:
 *
 *   1. `<workspaceRoot>/.cursor/hooks/preCompact`         — executable
 *   2. `<workspaceRoot>/.cursor/hooks/preCompact.sh`      — shell
 *   3. `<workspaceRoot>/.cursor/hooks/preCompact.mjs|.js` — node
 *
 * The first one that exists wins. The hook receives a JSON payload on
 * stdin describing the upcoming compaction (trigger, message counts,
 * conversation id, model, etc — same shape as the proto
 * `PreCompactRequestQuery`) and returns either:
 *
 *   - plain text on stdout → used verbatim as `user_message`, OR
 *   - a JSON object `{"user_message": "..."}` → the `user_message`
 *     field is extracted (matches the proto `PreCompactRequestResponse`
 *     shape).
 *
 * Empty stdout is treated as "no augmentation"; non-zero exit code is
 * logged but does not fail the compaction (the user's hook should not
 * be able to brick their own context window — defensive posture).
 *
 * The executor is intentionally minimal: hard 5 second timeout, output
 * capped at 64 KB, no shell features beyond what the script itself
 * uses. Anything fancier belongs in the user's script.
 */
@Injectable()
export class ContextHookExecutorService {
  private readonly logger = new Logger(ContextHookExecutorService.name)

  /**
   * Run the project-scoped `.cursor/hooks/preCompact` script if it
   * exists and return the `user_message` it produced (or `undefined`
   * when no hook is present / the hook produced no output).
   *
   * Never throws. A misbehaving hook only logs a warning and resolves
   * with `undefined` so the caller can fall through to the bridge's
   * default summary path.
   */
  async runPreCompactHook(
    workspaceRootPath: string | undefined,
    payload: PreCompactHookPayload
  ): Promise<string | undefined> {
    if (!workspaceRootPath) {
      return undefined
    }
    const hook = this.resolvePreCompactHook(workspaceRootPath)
    if (!hook) {
      return undefined
    }

    this.logger.log(
      `Running .cursor/hooks/preCompact (${hook.kind}) for ` +
        `conversation=${payload.conversation_id || "(none)"} ` +
        `trigger=${payload.trigger}`
    )

    try {
      const stdout = await this.spawnHook(hook, payload)
      const userMessage = this.extractUserMessage(stdout)
      if (userMessage) {
        this.logger.log(
          `preCompact hook returned user_message (${userMessage.length} chars)`
        )
      }
      return userMessage
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn(`preCompact hook failed: ${message}`)
      return undefined
    }
  }

  private resolvePreCompactHook(
    workspaceRootPath: string
  ): ResolvedHook | undefined {
    const hooksDir = path.join(workspaceRootPath, ".cursor", "hooks")
    if (!this.dirExists(hooksDir)) {
      return undefined
    }

    // Resolution order matters — we prefer an explicit shebang script
    // over `.sh`/`.js` so users who carefully set up an executable
    // get the most direct dispatch.
    const candidates: Array<{ rel: string; kind: HookKind }> = [
      { rel: "preCompact", kind: "executable" },
      { rel: "preCompact.sh", kind: "shell" },
      { rel: "preCompact.mjs", kind: "node" },
      { rel: "preCompact.js", kind: "node" },
      { rel: "preCompact.cjs", kind: "node" },
    ]

    for (const candidate of candidates) {
      const abs = path.join(hooksDir, candidate.rel)
      if (this.fileExists(abs)) {
        return { absPath: abs, kind: candidate.kind }
      }
    }
    return undefined
  }

  private async spawnHook(
    hook: ResolvedHook,
    payload: PreCompactHookPayload
  ): Promise<string> {
    const HOOK_TIMEOUT_MS = 5_000
    const HOOK_OUTPUT_CAP = 64 * 1024

    const { command, args } = this.buildHookCommand(hook)

    return new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, {
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      })

      let stdout = ""
      let truncated = false
      let settled = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          child.kill("SIGKILL")
        } catch {
          // best-effort kill
        }
        reject(
          new Error(
            `hook timed out after ${HOOK_TIMEOUT_MS}ms (script: ${hook.absPath})`
          )
        )
      }, HOOK_TIMEOUT_MS)

      child.stdout?.on("data", (chunk: Buffer) => {
        if (truncated) return
        const remaining = HOOK_OUTPUT_CAP - stdout.length
        if (remaining <= 0) {
          truncated = true
          return
        }
        const text = chunk.toString("utf8")
        if (text.length > remaining) {
          stdout += text.slice(0, remaining)
          truncated = true
        } else {
          stdout += text
        }
      })

      child.stderr?.on("data", (chunk: Buffer) => {
        // Echo stderr into the bridge log so the user can debug their
        // hook script. We only keep the last 4 KB to stay polite.
        const trimmed = chunk.toString("utf8").slice(0, 4096).trimEnd()
        if (trimmed) {
          this.logger.debug(`preCompact hook stderr: ${trimmed}`)
        }
      })

      child.on("error", (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      })

      child.on("close", (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (code !== 0) {
          this.logger.warn(
            `preCompact hook exited with code=${code} (output ignored)`
          )
          resolve("")
          return
        }
        resolve(stdout)
      })

      try {
        child.stdin?.write(JSON.stringify(payload))
        child.stdin?.end()
      } catch (err) {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      }
    })
  }

  /**
   * Decide how to invoke the hook script. We do not require the user
   * to chmod +x the file — we pick a sensible interpreter based on
   * file extension, falling back to the system shell. This keeps the
   * "drop a file in .cursor/hooks/ and it just works" UX.
   */
  private buildHookCommand(hook: ResolvedHook): {
    command: string
    args: string[]
  } {
    switch (hook.kind) {
      case "node":
        return { command: process.execPath, args: [hook.absPath] }
      case "shell":
        return { command: "bash", args: [hook.absPath] }
      case "executable":
        // For an extension-less file we honour its shebang when the
        // file is executable; otherwise we default to bash. We could
        // call statSync to check the +x bit, but spawning bash on a
        // text file is harmless and avoids one more syscall.
        if (this.isExecutable(hook.absPath)) {
          return { command: hook.absPath, args: [] }
        }
        return { command: "bash", args: [hook.absPath] }
    }
  }

  private extractUserMessage(stdout: string): string | undefined {
    const trimmed = stdout.trim()
    if (!trimmed) {
      return undefined
    }

    // If the hook follows the proto `PreCompactRequestResponse` shape
    // (`{"user_message": "..."}`), pull the field out. Otherwise treat
    // the whole stdout as the message — that matches what most
    // claude-code hook scripts do today.
    if (trimmed.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (parsed && typeof parsed === "object") {
          const obj = parsed as Record<string, unknown>
          const candidate = obj.user_message ?? obj.userMessage ?? obj.message
          if (typeof candidate === "string" && candidate.trim()) {
            return candidate.trim()
          }
          // JSON object without a recognisable key → treat as no-op
          return undefined
        }
      } catch {
        // Not valid JSON → fall through to plain-text path.
      }
    }
    return trimmed
  }

  private dirExists(absPath: string): boolean {
    try {
      return statSync(absPath).isDirectory()
    } catch {
      return false
    }
  }

  private fileExists(absPath: string): boolean {
    try {
      return statSync(absPath).isFile()
    } catch {
      return false
    }
  }

  private isExecutable(absPath: string): boolean {
    try {
      const stat = statSync(absPath)
      // Owner-execute bit. Cross-platform "is this thing executable"
      // detection is famously rough — this matches what Cursor's own
      // hook executor does on macOS / Linux. Windows users are
      // expected to use the `.sh` / `.mjs` variants.
      return (stat.mode & 0o100) !== 0
    } catch {
      return false
    }
  }
}

export type HookKind = "executable" | "shell" | "node"

interface ResolvedHook {
  absPath: string
  kind: HookKind
}

/**
 * Shape of the payload the bridge writes to the hook's stdin.
 *
 * Matches `agent.v1.PreCompactRequestQuery` field-for-field — same
 * snake-case wire names — so a user can write a single hook script
 * that works whether the cursor IDE or the bridge fires it.
 */
export interface PreCompactHookPayload {
  /**
   * Trigger reason. The cursor protocol enumerates `"manual"`,
   * `"automatic"`, and `"context_full"` as the canonical values;
   * future versions may add more, so we keep the field a free-form
   * string. Hook scripts should switch on the canonical values and
   * treat anything else as `"automatic"`.
   */
  trigger: string
  context_usage_percent: number
  context_tokens: number
  context_window_size: number
  message_count: number
  messages_to_compact: number
  is_first_compaction: boolean
  conversation_id?: string
  generation_id?: string
  model?: string
}
