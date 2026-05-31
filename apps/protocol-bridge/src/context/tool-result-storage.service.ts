import { Injectable, Logger } from "@nestjs/common"
import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import { getAgentVibesToolResultsDir } from "../shared/agent-vibes-paths"
import type {
  ContextStoredToolResultReference,
  ContextToolResultReplacementState,
} from "./types"

export interface ToolResultStorageProcessInput {
  conversationId?: string
  toolUseId: string
  toolName: string
  content: string
  replacementState?: ContextToolResultReplacementState
  force?: boolean
  reason?: "per_tool" | "aggregate"
  thresholdChars?: number
}

export interface ToolResultStorageWriteResult {
  replacement: string
  reference: ContextStoredToolResultReference
}

export type ToolResultStorageReadChunkResult =
  | {
      status: "success"
      reference: ContextStoredToolResultReference
      chunk: string
      chunkNumber: number
      chunkCount: number
      nextPosition?: number
    }
  | {
      status: "not_found"
      documentId: string
    }
  | {
      status: "position_out_of_range"
      documentId: string
      requestedPosition: number
      chunkCount: number
    }

@Injectable()
export class ToolResultStorageService {
  private readonly logger = new Logger(ToolResultStorageService.name)
  private readonly CHUNK_SIZE = 4_000
  private readonly PREVIEW_CHARS = 4_000
  private readonly METADATA_SUFFIX = ".metadata.json"

  processToolResultForHistory(input: ToolResultStorageProcessInput): string {
    const normalizedContent =
      input.content.trim().length === 0
        ? `(${input.toolName || "tool"} completed with no output)`
        : input.content

    if (this.isStoredToolResultReferenceContent(normalizedContent)) {
      return normalizedContent
    }

    const existingReplacement =
      input.replacementState?.replacementByToolUseId?.[input.toolUseId]
    if (existingReplacement) {
      return existingReplacement
    }

    const threshold = Math.max(1, input.thresholdChars ?? this.PREVIEW_CHARS)
    if (
      !input.force &&
      normalizedContent.length <= threshold &&
      !this.shouldStoreAggregateResult(
        input.replacementState,
        normalizedContent
      )
    ) {
      this.markSeen(input.replacementState, input.toolUseId)
      return normalizedContent
    }

    if (!input.conversationId || !input.toolUseId || !normalizedContent) {
      this.markSeen(input.replacementState, input.toolUseId)
      return normalizedContent
    }

    try {
      return this.store(
        input.conversationId,
        input.toolUseId,
        input.toolName,
        normalizedContent,
        input.replacementState,
        { reason: input.reason || "per_tool" }
      ).replacement
    } catch (error) {
      this.logger.warn(
        `Failed to store tool result ${input.toolUseId}: ${String(error)}`
      )
      this.markSeen(input.replacementState, input.toolUseId)
      return normalizedContent
    }
  }

  hasStoredToolResult(
    conversationId: string,
    toolUseId: string,
    reference?: ContextStoredToolResultReference
  ): boolean {
    const resolvedReference =
      reference || this.resolveStoredReference(conversationId, toolUseId)
    if (!resolvedReference) return false
    const absolutePath = this.pathForReference(resolvedReference)
    return !!absolutePath && fs.existsSync(absolutePath)
  }

  isToolResultDocumentId(documentId: string): boolean {
    return documentId.startsWith("tool_result:")
  }

  buildDocumentId(toolUseId: string): string {
    return `tool_result:${toolUseId}`
  }

