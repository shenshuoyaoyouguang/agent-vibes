import { Injectable, Logger } from "@nestjs/common"
import type { StatementSync } from "node:sqlite"
import { PersistenceService } from "../../../persistence"
import type { ContentBlock, ToolResultBlock } from "../../../context/types"
import type { ConversationId, TurnId } from "../turn/turn.types"
import {
  ToolCallLedger,
  type SessionTxn,
  type SessionTxnInternal,
  SESSION_TXN_TAG,
} from "./tool-call-ledger.service"

/**
 * AssistantContentBlock — the shapes the bridge actually persists into
 * the assistant role of the v2 transcript. Excludes ToolResultBlock
 * (those are user-role) and CacheEditsBlock (a wire-only construct).
 */
export type AssistantContentBlock = Exclude<
  ContentBlock,
  ToolResultBlock | { type: "cache_edits" }
>

export interface AssistantBlockOpts {
  turnId: TurnId
  /** Anthropic message id for split-sibling merging. */
  messageId?: string
  /** Optional usage / stop_reason / requestId metadata. */
  metadata?: Record<string, unknown>
}

export interface ToolResultBlockOpts {
  turnId: TurnId
  metadata?: Record<string, unknown>
}

export interface UserMessageOpts {
  turnId?: TurnId
  isMeta?: boolean
  metadata?: Record<string, unknown>
}

export interface PersistedMessage {
  conversationId: ConversationId
  seq: number
  uuid: string
  messageId?: string
  role: "user" | "assistant"
  isMeta: boolean
  timestamp: number
  content: ContentBlock[]
  metadata?: Record<string, unknown>
}

export interface AppendResult {
  recordUuid: string
  seq: number
}

/**
 * MessageStore
 *
 * Append-only owner of the v2 transcript (`session_messages` table).
 * Every write goes through `runInTransaction` so the matching ledger
 * update can be performed atomically: SQLite either commits both rows
 * or rolls them back together.
 *
 * Compared with the deleted SessionLifecycleService.replaceMessages /
 * addMessage path:
 *
 * - No live array aliasing: getMessages returns a snapshot copy. The
 *   transcript is the table, not a JS reference.
 * - No protocol-level repair: orphan tool_use is structurally
 *   impossible because every assistant tool_use append carries a
 *   ledger.open in the same txn, and every user tool_result append
 *   carries a ledger.close.
 * - No JSON blob: each block lands in `content_json` per row, so
 *   queries over individual blocks are cheap.
 *
 * The store is a thin DB layer; semantic concerns (split-sibling merge,
 * usage backfill, transient-text classification) are owned by the
 * higher-level services that call it.
 */
@Injectable()
export class MessageStore {
  private readonly logger = new Logger(MessageStore.name)

  private stmtMaxSeq?: StatementSync
  private stmtInsert?: StatementSync
  private stmtGetByConversation?: StatementSync
  private stmtGetByUuid?: StatementSync
  private stmtUpdateContent?: StatementSync
  private stmtUpdateMetadata?: StatementSync

  constructor(
    private readonly persistence: PersistenceService,
    private readonly ledger: ToolCallLedger
  ) {}

  /**
   * Run `fn` inside a SQLite BEGIN/COMMIT for the given conversation.
   * The supplied SessionTxn is the only object the ledger / message
   * append APIs accept, which enforces transactional discipline at
   * compile time.
   *
   * Nested calls are not supported (node:sqlite has a single
   * transaction state per database connection).
   */
  runInTransaction<T>(
    conversationId: ConversationId,
    fn: (txn: SessionTxn) => T
  ): T {
    const txn: SessionTxnInternal = {
      conversationId,
      tag: SESSION_TXN_TAG,
      persistence: this.persistence,
    }
    return this.persistence.runInTransaction(() => fn(txn))
  }

  /**
   * Append an assistant content block (text / thinking / tool_use /
   * image / etc). When the block is a tool_use, the caller MUST pair
   * the append with `ledger.open` in the same txn — this is enforced
   * structurally by accepting only AssistantContentBlock here and
   * exposing `ledger` separately on the same txn.
   */
  appendAssistantBlock(
    txn: SessionTxn,
    block: AssistantContentBlock,
    opts: AssistantBlockOpts
  ): AppendResult {
    return this.appendInternal(txn, {
      role: "assistant",
      content: [block],
      messageId: opts.messageId,
      metadata: this.mergeMetadata(opts.metadata, { turnId: opts.turnId }),
      isMeta: false,
    })
  }

