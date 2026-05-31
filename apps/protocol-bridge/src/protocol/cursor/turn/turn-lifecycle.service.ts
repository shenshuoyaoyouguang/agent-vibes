import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common"
import type { StatementSync } from "node:sqlite"
import type { TurnOutbound } from "../bidi/bidi-outbound"
import { OutboundForbiddenError } from "../bidi/bidi-outbound"
import { PersistenceService } from "../../../persistence"
import { SessionLifecycleService } from "../session/session-lifecycle.service"
import { TurnHandleImpl, withWriter } from "./turn-handle-impl"
import type { TurnHandle } from "./turn-handle"
import type { TurnRunner } from "./turn-runner"
import {
  type BidiId,
  type CancelReason,
  ConversationId,
  type StreamId,
  type TurnId,
  TurnId as TurnIdMint,
  type TurnKind,
  type TurnPhase,
  type TurnTerminalResult,
} from "./turn.types"
import {
  type TurnEvent,
  type TurnRuntime,
  createTurnRuntime,
  derivePhase,
} from "./turn-event"

/**
 * Internal record of an active turn. The supervisor keeps these in a
 * tree keyed by parentTurnId so cancel-cascade can walk children
 * deterministically.
 *
 * `bidiId` is the BiDi attachment the turn lives under. The umbrella
 * turn for a BiDi is the only turn whose `parentTurnId` is undefined
 * AND that owns an outbound; chat parent / foreground sub-agent turns
 * always set `parentTurnId` to the umbrella's id (or its descendant)
 * so cancel-cascade and writer-stack invariants flow through one
 * spine. `bidiId` is `undefined` only for `synthetic-compaction`
 * turns, which run outside any BiDi.
 */
interface TurnRecord {
  readonly handle: TurnHandleImpl
  readonly runner: TurnRunner
  readonly turnKind: TurnKind
  readonly conversationId: ConversationId
  readonly streamId: StreamId
  readonly bidiId: BidiId | undefined
  readonly parentTurnId: TurnId | undefined
  readonly children: Set<TurnId>
  readonly outbound: TurnOutbound | undefined
  /** Resolves with the runner's terminal result. */
  readonly terminalPromise: Promise<TurnTerminalResult>
  /** Set when the supervisor force-resolves the terminal promise on a cancel race. */
  resolveTerminal: (r: TurnTerminalResult) => void
}

export interface TurnSpawnRequest {
  turnKind: TurnKind
  conversationId: ConversationId
  streamId: StreamId
  /**
   * The BiDi attachment this turn runs under. Required for every
   * outbound-owning kind (`user`, `foreground-subagent`, `recovery`).
   * `synthetic-compaction` is the only kind that may omit it — those
   * turns run outside any BiDi and produce no outbound frames.
   */
  bidiId?: BidiId
  outbound: TurnOutbound | undefined
  parentTurnId?: TurnId
  /**
   * Construct the runner once the handle is materialized. Allows the
   * caller to capture per-turn dependencies (chat session, prepared
   * tools, etc) into the runner's closure.
   */
  buildRunner: (handle: TurnHandle) => TurnRunner
}

export interface TurnLifecycleObserver {
  onSpawn?(turnId: TurnId, kind: TurnKind, parent: TurnId | undefined): void
  onTerminal?(turnId: TurnId, result: TurnTerminalResult): void
  onCancel?(turnId: TurnId, reason: CancelReason): void
}

/**
 * The single owner of the turn graph for the bridge. All turn-runners
 * are spawned through here; the supervisor allocates the TurnHandle,
 * pushes/pops the writer stack, drives cancellation, and reports
 * terminal results to observers.
 *
 * The supervisor is intentionally bidi-agnostic — it has no
 * knowledge of ConnectRPC types or the underlying generator. The
 * `BidiStreamController` is what translates ConnectRPC inbound
 * messages into `spawn()` / `cancelBidi()` calls.
 *
 * Lifecycle: one supervisor instance per Nest module. Conversations
 * and bidis are scoped via the keys passed into `spawn()`.
 */