  store(
    conversationId: string,
    toolUseId: string,
    toolName: string,
    content: string,
    replacementState?: ContextToolResultReplacementState,
    options?: { reason?: "per_tool" | "aggregate" }
  ): ToolResultStorageWriteResult {
    const storageRoot = this.getStorageRoot()
    const safeConversationId = this.sanitizePathSegment(conversationId)
    const safeToolUseId = this.sanitizePathSegment(toolUseId)
    const contentType = this.detectContentType(content)
    const extension = contentType === "json" ? "json" : "txt"
    const relativePath = path.join(
      safeConversationId,
      `${safeToolUseId}.${extension}`
    )
    const absolutePath = path.join(storageRoot, relativePath)
    const metadataPath = this.metadataPathForContentPath(absolutePath)
    const createdAt = Date.now()
    const reference: ContextStoredToolResultReference = {
      toolUseId,
      documentId: this.buildDocumentId(toolUseId),
      relativePath,
      toolName,
      originalSizeChars: content.length,
      originalLineCount: this.countLines(content),
      previewChars: Math.min(this.PREVIEW_CHARS, content.length),
      chunkSize: this.CHUNK_SIZE,
      chunkCount: Math.max(1, Math.ceil(content.length / this.CHUNK_SIZE)),
      contentType,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
      createdAt,
    }

    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    this.writeFileAtomic(absolutePath, content)
    this.writeFileAtomic(metadataPath, JSON.stringify(reference, null, 2))

    const replacement = this.buildReplacementText(
      reference,
      absolutePath,
      content.slice(0, reference.previewChars)
    )
    this.recordReplacement(
      replacementState,
      toolUseId,
      replacement,
      reference,
      options?.reason
    )
    return { replacement, reference }
  }

  readChunk(
    conversationId: string,
    documentId: string,
    requestedPosition: number,
    storedByToolUseId?: Record<string, ContextStoredToolResultReference>
  ): ToolResultStorageReadChunkResult {
    if (!this.isToolResultDocumentId(documentId)) {
      return { status: "not_found", documentId }
    }

    const toolUseId = documentId.slice("tool_result:".length)
    const reference =
      storedByToolUseId?.[toolUseId] ||
      this.resolveStoredReference(conversationId, toolUseId)
    if (!reference) {
      return { status: "not_found", documentId }
    }

    const absolutePath = this.pathForReference(reference)
    if (!absolutePath || !fs.existsSync(absolutePath)) {
      return { status: "not_found", documentId }
    }

    const content = fs.readFileSync(absolutePath, "utf8")
    const chunkSize = Math.max(1, reference.chunkSize || this.CHUNK_SIZE)
    const chunkCount = Math.max(1, Math.ceil(content.length / chunkSize))
    const chunkIndex = requestedPosition <= 0 ? 0 : requestedPosition - 1
    if (chunkIndex < 0 || chunkIndex >= chunkCount) {
      return {
        status: "position_out_of_range",
        documentId,
        requestedPosition,
        chunkCount,
      }
    }

    const chunkNumber = chunkIndex + 1
    return {
      status: "success",
      reference: {
        ...reference,
        chunkCount,
        originalSizeChars: content.length,
        originalLineCount: this.countLines(content),
      },
      chunk: content.slice(
        chunkIndex * chunkSize,
        (chunkIndex + 1) * chunkSize
      ),
      chunkNumber,
      chunkCount,
      nextPosition: chunkNumber < chunkCount ? chunkNumber + 1 : undefined,
    }
  }

  deleteConversation(conversationId: string): void {
    const safeConversationId = this.sanitizePathSegment(conversationId)
    fs.rmSync(path.join(this.getStorageRoot(), safeConversationId), {
      recursive: true,
      force: true,
    })
  }

  /**
   * Wipe every per-conversation directory under the tool-results root,
   * including orphan directories whose conversation has already been
   * removed from the SQLite sessions table. Returns the number of
   * top-level entries that were deleted so the caller can report a
   * progress count.
   *
   * The root directory itself is preserved (and recreated if it was
   * missing) so subsequent writes don't have to re-mkdir on every
   * tool result.
   */
  clearAll(): { clearedDirCount: number } {
    const root = this.getStorageRoot()
    let clearedDirCount = 0
    let entries: string[] = []
    try {
      entries = fs.existsSync(root) ? fs.readdirSync(root) : []
    } catch (error) {
      this.logger.warn(
        `Failed to enumerate tool-results root ${root}: ${String(error)}`
      )
      return { clearedDirCount }
    }

    for (const entry of entries) {
      const target = path.join(root, entry)
      try {
        fs.rmSync(target, { recursive: true, force: true })
        clearedDirCount++
      } catch (error) {
        this.logger.warn(
          `Failed to remove tool-results entry ${target}: ${String(error)}`
        )
      }
    }

    try {
      fs.mkdirSync(root, { recursive: true })
    } catch (error) {
      this.logger.warn(
        `Failed to recreate tool-results root ${root}: ${String(error)}`
      )
    }

    return { clearedDirCount }
  }

