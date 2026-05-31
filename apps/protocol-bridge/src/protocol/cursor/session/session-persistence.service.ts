import { Injectable, Logger } from "@nestjs/common"
import type { StatementSync } from "node:sqlite"
import { PersistenceService } from "../../../persistence"
import type { ConversationId } from "../turn/turn.types"

/**
 * SessionRow — the immutable / config-class fields stored in the
 * `sessions` table. Mutable runtime state (TurnRuntime, in-flight tool
 * batches, abort signals, edit-path queues) is owned by other services
 * and never lands here.
 */
export interface SessionRow {
  conversationId: ConversationId
  createdAt: number
  lastActivityAt: number
  model: string
  /**
   * Free-form JSON blob carrying configuration that does not warrant
   * its own column: project context, cursor rules / commands, custom
   * system prompt, supported tools snapshot, thinking level, isAgentic,
   * useWeb, requested model parameters, browser MCP context, additional
   * roots, etc. Domain services parse the slice they care about.
   */
  config: Record<string, unknown>
}

export interface SessionFileState {
  conversationId: ConversationId
  path: string
  beforeContent: Buffer
  afterContent: Buffer
  updatedAt: number
}

export interface SessionTodo {
  conversationId: ConversationId
  id: string
  content: string
  status: string
  createdAt: number
  updatedAt: number
  dependencies: string[]
}

export interface SessionMessageBlob {
  conversationId: ConversationId
  blobId: string
  addedAt: number
}

export interface SessionReadPath {
  conversationId: ConversationId
  path: string
  readAt: number
}

/**
 * SessionPersistenceService
 *
 * Owns the `sessions`, `session_file_states`, `session_todos`,
 * `session_message_blobs`, `session_read_paths` tables. Each method is
 * a thin DB layer; semantic concerns (when to persist, how to merge a
 * partial config update, etc.) are owned by SessionLifecycleService
 * (added in step 4).
 *
 * The previous design serialised the entire session into a single
 * `cursor_sessions.state_json` blob and rewrote it on every dirty
 * flush. The split lets each domain service only touch the rows it
 * cares about, and lets SQLite enforce foreign-key cascade on
 * conversation delete.
 */
@Injectable()
export class SessionPersistenceService {
  private readonly logger = new Logger(SessionPersistenceService.name)

  // sessions
  private stmtUpsertSession?: StatementSync
  private stmtSelectSession?: StatementSync
  private stmtListSessions?: StatementSync
  private stmtTouchSession?: StatementSync
  private stmtDeleteSession?: StatementSync

  // related
  private stmtUpsertFileState?: StatementSync
  private stmtListFileStates?: StatementSync
  private stmtDeleteFileState?: StatementSync

  private stmtUpsertTodo?: StatementSync
  private stmtListTodos?: StatementSync
  private stmtDeleteTodo?: StatementSync

  private stmtInsertMessageBlob?: StatementSync
  private stmtListMessageBlobs?: StatementSync

  private stmtUpsertReadPath?: StatementSync
  private stmtListReadPaths?: StatementSync

  constructor(private readonly persistence: PersistenceService) {}

  // ── sessions ─────────────────────────────────────────────────────

  upsertSession(row: SessionRow): void {
    const stmt = (this.stmtUpsertSession ??= this.persistence.prepare(
      `INSERT INTO sessions (
         conversation_id, created_at, last_activity_at, model, config_json
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         last_activity_at = excluded.last_activity_at,
         model = excluded.model,
         config_json = excluded.config_json`
    ))
    stmt.run(
      row.conversationId,
      row.createdAt,
      row.lastActivityAt,
      row.model,
      JSON.stringify(row.config ?? {})
    )
  }