@Injectable()
export class TurnLifecycle {
  private readonly logger = new Logger(TurnLifecycle.name)
  private readonly turns = new Map<TurnId, TurnRecord>()
  /** Index of every active turn by the BiDi it belongs to. */
  private readonly turnsByBidi = new Map<BidiId, Set<TurnId>>()
  /** Umbrella turnId per BiDi — the entry point for cancel-cascade. */
  private readonly umbrellaByBidi = new Map<BidiId, TurnId>()
  private observers: TurnLifecycleObserver[] = []

  /**
   * In-memory audit log per active turn. Mirrors the rows we append to
   * the `turn_events` table — keeping a parallel in-memory copy lets
   * `phase()` / `audit()` answer without a SELECT round-trip on every
   * call. Pruned in `driveRunner` finally alongside the turn record.
   */
  private readonly auditByTurn = new Map<TurnId, TurnEvent[]>()

  /**
   * Per-turn runtime state (recovery guards). NEVER persisted —
   * replaces the legacy `SessionTopLevelAgentTurnState` fields that
   * polluted SQLite.
   */
  private readonly runtimeByTurn = new Map<TurnId, TurnRuntime>()

  /** Lazily-prepared insert statement for `turn_events`. */
  private stmtAppendTurnEvent?: StatementSync

  /**
   * Sequence counter per (conversationId, turnId). The audit log table
   * uses (conversation_id, turn_id, seq) as the primary key.
   */
  private readonly turnEventSeq = new Map<string, number>()

  constructor(
    private readonly persistence: PersistenceService,
    /**
     * SessionLifecycleService is consulted right before the first
     * `appendEvent({kind:"spawned"})` of every spawn, so the parent
     * `sessions` row is on disk before we write `turn_events`. The
     * default schedulePersist debounce is 5ms — easily missed by a
     * fast-spawning Run RPC, which produced the FOREIGN KEY violations
     * observed in agent-vibes-bridge.log. forwardRef avoids any future
     * cycle if SessionLifecycleService grows a TurnLifecycle dep.
     */
    @Inject(forwardRef(() => SessionLifecycleService))
    private readonly sessionLifecycle: SessionLifecycleService
  ) {}

  addObserver(o: TurnLifecycleObserver): () => void {
    this.observers.push(o)
    return () => {
      this.observers = this.observers.filter((x) => x !== o)
    }
  }

