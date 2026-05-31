import { Injectable, Logger } from "@nestjs/common"
import type { StatementSync } from "node:sqlite"
import { PersistenceService } from "../../../persistence"
import type { ToolResultBlock } from "../../../context/types"
import type { ConversationId, TurnId } from "../turn/turn.types"

/**
 * SessionTxn — opaque token threaded through the message-store / ledger
 * write APIs to enforce that every paired write happens inside the same
 * SQLite transaction.
 *
 * The token is materialised by `MessageStore.runInTransaction`. Holding
 * an instance proves you are inside an active BEGIN/COMMIT pair, and
 * the underlying `database` reference lets the ledger and message-store
 * services share prepared statements without re-wiring DI on every
 * call.
 *
 * The shape is intentionally minimal: no public `database` field on the
 * actual class so call sites cannot reach around the txn discipline
 * (the field is `readonly` and accessed via the package-internal
 * symbol re-export below).
 */
export interface SessionTxn {
  readonly conversationId: ConversationId
  readonly tag: typeof SESSION_TXN_TAG
}

/**
 * Tag carried on every SessionTxn so callers from outside this module
 * cannot fabricate one. Exported only as a type-level brand.
 */
export const SESSION_TXN_TAG: unique symbol = Symbol("SessionTxn")

/**
 * Internal accessor used by services in this directory to thread the
 * shared persistence handle through the txn token. Not exported from
 * the package barrel.
 */
export interface SessionTxnInternal extends SessionTxn {
  readonly persistence: PersistenceService
}

export type AbortReason =
  | "bidi_teardown"
  | "turn_superseded"
  | "user_cancelled"
  | "shutdown"
  | "stream_failed"
  | "deadline_expired"

interface OpenLedgerArgs {
  toolUseId: string
  toolName: string
  turnId: TurnId
  /** Sequence id of the tool_use block in session_messages. */
  openMessageSeq: number
}

interface CloseLedgerArgs {
  toolUseId: string
  /** Sequence id of the tool_result block in session_messages. */
  closeMessageSeq: number
}

interface AbortAllArgs {
  turnId: TurnId
  reason: AbortReason
}

interface AbortAllResult {
  abortedToolCallIds: Array<{
    toolUseId: string
    toolName: string
    openMessageSeq: number
  }>
}

interface OpenEntry {
  toolUseId: string
  toolName: string
  openMessageSeq: number
}

/**
 * ToolCallLedger
 *
 * Single source of truth for the tool_use ↔ tool_result protocol. Every
 * entry transitions strictly:
 *
 *   open → closed   (normal tool result received)
 *   open → aborted  (cleanup coordinator drained the turn)
 *
 * `aborted` carries a structured `AbortReason` that is also written into
 * a synthetic `is_error: true` tool_result block on the transcript by
 * the cleanup coordinator (see TurnCleanupCoordinator). Together they
 * guarantee that no orphan tool_use can ever reach a backend request,
 * which is what the deleted sanitize/enforceToolProtocol pipeline used
 * to paper over after the fact.
 *
 * All write paths require a `SessionTxn` so the ledger row and the
 * matching `session_messages` row land in the same SQLite transaction.
 */
@Injectable()
export class ToolCallLedger {
  private readonly logger = new Logger(ToolCallLedger.name)

  // Prepared statements are cached lazily on first use. We can't
  // prepare them at boot because the persistence service may not be
  // initialised yet when DI wires this provider in tests.
  private stmtInsertOpen?: StatementSync
  private stmtClose?: StatementSync
  private stmtAbort?: StatementSync
  private stmtListOpenForTurn?: StatementSync
  private stmtListOpenForConversation?: StatementSync
  private stmtIsOpen?: StatementSync

  constructor(private readonly persistence: PersistenceService) {}

  /**
   * Record a fresh tool_use. Must be called inside the same transaction
   * as the message-store append for the corresponding tool_use block.
   */
  open(txn: SessionTxn, args: OpenLedgerArgs): void {
    this.assertTxn(txn)
    const stmt = (this.stmtInsertOpen ??= this.persistence.prepare(
      `INSERT INTO tool_call_ledger (
         conversation_id,
         tool_use_id,
         turn_id,
         tool_name,
         state,
         opened_at,
         open_message_seq
       ) VALUES (?, ?, ?, ?, 'open', ?, ?)`
    ))
    stmt.run(
      txn.conversationId,
      args.toolUseId,
      args.turnId,
      args.toolName,
      Date.now(),
      args.openMessageSeq
    )
  }