  private isStoredToolResultReferenceContent(content: string): boolean {
    return content.includes("[tool_result stored]")
  }

  private shouldStoreAggregateResult(
    replacementState: ContextToolResultReplacementState | undefined,
    content: string
  ): boolean {
    const seenCount = replacementState?.seenToolUseIds?.length || 0
    return seenCount >= 3 && content.length > Math.floor(this.PREVIEW_CHARS / 2)
  }

  private markSeen(
    replacementState: ContextToolResultReplacementState | undefined,
    toolUseId: string
  ): void {
    if (!replacementState || !toolUseId) return
    const seen = new Set(replacementState.seenToolUseIds || [])
    seen.add(toolUseId)
    replacementState.seenToolUseIds = Array.from(seen)
  }

  private getStorageRoot(): string {
    return getAgentVibesToolResultsDir()
  }

  private sanitizePathSegment(value: string): string {
    const sanitized = value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 180)
    if (sanitized.length > 0) {
      return sanitized
    }
    return crypto.createHash("sha256").update(value).digest("hex").slice(0, 24)
  }

  private detectContentType(content: string): "text" | "json" {
    const trimmed = content.trim()
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      return "text"
    }
    try {
      JSON.parse(trimmed)
      return "json"
    } catch {
      return "text"
    }
  }

  private countLines(content: string): number {
    if (content.length === 0) return 0
    return content.split(/\r?\n/).length
  }

  private writeFileAtomic(filePath: string, content: string): void {
    const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
    fs.writeFileSync(tempPath, content, "utf8")
    fs.renameSync(tempPath, filePath)
  }

  private metadataPathForContentPath(contentPath: string): string {
    return `${contentPath}${this.METADATA_SUFFIX}`
  }

  private pathForReference(
    reference: ContextStoredToolResultReference
  ): string | undefined {
    const storageRoot = this.getStorageRoot()
    const absolutePath = path.resolve(storageRoot, reference.relativePath)
    const relative = path.relative(storageRoot, absolutePath)
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      this.logger.warn(
        `Rejected tool result reference outside storage root: ${reference.relativePath}`
      )
      return undefined
    }
    return absolutePath
  }

  private resolveStoredReference(
    conversationId: string,
    toolUseId: string
  ): ContextStoredToolResultReference | undefined {
    const safeConversationId = this.sanitizePathSegment(conversationId)
    const safeToolUseId = this.sanitizePathSegment(toolUseId)
    for (const extension of ["txt", "json"]) {
      const contentPath = path.join(
        this.getStorageRoot(),
        safeConversationId,
        `${safeToolUseId}.${extension}`
      )
      if (!fs.existsSync(contentPath)) continue

      const metadataPath = this.metadataPathForContentPath(contentPath)
      const metadata = this.readMetadata(metadataPath)
      if (metadata) return metadata

      const content = fs.readFileSync(contentPath, "utf8")
      return {
        toolUseId,
        documentId: this.buildDocumentId(toolUseId),
        relativePath: path.join(
          safeConversationId,
          `${safeToolUseId}.${extension}`
        ),
        toolName: "unknown_tool",
        originalSizeChars: content.length,
        originalLineCount: this.countLines(content),
        previewChars: Math.min(this.PREVIEW_CHARS, content.length),
        chunkSize: this.CHUNK_SIZE,
        chunkCount: Math.max(1, Math.ceil(content.length / this.CHUNK_SIZE)),
        contentType: extension === "json" ? "json" : "text",
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
        createdAt: 0,
      }
    }
    return undefined
  }

  private readMetadata(
    metadataPath: string
  ): ContextStoredToolResultReference | undefined {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(metadataPath, "utf8")
      ) as Partial<ContextStoredToolResultReference>
      if (
        typeof parsed.toolUseId === "string" &&
        typeof parsed.documentId === "string" &&
        typeof parsed.relativePath === "string"
      ) {
        return {
          toolUseId: parsed.toolUseId,
          documentId: parsed.documentId,
          relativePath: parsed.relativePath,
          toolName:
            typeof parsed.toolName === "string"
              ? parsed.toolName
              : "unknown_tool",
          originalSizeChars:
            typeof parsed.originalSizeChars === "number"
              ? parsed.originalSizeChars
              : 0,
          originalLineCount:
            typeof parsed.originalLineCount === "number"
              ? parsed.originalLineCount
              : 0,
          previewChars:
            typeof parsed.previewChars === "number"
              ? parsed.previewChars
              : this.PREVIEW_CHARS,
          chunkSize:
            typeof parsed.chunkSize === "number"
              ? parsed.chunkSize
              : this.CHUNK_SIZE,
          chunkCount:
            typeof parsed.chunkCount === "number" ? parsed.chunkCount : 1,
          contentType: parsed.contentType === "json" ? "json" : "text",
          sha256: typeof parsed.sha256 === "string" ? parsed.sha256 : "",
          createdAt:
            typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
        }
      }
    } catch {
      return undefined
    }
    return undefined
  }

  private buildReplacementText(
    reference: ContextStoredToolResultReference,
    absolutePath: string,
    preview: string
  ): string {
    const lines = [
      "[tool_result stored]",
      `Tool: ${reference.toolName}`,
      `DocumentId: ${reference.documentId}`,
      `StoredPath: ${absolutePath}`,
      `OriginalSize: ${reference.originalSizeChars} chars, ${reference.originalLineCount} lines`,
      `Sha256: ${reference.sha256}`,
      `Chunk: 1/${reference.chunkCount}`,
    ]

    if (reference.chunkCount > 1) {
      // The full output was archived to disk; this hint must NOT name a
      // specific "continue reading" tool. The bridge-internal documentId
      // (`tool_result:<toolUseId>`) is not addressable by Antigravity's
      // `view_content_chunk` (which only knows DocumentIds produced by
      // `read_url_content`), and Cursor's protocol has no chunk-readout
      // tool at all. Surface the fact ("archived, N chunks") and tell the
      // model to re-invoke the original tool if it needs to look again —
      // this is the only continuation that is correct on every backend.
      lines.push(
        `Note: this tool's full output (${reference.originalSizeChars} chars, ${reference.chunkCount} chunks) was archived on disk. To re-examine the full content, re-invoke the same tool with the same arguments; the bridge will return a fresh result.`
      )
    }

    lines.push("", "Preview:", preview || "[empty tool result]")
    return lines.join("\n")
  }

  private recordReplacement(
    replacementState: ContextToolResultReplacementState | undefined,
    toolUseId: string,
    replacement: string,
    reference: ContextStoredToolResultReference,
    reason: "per_tool" | "aggregate" | undefined
  ): void {
    if (!replacementState) return

    const seen = new Set(replacementState.seenToolUseIds || [])
    seen.add(toolUseId)
    replacementState.seenToolUseIds = Array.from(seen)
    replacementState.replacementByToolUseId = {
      ...(replacementState.replacementByToolUseId || {}),
      [toolUseId]: replacement,
    }
    replacementState.storedByToolUseId = {
      ...(replacementState.storedByToolUseId || {}),
      [toolUseId]: reference,
    }
    const existingRecords = replacementState.records || []
    if (
      !existingRecords.some(
        (record) =>
          record.kind === "tool-result" &&
          record.toolUseId === toolUseId &&
          record.replacement === replacement
      )
    ) {
      replacementState.records = [
        ...existingRecords,
        {
          kind: "tool-result",
          toolUseId,
          replacement,
          documentId: reference.documentId,
          reason,
          createdAt: reference.createdAt,
        },
      ]
    }
  }
}