  /**
   * Spawn a new turn. Returns the handle and a promise that
   * resolves with the terminal result. The runner is invoked
   * asynchronously — this method returns immediately so callers can
   * subscribe to `awaitTerminal` without blocking the caller's
   * stack frame.
   *
   * The terminal promise NEVER rejects. A runner that throws is
   * translated to `{ status: "failed", error }`. Callers should
   * still `await` the promise to know when the turn is fully
   * unwound.
   */
  spawn(req: TurnSpawnRequest): {
    handle: TurnHandle
    awaitTerminal: Promise<TurnTerminalResult>
  } {
    const turnId = TurnIdMint.generate(req.turnKind)
    const parentRecord = req.parentTurnId
      ? this.turns.get(req.parentTurnId)
      : undefined
    if (req.parentTurnId && !parentRecord) {
      throw new Error(
        `TurnLifecycle.spawn: parent ${req.parentTurnId} not found`
      )
    }

    // Validate bidi expectations for the kind. `synthetic-compaction`
    // is the only kind that legitimately runs outside a BiDi. Any
    // other kind without a bidiId is a wiring bug — fail loud.
    if (req.turnKind !== "synthetic-compaction" && !req.bidiId) {
      throw new Error(
        `TurnLifecycle.spawn: turnKind=${req.turnKind} requires bidiId`
      )
    }
    // Child turns must inherit their parent's bidi — having a child
    // on a different BiDi than its parent breaks cancel-cascade.
    if (parentRecord && req.bidiId && parentRecord.bidiId !== req.bidiId) {
      throw new Error(
        `TurnLifecycle.spawn: child bidiId=${req.bidiId} does not match parent bidiId=${parentRecord.bidiId ?? "(none)"}`
      )
    }

    let resolveTerminal!: (r: TurnTerminalResult) => void
    const terminalPromise = new Promise<TurnTerminalResult>((resolve) => {
      resolveTerminal = resolve
    })

    const handle = new TurnHandleImpl({
      turnId,
      turnKind: req.turnKind,
      conversationId: req.conversationId,
      streamId: req.streamId,
      outbound: req.outbound,
      parentSignal: parentRecord?.handle.signal,
      onTerminal: (result) => {
        // Observer notification only — terminalPromise is resolved
        // by driveRunner *after* supervisor maps cleanup so that
        // cancelTurnAndAwait callers observe a clean registry when
        // they wake up.
        for (const o of this.observers) o.onTerminal?.(turnId, result)
      },
    })

    const runner = req.buildRunner(handle)

    const record: TurnRecord = {
      handle,
      runner,
      turnKind: req.turnKind,
      conversationId: req.conversationId,
      streamId: req.streamId,
      bidiId: req.bidiId,
      parentTurnId: req.parentTurnId,
      children: new Set(),
      outbound: req.outbound,
      terminalPromise,
      resolveTerminal,
    }
    this.turns.set(turnId, record)
    this.auditByTurn.set(turnId, [])
    this.runtimeByTurn.set(turnId, createTurnRuntime())
    // Ensure the parent `sessions` row is committed before we write
    // any `turn_events` row pointing at it. SessionLifecycleService
    // normally writes through schedulePersist (5ms debounce); for a
    // freshly-mounted conversation that window is wide enough to make
    // appendEvent's INSERT fail with FOREIGN KEY constraint failed. We
    // synchronously flush here so the FK is satisfied at insert time.
    //
    // Two kinds of turn legitimately have no parent `sessions` row to
    // flush:
    //   - `synthetic-compaction`: runs outside any conversation by
    //     design.
    //   - The BiDi umbrella turn (which spawns under a provisional
    //     `pending:<bidiId>` cid before the IDE has sent the first
    //     message carrying the real conversation_id). The umbrella's
    //     audit trail belongs to the BiDi attachment, not to a
    //     conversation; persisting it would dangle a FK forever.
    // Both cases skip the flush; appendEvent is paired below so it
    // also skips the SQL INSERT under those same conditions.
    if (
      req.turnKind !== "synthetic-compaction" &&
      !ConversationId.isProvisional(req.conversationId)
    ) {
      this.sessionLifecycle.flushPersistImmediate(req.conversationId)
    }
    this.appendEvent(turnId, {
      kind: "spawned",
      ts: Date.now(),
      parent: req.parentTurnId,
      turnKind: req.turnKind,
      runner: runner.displayName,
    })
    if (parentRecord) parentRecord.children.add(turnId)

    if (req.bidiId) {
      let set = this.turnsByBidi.get(req.bidiId)
      if (!set) {
        set = new Set()
        this.turnsByBidi.set(req.bidiId, set)
      }
      set.add(turnId)
      // The first parent-less outbound-owning turn registered under
      // a BiDi is its umbrella. Subsequent registrations don't
      // overwrite — the umbrella is the durable cancel anchor for
      // the BiDi's lifetime.
      if (!req.parentTurnId && !this.umbrellaByBidi.has(req.bidiId)) {
        this.umbrellaByBidi.set(req.bidiId, turnId)
      }
    }

    for (const o of this.observers)
      o.onSpawn?.(turnId, req.turnKind, req.parentTurnId)

    // Drive the runner. Any throw is normalised to `failed`. The
    // writer stack is pushed/popped exclusively by `withWriter`.
    void this.driveRunner(record).then(
      () => {
        // Cleanup happens in driveRunner's finally regardless.
      },
      (err) => {
        this.logger.error(
          `driveRunner unexpectedly rejected for turn=${turnId}: ${(err as Error).message}`
        )
      }
    )

    return { handle, awaitTerminal: terminalPromise }
  }

