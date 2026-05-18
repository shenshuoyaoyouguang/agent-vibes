/**
 * Append-only transcript + result store for background sub-agents.
 *
 * Layout (mirrors what claude-code's SDK uses for `~/.claude/sub-agents/`):
 *
 *   ~/.cursor/subagents/<agentId>/
 *     metadata.json   — single-shot status snapshot
 *                       { agentId, agentType, parentToolCallId, status,
 *                         startedAt, completedAt, durationMs,
 *                         turnCount, toolCallCount, modifiedFiles, ... }
 *     transcript.jsonl — one JSONL record per LLM turn / tool call
 *                        for live progress reading
 *     result.txt       — the final assistant text (set on success)
 *
 * The store is purely a sink; lifecycle is owned by SubagentTaskRegistry.
 * All writes are atomic at the record level (no locks required because the
 * bridge process is single-writer per subagentId).
 *
 * Why files instead of a database: parent agent's `read_file` tool can
 * point straight at `~/.cursor/subagents/<id>/transcript.jsonl` to "peek"
 * at progress without any new tool surface. Same trick claude-code uses.
 */

import { Injectable, Logger } from "@nestjs/common"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs"
import { homedir } from "os"
import { join } from "path"

export type SubagentTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "killed"
  | "interrupted"

export interface SubagentTaskMetadata {
  agentId: string
  agentType: string
  parentToolCallId: string
  parentConversationId: string
  status: SubagentTaskStatus
  startedAt: number
  completedAt?: number
  durationMs?: number
  turnCount: number
  toolCallCount: number
  modifiedFiles: string[]
  /** Final assistant text (also written to result.txt). */
  finalText?: string
  /** Set when status === "failed"; populated with the error message. */
  errorMessage?: string
  /**
   * Serialised TaskSuccess.conversationSteps[] payload — assistant /
   * thinking / toolCall steps as the worker accumulates them. Stored as
   * a JSON-friendly opaque blob so external readers can serve the same
   * detail-panel contents the parent task bubble would render in the
   * foreground path. The bridge writes this incrementally per turn so
   * partial progress is visible mid-run.
   */
  conversationSteps?: unknown[]
}

export interface SubagentTranscriptRecord {
  ts: number
  /** Discriminator. Keeps the JSONL file readable by humans and easy to
   * grep with simple tools. */
  kind:
    | "turn_start"
    | "assistant_text"
    | "thinking"
    | "tool_call_start"
    | "tool_call_end"
    | "turn_end"
    | "completed"
    | "failed"
    | "killed"
    | "interrupted"
  data: Record<string, unknown>
}

@Injectable()
export class SubagentTranscriptStore {
  private readonly logger = new Logger(SubagentTranscriptStore.name)

  /** Resolve the directory we write a given background sub-agent's
   * artefacts into. Created on demand. */
  getAgentDir(agentId: string): string {
    const dir = join(homedir(), ".cursor", "subagents", agentId)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  getTranscriptPath(agentId: string): string {
    return join(this.getAgentDir(agentId), "transcript.jsonl")
  }

  getMetadataPath(agentId: string): string {
    return join(this.getAgentDir(agentId), "metadata.json")
  }

  getResultPath(agentId: string): string {
    return join(this.getAgentDir(agentId), "result.txt")
  }

  /**
   * JSON.stringify replacer that turns BigInt values into base-10
   * strings. Required because conversationSteps[] embeds proto
   * ToolCall envelopes whose generated TypeScript types use bigint for
   * 64-bit integer fields (exit codes / durations / etc.). Without
   * this replacer, every metadata write throws
   * `TypeError: Do not know how to serialize a BigInt` and the
   * mid-run progress sync silently fails — leaving turnCount /
   * toolCallCount frozen at spawn-time zeros.
   */
  private static stringifyMetadata(value: unknown): string {
    return JSON.stringify(
      value,
      (_key: string, raw: unknown): unknown =>
        typeof raw === "bigint" ? raw.toString() : raw,
      2
    )
  }

  /** Initial metadata write at spawn time. Overwrites any prior content
   * for this id (collisions shouldn't happen because agentId is
   * timestamp+random). */
  initMetadata(metadata: SubagentTaskMetadata): void {
    try {
      writeFileSync(
        this.getMetadataPath(metadata.agentId),
        `${SubagentTranscriptStore.stringifyMetadata(metadata)}\n`,
        "utf8"
      )
    } catch (error) {
      this.logger.error(
        `Failed to write metadata for ${metadata.agentId}: ${String(error)}`
      )
    }
  }

  /** Read current metadata for an agent. Returns undefined if the agent
   * directory doesn't exist or metadata is corrupted (we don't try to
   * recover — registry should treat missing metadata as "no such task"). */
  readMetadata(agentId: string): SubagentTaskMetadata | undefined {
    const path = this.getMetadataPath(agentId)
    if (!existsSync(path)) return undefined
    try {
      const raw = readFileSync(path, "utf8")
      const parsed = JSON.parse(raw) as SubagentTaskMetadata
      return parsed
    } catch (error) {
      this.logger.warn(
        `Failed to read metadata for ${agentId}: ${String(error)}`
      )
      return undefined
    }
  }

  /** Atomic-ish update — read, mutate, write. Single-writer per agentId
   * so race-free. */
  updateMetadata(
    agentId: string,
    mutator: (current: SubagentTaskMetadata) => SubagentTaskMetadata
  ): SubagentTaskMetadata | undefined {
    const current = this.readMetadata(agentId)
    if (!current) return undefined
    const next = mutator(current)
    try {
      writeFileSync(
        this.getMetadataPath(agentId),
        `${SubagentTranscriptStore.stringifyMetadata(next)}\n`,
        "utf8"
      )
      return next
    } catch (error) {
      this.logger.error(
        `Failed to update metadata for ${agentId}: ${String(error)}`
      )
      return undefined
    }
  }

  /** Append a record to the transcript JSONL. */
  appendTranscript(agentId: string, record: SubagentTranscriptRecord): void {
    try {
      appendFileSync(
        this.getTranscriptPath(agentId),
        `${JSON.stringify(record)}\n`,
        "utf8"
      )
    } catch (error) {
      this.logger.warn(
        `Failed to append transcript for ${agentId}: ${String(error)}`
      )
    }
  }

  /** Write the final assistant text to result.txt. Truncates anything
   * previously there (background sub-agent has exactly one final
   * answer). */
  writeResult(agentId: string, text: string): void {
    try {
      writeFileSync(this.getResultPath(agentId), text, "utf8")
    } catch (error) {
      this.logger.error(
        `Failed to write result for ${agentId}: ${String(error)}`
      )
    }
  }
}
