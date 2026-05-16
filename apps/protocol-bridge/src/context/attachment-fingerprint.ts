import { createHash } from "crypto"
import type {
  ContextProjectionAttachment,
  LooseMessageContent,
  ProjectedContextMessage,
} from "./types"

/**
 * Single source of truth for "did the attachment payload change?".
 *
 * Both the compaction planner and the usage ledger compare attachment payloads
 * to decide whether the projected token-count cache is still valid.  Earlier
 * versions used two slightly different serialisations: the planner read
 * `attachment.content` (always a string), the ledger called `JSON.stringify`
 * on `message.content` (which fell back to `[unserializable-content]` on
 * cycles).  When attachment content was a string both branches agreed, but if
 * an attachment ever switched to a content-block array the two fingerprints
 * silently diverged and the ledger cache invalidated on every request.
 *
 * Centralising the serialisation here guarantees both call sites compute the
 * same hash for the same logical payload.
 */

const PAYLOAD_SEPARATOR = "\n---\n"

function serializeContent(content: LooseMessageContent | string): string {
  if (typeof content === "string") {
    return content
  }
  try {
    return JSON.stringify(content)
  } catch {
    return "[unserializable-content]"
  }
}

function buildFingerprint(payload: string): string {
  if (!payload) {
    return ""
  }
  return createHash("sha256").update(payload).digest("hex")
}

/**
 * Fingerprint a list of attachment values built by
 * `ContextAttachmentBuilderService.buildAttachments`.
 */
export function fingerprintAttachments(
  attachments: readonly ContextProjectionAttachment[]
): string {
  if (attachments.length === 0) {
    return ""
  }
  const payload = attachments
    .map(
      (attachment) =>
        `${attachment.kind}:${serializeContent(attachment.content)}`
    )
    .join(PAYLOAD_SEPARATOR)
  return buildFingerprint(payload)
}

/**
 * Fingerprint the attachment-flavoured entries of an already-projected
 * message list.  Returns the same hash as `fingerprintAttachments` for the
 * same logical attachments.
 */
export function fingerprintProjectedAttachments(
  projectedMessages: readonly ProjectedContextMessage[]
): string {
  const attachmentMessages = projectedMessages.filter(
    (message) => message.source === "attachment"
  )
  if (attachmentMessages.length === 0) {
    return ""
  }
  const payload = attachmentMessages
    .map(
      (message) =>
        `${message.attachmentKind || "attachment"}:${serializeContent(message.content)}`
    )
    .join(PAYLOAD_SEPARATOR)
  return buildFingerprint(payload)
}