  private async driveRunner(record: TurnRecord): Promise<void> {
    let result: TurnTerminalResult
    try {
      result = await withWriter(record.outbound, record.handle.turnId, () =>
        record.runner.run(record.handle)
      )
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      // OutboundForbiddenError on the runner's path indicates the
      // runner tried to write after seal — log once with full
      // context, then map to `failed`.
      if (e instanceof OutboundForbiddenError) {
        this.logger.warn(
          `runner threw OutboundForbiddenError turn=${record.handle.turnId} state=${e.state}`
        )
      } else {
        this.logger.error(
          `runner threw turn=${record.handle.turnId} runner=${record.runner.displayName}: ${e.message}`
        )
      }
      const cancelReason = record.handle.cancellationReason()
      result = cancelReason
        ? { status: "cancelled", reason: cancelReason }
        : { status: "failed", error: e }
    }

    // If the runner did not call reportTerminal, do it on its
    // behalf so awaitTerminal resolves and observers fire.
    if (!record.handle.hasTerminal()) {
      record.handle.forceTerminal(result)
    }

    // Append the terminal event to the audit log before tearing down
    // the in-memory log so the persisted row carries the final result.
    this.appendEvent(record.handle.turnId, {
      kind: "terminal",
      ts: Date.now(),
      result,
    })

    // Detach from supervisor maps.
    this.turns.delete(record.handle.turnId)
    this.auditByTurn.delete(record.handle.turnId)
    this.runtimeByTurn.delete(record.handle.turnId)
    this.turnEventSeq.delete(
      this.turnEventSeqKey(record.conversationId, record.handle.turnId)
    )
    if (record.parentTurnId) {
      const parent = this.turns.get(record.parentTurnId)
      parent?.children.delete(record.handle.turnId)
    }
    if (record.bidiId) {
      const set = this.turnsByBidi.get(record.bidiId)
      if (set) {
        set.delete(record.handle.turnId)
        if (set.size === 0) this.turnsByBidi.delete(record.bidiId)
      }
      if (this.umbrellaByBidi.get(record.bidiId) === record.handle.turnId) {
        this.umbrellaByBidi.delete(record.bidiId)
      }
    }

    // Resolve terminalPromise AFTER supervisor cleanup so callers of
    // cancelTurnAndAwait observe a registry where this turn has
    // already been detached. This is the happens-before that lets
    // a new turn safely call beginTurn on the single-anchor
    // TranscriptStore right after the await returns.
    record.resolveTerminal(result)
  }

  /**
   * Cancel a turn and all its descendants. The cascade order is
   * children-before-parent so a parent that observes its children's
   * terminal results sees them before its own signal aborts.
   */
  cancelTurn(turnId: TurnId, reason: CancelReason): void {
    const record = this.turns.get(turnId)
    if (!record) return
    // Walk children first.
    for (const childId of [...record.children]) {
      this.cancelTurn(childId, {
        kind: "parent-cancelled",
        ancestor: turnId,
      })
    }
    // Audit cancellation BEFORE flipping the AbortController so the
    // event lands while the in-memory log still exists. driveRunner's
    // finally will append `terminal` and tear down afterwards.
    this.appendEvent(turnId, {
      kind: "cancelled",
      ts: Date.now(),
      reason,
    })
    record.handle.cancel(reason)
    for (const o of this.observers) o.onCancel?.(turnId, reason)
  }

  /**
   * Cancel every turn under a BiDi attachment. Used by
   * BidiStreamController on bidi-close (when the IDE drops the
   * connection). Returns the number of root turns cancelled (each
   * cascades to its descendants).
   */
  cancelBidi(bidiId: BidiId, reason: CancelReason): number {
    const set = this.turnsByBidi.get(bidiId)
    if (!set || set.size === 0) return 0
    // Snapshot — cancelTurn mutates `children` indirectly via
    // driveRunner's cleanup, and we don't want to re-cancel turns
    // that are already terminating.
    const snapshot = [...set]
    let rootCount = 0
    for (const turnId of snapshot) {
      const record = this.turns.get(turnId)
      if (!record) continue
      // Only cancel from roots within this BiDi; descendants get
      // cancelled by the cascade. A root inside a BiDi is a turn
      // whose parent (if any) is on a different BiDi — in practice
      // that's the umbrella turn, since every other turn parents
      // back to the umbrella.
      if (record.parentTurnId) {
        const parent = this.turns.get(record.parentTurnId)
        if (parent && parent.bidiId === bidiId) continue
      }
      this.cancelTurn(turnId, reason)
      rootCount++
    }
    return rootCount
  }

