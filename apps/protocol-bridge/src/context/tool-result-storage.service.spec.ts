import { afterEach, beforeEach, describe, expect, it } from "@jest/globals"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { ToolResultStorageService } from "./tool-result-storage.service"
import type { ContextToolResultReplacementState } from "./types"

describe("ToolResultStorageService", () => {
  let tempDir: string
  let previousDataDir: string | undefined

  beforeEach(() => {
    previousDataDir = process.env.AGENT_VIBES_DATA_DIR
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-vibes-tools-"))
    process.env.AGENT_VIBES_DATA_DIR = tempDir
  })

  afterEach(() => {
    if (previousDataDir === undefined) {
      delete process.env.AGENT_VIBES_DATA_DIR
    } else {
      process.env.AGENT_VIBES_DATA_DIR = previousDataDir
    }
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it("stores large tool results and reads later chunks by document id", () => {
    const service = new ToolResultStorageService()
    const replacementState: ContextToolResultReplacementState = {
      seenToolUseIds: [],
      replacementByToolUseId: {},
      storedByToolUseId: {},
    }
    const content = `first line\n${"x".repeat(8_500)}\nlast line`

    const stored = service.store(
      "conversation/1",
      "tool/use/1",
      "read_project",
      content,
      replacementState
    )

    expect(stored.reference.documentId).toBe("tool_result:tool/use/1")
    expect(stored.replacement).toContain("[tool_result stored]")
    expect(stored.replacement).toContain("DocumentId: tool_result:tool/use/1")
    expect(replacementState.seenToolUseIds).toContain("tool/use/1")
    expect(replacementState.replacementByToolUseId["tool/use/1"]).toBe(
      stored.replacement
    )
    expect(replacementState.storedByToolUseId?.["tool/use/1"]).toEqual(
      stored.reference
    )
    expect(replacementState.records).toEqual([
      {
        kind: "tool-result",
        toolUseId: "tool/use/1",
        replacement: stored.replacement,
        documentId: stored.reference.documentId,
        reason: undefined,
        createdAt: stored.reference.createdAt,
      },
    ])

    const chunk = service.readChunk(
      "conversation/1",
      stored.reference.documentId,
      2,
      replacementState.storedByToolUseId
    )

    expect(chunk.status).toBe("success")
    if (chunk.status !== "success") return
    expect(chunk.chunkNumber).toBe(2)
    expect(chunk.chunk).toBe(content.slice(4_000, 8_000))
  })

  it("deletes all stored results for a conversation", () => {
    const service = new ToolResultStorageService()
    const stored = service.store("conv", "tool", "read_project", "payload")

    service.deleteConversation("conv")

    const chunk = service.readChunk("conv", stored.reference.documentId, 1)
    expect(chunk.status).toBe("not_found")
  })
})