  /**
   * Mark a tool_use as closed by a real tool_result. Must be called in
   * the same transaction as the message-store append for the result.
   */
  close(txn: SessionTxn, args: CloseLedgerArgs): void {
    this.assertTxn(txn)
    const stmt = (this.stmtClose ??= this.persistence.prepare(
      `UPDATE tool_call_ledger
         SET state = 'closed',
             closed_at = ?,
             close_message_seq = ?
       WHERE conversation_id = ?
         AND tool_use_id = ?
         AND state = 'open'`
    ))
    const result = stmt.run(
      Date.now(),
      args.closeMessageSeq,
      txn.conversationId,
      args.toolUseId
    )
    const changes = (result as { changes?: number }).changes ?? 0
    if (changes === 0) {
      // Either the tool_use was never opened (caller bug), already
      // closed (double-close), or already aborted (close raced with
      // cleanup). Each case is a contract violation worth logging
      // loudly so the test suite catches it instead of silently
      // missing a ledger update.
      throw new Error(
        `ToolCallLedger.close: no open ledger entry for ` +
          `conversation=${txn.conversationId} toolUseId=${args.toolUseId}`
      )
    }
  }

  /**
   * Drain every open ledger entry for the supplied turn into the
   * `aborted` state. Returns the metadata each caller needs to write
   * the matching synthetic tool_result block on the transcript.
   *
   * Empty result is fine — it just means the turn had no in-flight
   * tools at cleanup time (e.g. it failed before any tool batch).
   */
  abortAll(txn: SessionTxn, args: AbortAllArgs): AbortAllResult {
    this.assertTxn(txn)
    const list = (this.stmtListOpenForTurn ??= this.persistence.prepare(
      `SELECT tool_use_id, tool_name, open_message_seq
         FROM tool_call_ledger
        WHERE conversation_id = ?
          AND turn_id = ?
          AND state = 'open'`
    ))
    const rows = list.all(txn.conversationId, args.turnId) as unknown as Array<{
      tool_use_id: string
      tool_name: string
      open_message_seq: number
    }>
    if (rows.length === 0) {
      return { abortedToolCallIds: [] }
    }

    const abort = (this.stmtAbort ??= this.persistence.prepare(
      `UPDATE tool_call_ledger
         SET state = 'aborted',
             closed_at = ?,
             abort_reason = ?
       WHERE conversation_id = ?
         AND tool_use_id = ?
         AND state = 'open'`
    ))
    const now = Date.now()
    for (const row of rows) {
      abort.run(now, args.reason, txn.conversationId, row.tool_use_id)
    }

    this.logger.log(
      `Ledger aborted ${rows.length} tool call(s) for turn=${args.turnId} ` +
        `conversation=${txn.conversationId} reason=${args.reason}`
    )

    return {
      abortedToolCallIds: rows.map((row) => ({
        toolUseId: row.tool_use_id,
        toolName: row.tool_name,
        openMessageSeq: row.open_message_seq,
      })),
    }
  }

  /**
   * Read-only check used by the message-store to assert that
   * appendToolResultBlock targets a legitimately open ledger entry.
   */
  isOpen(conversationId: ConversationId, toolUseId: string): boolean {
    const stmt = (this.stmtIsOpen ??= this.persistence.prepare(
      `SELECT 1
         FROM tool_call_ledger
        WHERE conversation_id = ?
          AND tool_use_id = ?
          AND state = 'open'
        LIMIT 1`
    ))
    return stmt.get(conversationId, toolUseId) !== undefined
  }

  /**
   * Snapshot of currently-open tool calls for a conversation. Used by
   * cleanup-coordinator decisions and by diagnostics.
   */
  listOpen(conversationId: ConversationId): OpenEntry[] {
    const stmt = (this.stmtListOpenForConversation ??= this.persistence.prepare(
      `SELECT tool_use_id, tool_name, open_message_seq
           FROM tool_call_ledger
          WHERE conversation_id = ?
            AND state = 'open'
          ORDER BY open_message_seq ASC`
    ))
    const rows = stmt.all(conversationId) as unknown as Array<{
      tool_use_id: string
      tool_name: string
      open_message_seq: number
    }>
    return rows.map((row) => ({
      toolUseId: row.tool_use_id,
      toolName: row.tool_name,
      openMessageSeq: row.open_message_seq,
    }))
  }

  /**
   * Build the structured abort tool_result block written alongside the
   * `aborted` ledger entry. Centralised here so the format is consistent
   * across every abort path (bidi teardown, supersede, user cancel,
   * deadline expiry, shutdown, stream failure).
   */
  static buildAbortToolResult(
    toolUseId: string,
    reason: AbortReason
  ): ToolResultBlock {
    return {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: [{ type: "text", text: `[abort:${reason}]` }],
      is_error: true,
    }
  }

  private assertTxn(txn: SessionTxn): void {
    if (!txn || txn.tag !== SESSION_TXN_TAG) {
      throw new Error(
        "ToolCallLedger: write methods require a SessionTxn from MessageStore.runInTransaction()"
      )
    }
  }
}