  /**
   * Cancel every turn in a conversation. Retained for tests and the
   * synthetic-compaction code path; production cancel goes through
   * `cancelBidi`.
   */
  cancelConversation(
    conversationId: ConversationId,
    reason: CancelReason
  ): number {
    const targets: TurnId[] = []
    for (const [id, r] of this.turns) {
      if (r.conversationId === conversationId) targets.push(id)
    }
    for (const id of targets) this.cancelTurn(id, reason)
    return targets.length
  }

  /**
   * Currently active turn count, exposed for diagnostics.
   */
  size(): number {
    return this.turns.size
  }

  /**
   * The deepest active turn under a BiDi attachment — the leaf of
   * the parent → child chain. Resolves to:
   *   - an active foreground sub-agent if one is running
   *   - else the active chat ParentTurn
   *   - else the BiDi umbrella
   *   - else `undefined` (the BiDi has been torn down)
   *
   * This is the single source of truth for "what is the current
   * AbortSignal for ongoing work in this BiDi". Pre-rewrite, the
   * answer was driven by `ChatSession.currentTurnAbortController`;
   * post-rewrite, the supervisor owns the answer and this is how
   * the cursor service exposes it via `getCurrentTurnAbortSignal`.
   */
  getActiveLeafForBidi(bidiId: BidiId): TurnHandle | undefined {
    const set = this.turnsByBidi.get(bidiId)
    if (!set || set.size === 0) return undefined
    const records: TurnRecord[] = []
    for (const id of set) {
      const r = this.turns.get(id)
      if (r) records.push(r)
    }
    if (records.length === 0) return undefined
    const isParentOfAnother = new Set<TurnId>()
    for (const r of records) {
      if (r.parentTurnId) isParentOfAnother.add(r.parentTurnId)
    }
    let leaf: TurnRecord | undefined
    for (const r of records) {
      if (!isParentOfAnother.has(r.handle.turnId)) {
        // Most recently spawned wins — `this.turns` insertion order
        // is stable, and `set` is iterated in insertion order, so
        // the last non-parent record is the current leaf.
        leaf = r
      }
    }
    return leaf?.handle
  }

  /**
   * Returns the umbrella turnId for a BiDi attachment, or `undefined`
   * if the BiDi has no active umbrella (already torn down, or never
   * spawned). Used by callers that need the durable cancel anchor
   * for a BiDi without walking the active-leaf chain.
   */
  getUmbrellaForBidi(bidiId: BidiId): TurnId | undefined {
    return this.umbrellaByBidi.get(bidiId)
  }

  /**
   * For tests and observers: read-only view of an active turn.
   */
  inspect(turnId: TurnId):
    | {
        kind: TurnKind
        parent: TurnId | undefined
        children: TurnId[]
        streamId: StreamId
        bidiId: BidiId | undefined
      }
    | undefined {
    const r = this.turns.get(turnId)
    if (!r) return undefined
    return {
      kind: r.turnKind,
      parent: r.parentTurnId,
      children: [...r.children],
      streamId: r.streamId,
      bidiId: r.bidiId,
    }
  }

  /**
   * Find the deepest active `user` (chat-parent) turn for a
   * conversation. Returns undefined if no chat-parent turn is open.
   *
   * Used by the supersede path in cursor-connect-stream: when a new
   * user message arrives for a conversation that still has an open
   * chat-parent from a previous BiDi (the IDE reconnected mid-turn,
   * or a superseded stream's driveRunner finally hasn't unwound),
   * the new turn must wait for the old one to fully terminate
   * before begin/commit on the single-anchor TranscriptStore.
   */
  getOpenChatParentTurnId(conversationId: ConversationId): TurnId | undefined {
    let candidate: TurnId | undefined
    for (const [id, r] of this.turns) {
      if (r.conversationId !== conversationId) continue
      if (r.turnKind !== "user") continue
      // Most-recently-spawned chat-parent wins. Map insertion order
      // matches spawn order in V8/Node.
      candidate = id
    }
    return candidate
  }

