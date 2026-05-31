import { orderBufferedToolResultIdsForFlush } from "./tool-protocol-helpers"

/**
 * Ordering contract for the per-turn join barrier flush.
 *
 * The barrier buffers every tool_result of a multi-member assistant batch
 * and, once the last one settles, flushes them in the model's DECLARATION
 * order — not the (inline-fast vs exec-slow) completion order they arrived
 * in. This pure function owns that ordering decision; these tests pin it.
 */
describe("orderBufferedToolResultIdsForFlush", () => {
  const buffered = (
    entries: Array<[id: string, arrivalSeq: number]>
  ): Array<{ toolCallId: string; arrivalSeq: number }> =>
    entries.map(([toolCallId, arrivalSeq]) => ({ toolCallId, arrivalSeq }))

  it("flushes in declaration order regardless of arrival order", () => {
    // Declared A,B,C but settled B(0) → A(1) → C(2) (inline B fast, exec slow).
    const order = orderBufferedToolResultIdsForFlush(
      ["A", "B", "C"],
      buffered([
        ["B", 0],
        ["A", 1],
        ["C", 2],
      ])
    )
    expect(order).toEqual(["A", "B", "C"])
  })

  it("emits only ids that were actually buffered, keeping declaration order", () => {
    // Declared A,B,C but only A and C have arrived so far.
    const order = orderBufferedToolResultIdsForFlush(
      ["A", "B", "C"],
      buffered([
        ["C", 0],
        ["A", 1],
      ])
    )
    expect(order).toEqual(["A", "C"])
  })

  it("appends undeclared stragglers after declared ids, in arrival order", () => {
    // X and Y were buffered but the batch never declared them (defensive).
    const order = orderBufferedToolResultIdsForFlush(
      ["A", "B"],
      buffered([
        ["Y", 5],
        ["A", 0],
        ["B", 1],
        ["X", 3],
      ])
    )
    // A,B in declaration order; then X(seq3) before Y(seq5) by arrival.
    expect(order).toEqual(["A", "B", "X", "Y"])
  })

  it("emits each id once even if declared twice", () => {
    const order = orderBufferedToolResultIdsForFlush(
      ["A", "A", "B"],
      buffered([
        ["A", 0],
        ["B", 1],
      ])
    )
    expect(order).toEqual(["A", "B"])
  })

  it("returns empty for an empty buffer", () => {
    expect(orderBufferedToolResultIdsForFlush(["A", "B"], [])).toEqual([])
  })

  it("ignores empty / non-string ids defensively", () => {
    const order = orderBufferedToolResultIdsForFlush(
      ["A", "", "B"],
      buffered([
        ["A", 0],
        ["", 1],
        ["B", 2],
      ])
    )
    expect(order).toEqual(["A", "B"])
  })
})