  loadSession(conversationId: ConversationId): SessionRow | undefined {
    const stmt = (this.stmtSelectSession ??= this.persistence.prepare(
      `SELECT created_at, last_activity_at, model, config_json
         FROM sessions
        WHERE conversation_id = ?`
    ))
    const row = stmt.get(conversationId) as
      | {
          created_at: number
          last_activity_at: number
          model: string
          config_json: string
        }
      | undefined
    if (!row) return undefined
    let config: Record<string, unknown>
    try {
      config = JSON.parse(row.config_json) as Record<string, unknown>
    } catch (err) {
      this.logger.warn(
        `loadSession(${conversationId}): bad config_json: ${(err as Error).message}`
      )
      config = {}
    }
    return {
      conversationId,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
      model: row.model,
      config,
    }
  }

  listSessions(): Array<{
    conversationId: ConversationId
    lastActivityAt: number
    model: string
  }> {
    const stmt = (this.stmtListSessions ??= this.persistence.prepare(
      `SELECT conversation_id, last_activity_at, model
         FROM sessions
        ORDER BY last_activity_at DESC`
    ))
    const rows = stmt.all() as unknown as Array<{
      conversation_id: string
      last_activity_at: number
      model: string
    }>
    return rows.map((row) => ({
      conversationId: row.conversation_id as ConversationId,
      lastActivityAt: row.last_activity_at,
      model: row.model,
    }))
  }

  touchSession(conversationId: ConversationId, at: number): void {
    const stmt = (this.stmtTouchSession ??= this.persistence.prepare(
      `UPDATE sessions
          SET last_activity_at = ?
        WHERE conversation_id = ?`
    ))
    stmt.run(at, conversationId)
  }

  deleteSession(conversationId: ConversationId): void {
    // Cascade FKs handle the related tables.
    const stmt = (this.stmtDeleteSession ??= this.persistence.prepare(
      `DELETE FROM sessions WHERE conversation_id = ?`
    ))
    stmt.run(conversationId)
  }

  /**
   * Wipe every row in the v2 session schema. Relies on the
   * `ON DELETE CASCADE` foreign keys defined in migration 009 to fan
   * out the truncate to session_messages, tool_call_ledger,
   * turn_events, session_file_states, session_todos,
   * session_message_blobs, and session_read_paths in a single
   * transaction.
   *
   * Returns the count of `sessions` rows that were deleted so the
   * caller can report a progress number to the UI.
   */
  deleteAllSessions(): number {
    // Re-assert FK cascade on this connection. node:sqlite defaults to
    // foreign_keys=ON but the PRAGMA is per-connection, so we keep the
    // truncate path defensive in case the connection was opened by an
    // older runtime that flipped it off.
    this.persistence.exec("PRAGMA foreign_keys = ON")
    const before = this.persistence
      .prepare(`SELECT COUNT(*) AS n FROM sessions`)
      .get() as { n: number } | undefined
    this.persistence.exec(`DELETE FROM sessions`)
    return before?.n ?? 0
  }

  // ── file states ──────────────────────────────────────────────────

  upsertFileState(state: SessionFileState): void {
    const stmt = (this.stmtUpsertFileState ??= this.persistence.prepare(
      `INSERT INTO session_file_states (
         conversation_id, path, before_content, after_content, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id, path) DO UPDATE SET
         before_content = excluded.before_content,
         after_content = excluded.after_content,
         updated_at = excluded.updated_at`
    ))
    stmt.run(
      state.conversationId,
      state.path,
      state.beforeContent,
      state.afterContent,
      state.updatedAt
    )
  }

  listFileStates(conversationId: ConversationId): SessionFileState[] {
    const stmt = (this.stmtListFileStates ??= this.persistence.prepare(
      `SELECT path, before_content, after_content, updated_at
         FROM session_file_states
        WHERE conversation_id = ?
        ORDER BY path ASC`
    ))
    const rows = stmt.all(conversationId) as unknown as Array<{
      path: string
      before_content: Buffer
      after_content: Buffer
      updated_at: number
    }>
    return rows.map((row) => ({
      conversationId,
      path: row.path,
      beforeContent: row.before_content,
      afterContent: row.after_content,
      updatedAt: row.updated_at,
    }))
  }

  deleteFileState(conversationId: ConversationId, path: string): void {
    const stmt = (this.stmtDeleteFileState ??= this.persistence.prepare(
      `DELETE FROM session_file_states
        WHERE conversation_id = ?
          AND path = ?`
    ))
    stmt.run(conversationId, path)
  }