  /**
   * Cancel a turn and await its driveRunner unwind. Returns when the
   * turn's terminalPromise has resolved AND its supervisor cleanup
   * (turnsByBidi removal, parent.children removal) has completed.
   *
   * This is the load-bearing primitive for supersede serialization:
   * the new turn cannot call `beginTurn` on the single-anchor
   * TranscriptStore until the old turn's catch/finally has run
   * commitTurn or abortTurn and cleared the anchor.
   *
   * Idempotent: if `turnId` is unknown (already terminated), resolves
   * immediately with `undefined`.
   */
  /**
   * Read-only snapshot of every turn currently registered under a
   * BiDi attachment. Used by `TurnCleanupCoordinator` to capture the
   * (turnId, conversationId) pairs needed for `ledger.abortAll`
   * BEFORE cancelling — cancellation cascades remove records, and
   * the coordinator needs the pre-cancel snapshot to know which
   * conversations need ledger sweeps.
   */
  listTurnsForBidi(
    bidiId: BidiId
  ): Array<{ turnId: TurnId; conversationId: ConversationId }> {
    const set = this.turnsByBidi.get(bidiId)
    if (!set || set.size === 0) return []
    const out: Array<{ turnId: TurnId; conversationId: ConversationId }> = []
    for (const turnId of set) {
      const record = this.turns.get(turnId)
      if (!record) continue
      out.push({ turnId, conversationId: record.conversationId })
    }
    return out
  }

  async cancelTurnAndAwait(
    turnId: TurnId,
    reason: CancelReason
  ): Promise<TurnTerminalResult | undefined> {
    const record = this.turns.get(turnId)
    if (!record) return undefined
    const terminal = record.terminalPromise
    this.cancelTurn(turnId, reason)
    // Wait for the runner's finally to fire and the supervisor's
    // driveRunner cleanup to detach the record.
    return await terminal
  }

  /**
   * Cancel every turn under a BiDi and wait for each one's runner to
   * unwind (driveRunner's finally fires, the record is detached, and
   * the terminal promise resolves). Returns the terminal results in
   * cancel-snapshot order.
   *
   * The TurnCleanupCoordinator uses this between
   * `outbound.beginSeal()` and `outbound.awaitWritersDrained()` so the
   * runner cleanup hooks all run while writes are still rejected by
   * the outbound's "sealing" state but the channel is not yet closed.
   */
  async cancelBidiAndAwait(
    bidiId: BidiId,
    reason: CancelReason
  ): Promise<TurnTerminalResult[]> {
    const set = this.turnsByBidi.get(bidiId)
    if (!set || set.size === 0) return []
    // Snapshot: cancelTurn cascades into children which mutates the
    // set during iteration. Capture every active turn under this BiDi
    // up-front so we can await each one's terminal regardless of the
    // cascade order.
    const snapshot: TurnRecord[] = []
    for (const turnId of set) {
      const record = this.turns.get(turnId)
      if (record) snapshot.push(record)
    }
    if (snapshot.length === 0) return []
    const terminals = snapshot.map((r) => r.terminalPromise)
    // cancelBidi only cancels roots; children get cascaded by their
    // parents' driveRunner cleanup. Awaiting the snapshot's terminal
    // promises guarantees we see every record's resolution.
    this.cancelBidi(bidiId, reason)
    return await Promise.all(terminals)
  }

  // ── audit log + runtime — Step 4 additions ──────────────────────