  /**
   * Append a user-role tool_result. Requires an open ledger entry for
   * the tool_use_id; throws otherwise. The append + ledger.close happen
   * in the same txn as enforced by the caller.
   */
  appendToolResultBlock(
    txn: SessionTxn,
    block: ToolResultBlock,
    opts: ToolResultBlockOpts
  ): AppendResult {
    if (!this.ledger.isOpen(txn.conversationId, block.tool_use_id)) {
      throw new Error(
        `MessageStore.appendToolResultBlock: no open ledger entry for ` +
          `conversation=${txn.conversationId} tool_use_id=${block.tool_use_id}`
      )
    }
    const append = this.appendInternal(txn, {
      role: "user",
      content: [block],
      messageId: undefined,
      metadata: this.mergeMetadata(opts.metadata, { turnId: opts.turnId }),
      isMeta: false,
    })
    this.ledger.close(txn, {
      toolUseId: block.tool_use_id,
      closeMessageSeq: append.seq,
    })
    return append
  }

  /**
   * Append a synthetic abort tool_result block produced by ledger.abortAll.
   * Skips the `ledger.isOpen` check because abortAll has just transitioned
   * the entry from `open` to `aborted`; the message append must happen in
   * the same txn so the row is atomically visible alongside the new state.
   */
  appendAbortToolResultBlock(
    txn: SessionTxn,
    block: ToolResultBlock,
    opts: ToolResultBlockOpts
  ): AppendResult {
    return this.appendInternal(txn, {
      role: "user",
      content: [block],
      messageId: undefined,
      metadata: this.mergeMetadata(opts.metadata, {
        turnId: opts.turnId,
        synthetic: "abort",
      }),
      isMeta: false,
    })
  }

  /**
   * Append a user message. `isMeta=true` marks the message as
   * infrastructure plumbing (thinking-only nudge, recovery prompt)
   * that the IDE-facing transcript should hide.
   */
  appendUserMessage(
    txn: SessionTxn,
    content: ContentBlock[],
    opts: UserMessageOpts = {}
  ): AppendResult {
    return this.appendInternal(txn, {
      role: "user",
      content,
      messageId: undefined,
      metadata: this.mergeMetadata(opts.metadata, { turnId: opts.turnId }),
      isMeta: !!opts.isMeta,
    })
  }

  /**
   * Snapshot of every message in seq order for a conversation. Returns
   * a fresh array on every call; callers may not mutate the result and
   * expect it to land in the database.
   */
  getMessages(conversationId: ConversationId): PersistedMessage[] {
    const stmt = (this.stmtGetByConversation ??= this.persistence.prepare(
      `SELECT seq, uuid, message_id, role, is_meta, timestamp,
              content_json, metadata_json
         FROM session_messages
        WHERE conversation_id = ?
        ORDER BY seq ASC`
    ))
    const rows = stmt.all(conversationId) as unknown as Array<{
      seq: number
      uuid: string
      message_id: string | null
      role: "user" | "assistant"
      is_meta: number
      timestamp: number
      content_json: string
      metadata_json: string | null
    }>
    return rows.map((row) => this.rowToMessage(conversationId, row))
  }

  getMessageByUuid(
    conversationId: ConversationId,
    uuid: string
  ): PersistedMessage | undefined {
    const stmt = (this.stmtGetByUuid ??= this.persistence.prepare(
      `SELECT seq, uuid, message_id, role, is_meta, timestamp,
              content_json, metadata_json
         FROM session_messages
        WHERE conversation_id = ?
          AND uuid = ?
        LIMIT 1`
    ))
    const row = stmt.get(conversationId, uuid) as
      | {
          seq: number
          uuid: string
          message_id: string | null
          role: "user" | "assistant"
          is_meta: number
          timestamp: number
          content_json: string
          metadata_json: string | null
        }
      | undefined
    return row ? this.rowToMessage(conversationId, row) : undefined
  }

