import { AssistantToolBatchService } from "./assistant-tool-batch.service"
import type { SessionLifecycleService } from "./session-lifecycle.service"

/**
 * Contract tests for the assistant tool-batch state machine that the
 * per-turn join barrier will hook into.
 *
 * Background (the "first kind" of tool_result reordering): inside a single
 * assistant turn the bridge dispatches a batch of tool_use blocks. Inline
 * tools (web_search / task / read_todos ...) settle synchronously while exec
 * tools (read / edit / ls / grep ...) must round-trip to the Cursor IDE. The
 * results therefore arrive — and historically were persisted — in completion
 * order, not the model's declaration order, which forced
 * `repairDisplacedToolResultsAfterAssistant` to run on almost every turn.
 *
 * The join barrier relies on two existing invariants of this service:
 *   1. `toolCallIds` preserves DECLARATION order regardless of settle order.
 *   2. `unsettledToolCallIds` drains to empty only when every tool has
 *      settled — the moment a write barrier can safely flush in order.
 *
 * These tests pin those invariants so the barrier built on top of them
 * cannot silently regress.
 */
describe("AssistantToolBatchService — join-barrier contract", () => {
  const CID = "conv-join-barrier"
  const BACKEND = "anthropic" as const

  let markSessionDirty: jest.Mock
  let service: AssistantToolBatchService

  beforeEach(() => {
    markSessionDirty = jest.fn()
    // The service only ever calls sessionLifecycle.markSessionDirty(); a
    // minimal stub keeps the unit isolated from the lifecycle graph.
    const lifecycleStub = {
      markSessionDirty,
    } as unknown as SessionLifecycleService
    service = new AssistantToolBatchService(lifecycleStub)
  })

  it("preserves declaration order in toolCallIds regardless of settle order", () => {
    service.startAssistantToolBatch(CID, BACKEND, ["A", "B", "C"], {
      readyForContinuation: true,
    })

    // Settle out of declaration order: B (inline, fast) → A → C (exec, slow).
    service.settleAssistantToolBatchTool(CID, "B")
    service.settleAssistantToolBatchTool(CID, "A")

    const snapshot = service.getActiveAssistantToolBatchSnapshot(CID)
    expect(snapshot?.toolCallIds).toEqual(["A", "B", "C"])
  })

  it("keeps unsettled until the LAST tool settles, then drains to empty", () => {
    service.startAssistantToolBatch(CID, BACKEND, ["A", "B", "C"], {
      readyForContinuation: true,
    })

    expect(service.hasUnsettledAssistantToolBatchForBackend(CID, BACKEND)).toBe(
      true
    )

    service.settleAssistantToolBatchTool(CID, "B")
    expect(service.hasUnsettledAssistantToolBatchForBackend(CID, BACKEND)).toBe(
      true
    )

    service.settleAssistantToolBatchTool(CID, "A")
    expect(service.hasUnsettledAssistantToolBatchForBackend(CID, BACKEND)).toBe(
      true
    )

    // The final settle is the barrier's flush trigger.
    service.settleAssistantToolBatchTool(CID, "C")
    expect(service.hasUnsettledAssistantToolBatchForBackend(CID, BACKEND)).toBe(
      false
    )
    expect(
      service.getActiveAssistantToolBatchSnapshot(CID)?.unsettledToolCallIds
    ).toEqual([])
  })

  it("only one tool may claim the continuation, and only once all settled", () => {
    service.startAssistantToolBatch(CID, BACKEND, ["A", "B"], {
      readyForContinuation: true,
    })

    // Claiming while a sibling is unsettled must be refused.
    service.settleAssistantToolBatchTool(CID, "A")
    expect(service.claimAssistantToolBatchContinuation(CID, BACKEND, "A")).toBe(
      false
    )

    // After the last tool settles, exactly one claim succeeds.
    service.settleAssistantToolBatchTool(CID, "B")
    expect(service.claimAssistantToolBatchContinuation(CID, BACKEND, "B")).toBe(
      true
    )
    // A second claim (e.g. a duplicate streamClose race) is refused.
    expect(service.claimAssistantToolBatchContinuation(CID, BACKEND, "A")).toBe(
      false
    )
  })

  it("a tool that never settles keeps the barrier closed (timeout must feed it)", () => {
    service.startAssistantToolBatch(CID, BACKEND, ["A", "B", "C"], {
      readyForContinuation: true,
    })

    // A and B settle; C is a hung exec tool that never returns from the IDE.
    service.settleAssistantToolBatchTool(CID, "A")
    service.settleAssistantToolBatchTool(CID, "B")

    // Barrier stays closed — this is exactly why expirePendingToolCall must
    // synthesize an error result for C and settle it, or the batch would
    // never flush.
    expect(service.hasUnsettledAssistantToolBatchForBackend(CID, BACKEND)).toBe(
      true
    )
    expect(
      service.getActiveAssistantToolBatchSnapshot(CID)?.unsettledToolCallIds
    ).toEqual(["C"])

    // Simulate the timeout path settling the synthetic error for C.
    service.settleAssistantToolBatchTool(CID, "C")
    expect(service.hasUnsettledAssistantToolBatchForBackend(CID, BACKEND)).toBe(
      false
    )
  })

  it("settling an unknown tool id is a no-op and does not open the barrier early", () => {
    service.startAssistantToolBatch(CID, BACKEND, ["A", "B"], {
      readyForContinuation: true,
    })

    expect(service.settleAssistantToolBatchTool(CID, "ghost")).toBe(false)
    expect(
      service.getActiveAssistantToolBatchSnapshot(CID)?.unsettledToolCallIds
    ).toEqual(["A", "B"])
  })

  it("readyForContinuation=false holds the barrier even with zero unsettled tools", () => {
    // Mirrors the dispatch window where all ids are registered but the batch
    // is not yet marked ready (e.g. mid fan-out registration).
    service.startAssistantToolBatch(CID, BACKEND, ["A"], {
      readyForContinuation: false,
    })
    service.settleAssistantToolBatchTool(CID, "A")

    expect(service.hasUnsettledAssistantToolBatchForBackend(CID, BACKEND)).toBe(
      true
    )
  })
})