  /**
   * Append a structured event to the turn's audit log. Persists the
   * row to `turn_events` synchronously and mirrors it into the
   * in-memory `auditByTurn` so derivations (`phase`, `audit`) do not
   * need a SELECT round-trip.
   *
   * Best-effort: if the persistence layer is down (database closed
   * during shutdown, missing table during a partial migration) the
   * insert is logged at WARN and the in-memory log still updates so
   * the live turn observes the event. We never throw out of this
   * method — losing an audit row should not abort a turn.
   */
  appendEvent(turnId: TurnId, event: TurnEvent): void {
    const record = this.turns.get(turnId)
    if (!record) {
      // Late event after the turn was reaped (e.g. observer firing
      // during driveRunner unwind). Log and drop.
      this.logger.debug(
        `appendEvent: ignoring event kind=${event.kind} for unknown turn=${turnId}`
      )
      return
    }
    const log = this.auditByTurn.get(turnId)
    if (log) log.push(event)

    // Turns that legitimately have no parent `sessions` row keep an
    // in-memory audit log only; the SQL INSERT would dangle the FK
    // forever. Two cases qualify:
    //   - `synthetic-compaction` runs outside any conversation.
    //   - The BiDi umbrella turn lives under the provisional
    //     `pending:<bidiId>` cid: its lifecycle is BiDi-scoped, not
    //     conversation-scoped, and the IDE never sends a real cid for
    //     it. Pre-fix this used to spew "FOREIGN KEY constraint
    //     failed" on every BiDi attach + cancel.
    if (
      record.turnKind === "synthetic-compaction" ||
      ConversationId.isProvisional(record.conversationId)
    ) {
      return
    }

    try {
      const stmt = (this.stmtAppendTurnEvent ??= this.persistence.prepare(
        `INSERT INTO turn_events (
           conversation_id, turn_id, seq, ts, event_kind, event_json
         ) VALUES (?, ?, ?, ?, ?, ?)`
      ))
      const seq = this.nextTurnEventSeq(record.conversationId, turnId)
      stmt.run(
        record.conversationId,
        turnId,
        seq,
        event.ts,
        event.kind,
        JSON.stringify(event)
      )
    } catch (err) {
      // The conversation row may not yet exist in `sessions` (turn was
      // spawned before SessionLifecycleService persisted the parent
      // session). Foreign-key violation is recoverable: the event
      // stays in the in-memory log and the turn continues. We log at
      // warn (not debug) so a regression in `flushPersistImmediate`
      // surfaces in production logs immediately — pre-fix, this fired
      // on every fresh chat-parent spawn and was easy to miss.
      this.logger.warn(
        `appendEvent persistence failed for turn=${turnId} ` +
          `conversation=${record.conversationId} kind=${event.kind}: ` +
          `${(err as Error).message}`
      )
    }
  }

  /** Snapshot of the in-memory audit log for a live turn. */
  audit(turnId: TurnId): readonly TurnEvent[] {
    return this.auditByTurn.get(turnId) ?? []
  }

  /**
   * Current phase derived from the audit log. Returns `undefined` for
   * a turn that has not yet recorded a `phase-changed` event (i.e.
   * still spawning) or for an unknown turnId.
   */
  phase(turnId: TurnId): TurnPhase | undefined {
    const log = this.auditByTurn.get(turnId)
    if (!log) return undefined
    return derivePhase(log)
  }

  /**
   * Per-turn runtime state. Living instance — callers may mutate
   * fields like `thinkingOnlyRecoveryGuard`,
   * `maxOutputTokensRecoveryAttempt`, etc., and the changes are
   * visible to subsequent reads. The lifecycle of this object is
   * bound to the turn record; reading after the turn terminates
   * returns `undefined`.
   */
  runtime(turnId: TurnId): TurnRuntime | undefined {
    return this.runtimeByTurn.get(turnId)
  }

  /**
   * Convenience: get-or-create runtime for a turn. Used by call sites
   * that want to lazily initialise (e.g. `maybeRunTopLevelTokenBudget
   * Check` reaching for the budget tracker on first call).
   */
  ensureRuntime(turnId: TurnId): TurnRuntime {
    let runtime = this.runtimeByTurn.get(turnId)
    if (!runtime) {
      runtime = createTurnRuntime()
      this.runtimeByTurn.set(turnId, runtime)
    }
    return runtime
  }

  private turnEventSeqKey(
    conversationId: ConversationId,
    turnId: TurnId
  ): string {
    return `${conversationId} ${turnId}`
  }

  private nextTurnEventSeq(
    conversationId: ConversationId,
    turnId: TurnId
  ): number {
    const key = this.turnEventSeqKey(conversationId, turnId)
    const next = (this.turnEventSeq.get(key) ?? 0) + 1
    this.turnEventSeq.set(key, next)
    return next
  }
}