  /**
   * Replace the content array on an existing message. Used by the
   * split-sibling consolidator and by the usage / stop_reason backfill
   * that runs at message_delta boundary.
   *
   * Caller responsibility: must be inside a txn so the new content is
   * visible to readers atomically. Direct UPDATE on an append-only row
   * is a deliberate exception for these two paths only.
   */
  rewriteMessageContent(
    txn: SessionTxn,
    uuid: string,
    content: ContentBlock[]
  ): void {
    this.assertTxn(txn)
    const stmt = (this.stmtUpdateContent ??= this.persistence.prepare(
      `UPDATE session_messages
          SET content_json = ?
        WHERE conversation_id = ?
          AND uuid = ?`
    ))
    stmt.run(JSON.stringify(content), txn.conversationId, uuid)
  }

  rewriteMessageMetadata(
    txn: SessionTxn,
    uuid: string,
    metadata: Record<string, unknown>
  ): void {
    this.assertTxn(txn)
    const stmt = (this.stmtUpdateMetadata ??= this.persistence.prepare(
      `UPDATE session_messages
          SET metadata_json = ?
        WHERE conversation_id = ?
          AND uuid = ?`
    ))
    stmt.run(JSON.stringify(metadata), txn.conversationId, uuid)
  }

  // ── internal ─────────────────────────────────────────────────────

  private appendInternal(
    txn: SessionTxn,
    args: {
      role: "user" | "assistant"
      content: ContentBlock[]
      messageId?: string
      metadata?: Record<string, unknown>
      isMeta: boolean
    }
  ): AppendResult {
    this.assertTxn(txn)
    const seqStmt = (this.stmtMaxSeq ??= this.persistence.prepare(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
         FROM session_messages
        WHERE conversation_id = ?`
    ))
    const row = seqStmt.get(txn.conversationId) as
      | { next_seq: number }
      | undefined
    const seq = row?.next_seq ?? 1
    const uuid = crypto.randomUUID()
    const insert = (this.stmtInsert ??= this.persistence.prepare(
      `INSERT INTO session_messages (
         conversation_id, seq, uuid, message_id, role, is_meta,
         timestamp, content_json, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ))
    insert.run(
      txn.conversationId,
      seq,
      uuid,
      args.messageId ?? null,
      args.role,
      args.isMeta ? 1 : 0,
      Date.now(),
      JSON.stringify(args.content),
      args.metadata ? JSON.stringify(args.metadata) : null
    )
    return { recordUuid: uuid, seq }
  }

  private rowToMessage(
    conversationId: ConversationId,
    row: {
      seq: number
      uuid: string
      message_id: string | null
      role: "user" | "assistant"
      is_meta: number
      timestamp: number
      content_json: string
      metadata_json: string | null
    }
  ): PersistedMessage {
    let content: ContentBlock[]
    try {
      content = JSON.parse(row.content_json) as ContentBlock[]
    } catch (err) {
      this.logger.warn(
        `MessageStore: failed to parse content_json for ` +
          `conversation=${conversationId} seq=${row.seq}: ${(err as Error).message}`
      )
      content = []
    }
    let metadata: Record<string, unknown> | undefined
    if (row.metadata_json) {
      try {
        metadata = JSON.parse(row.metadata_json) as Record<string, unknown>
      } catch {
        metadata = undefined
      }
    }
    return {
      conversationId,
      seq: row.seq,
      uuid: row.uuid,
      messageId: row.message_id ?? undefined,
      role: row.role,
      isMeta: row.is_meta !== 0,
      timestamp: row.timestamp,
      content,
      metadata,
    }
  }

  private mergeMetadata(
    base: Record<string, unknown> | undefined,
    extra: Record<string, unknown>
  ): Record<string, unknown> | undefined {
    const filtered = Object.fromEntries(
      Object.entries(extra).filter(([, v]) => v !== undefined)
    )
    if (!base) {
      return Object.keys(filtered).length > 0 ? filtered : undefined
    }
    return { ...base, ...filtered }
  }

  private assertTxn(txn: SessionTxn): void {
    if (!txn || txn.tag !== SESSION_TXN_TAG) {
      throw new Error(
        "MessageStore: write methods require a SessionTxn from runInTransaction()"
      )
    }
  }
}