  // ── todos ────────────────────────────────────────────────────────

  upsertTodo(todo: SessionTodo): void {
    const stmt = (this.stmtUpsertTodo ??= this.persistence.prepare(
      `INSERT INTO session_todos (
         conversation_id, id, content, status,
         created_at, updated_at, dependencies_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id, id) DO UPDATE SET
         content = excluded.content,
         status = excluded.status,
         updated_at = excluded.updated_at,
         dependencies_json = excluded.dependencies_json`
    ))
    stmt.run(
      todo.conversationId,
      todo.id,
      todo.content,
      todo.status,
      todo.createdAt,
      todo.updatedAt,
      JSON.stringify(todo.dependencies)
    )
  }

  listTodos(conversationId: ConversationId): SessionTodo[] {
    const stmt = (this.stmtListTodos ??= this.persistence.prepare(
      `SELECT id, content, status, created_at, updated_at, dependencies_json
         FROM session_todos
        WHERE conversation_id = ?
        ORDER BY created_at ASC`
    ))
    const rows = stmt.all(conversationId) as unknown as Array<{
      id: string
      content: string
      status: string
      created_at: number
      updated_at: number
      dependencies_json: string
    }>
    return rows.map((row) => {
      let dependencies: string[]
      try {
        dependencies = JSON.parse(row.dependencies_json) as string[]
      } catch {
        dependencies = []
      }
      return {
        conversationId,
        id: row.id,
        content: row.content,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        dependencies,
      }
    })
  }

  deleteTodo(conversationId: ConversationId, id: string): void {
    const stmt = (this.stmtDeleteTodo ??= this.persistence.prepare(
      `DELETE FROM session_todos
        WHERE conversation_id = ?
          AND id = ?`
    ))
    stmt.run(conversationId, id)
  }

  // ── message blobs ────────────────────────────────────────────────

  insertMessageBlob(blob: SessionMessageBlob): void {
    const stmt = (this.stmtInsertMessageBlob ??= this.persistence.prepare(
      `INSERT INTO session_message_blobs (
         conversation_id, blob_id, added_at
       ) VALUES (?, ?, ?)
       ON CONFLICT(conversation_id, blob_id) DO NOTHING`
    ))
    stmt.run(blob.conversationId, blob.blobId, blob.addedAt)
  }

  listMessageBlobs(conversationId: ConversationId): SessionMessageBlob[] {
    const stmt = (this.stmtListMessageBlobs ??= this.persistence.prepare(
      `SELECT blob_id, added_at
         FROM session_message_blobs
        WHERE conversation_id = ?
        ORDER BY added_at ASC`
    ))
    const rows = stmt.all(conversationId) as unknown as Array<{
      blob_id: string
      added_at: number
    }>
    return rows.map((row) => ({
      conversationId,
      blobId: row.blob_id,
      addedAt: row.added_at,
    }))
  }

  // ── read paths ───────────────────────────────────────────────────

  upsertReadPath(record: SessionReadPath): void {
    const stmt = (this.stmtUpsertReadPath ??= this.persistence.prepare(
      `INSERT INTO session_read_paths (
         conversation_id, path, read_at
       ) VALUES (?, ?, ?)
       ON CONFLICT(conversation_id, path) DO UPDATE SET
         read_at = excluded.read_at`
    ))
    stmt.run(record.conversationId, record.path, record.readAt)
  }

  listReadPaths(conversationId: ConversationId): SessionReadPath[] {
    const stmt = (this.stmtListReadPaths ??= this.persistence.prepare(
      `SELECT path, read_at
         FROM session_read_paths
        WHERE conversation_id = ?
        ORDER BY read_at DESC`
    ))
    const rows = stmt.all(conversationId) as unknown as Array<{
      path: string
      read_at: number
    }>
    return rows.map((row) => ({
      conversationId,
      path: row.path,
      readAt: row.read_at,
    }))
  }
}
