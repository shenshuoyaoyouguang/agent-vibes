/**
 * Tiny helper that transparently decompresses gzip payloads even when the
 * upstream omitted `Content-Encoding`. Mirrors CLIProxyAPI's
 * `decodeResponseBody` magic-byte fallback for endpoints that respond with
 * raw gzip bytes regardless of headers.
 *
 * Kept in its own module so that the main service file's static type
 * graph does not need to chase Node's `zlib` type definitions; eslint's
 * project-wide TS service occasionally fails to resolve them when other
 * unrelated files in the workspace are mid-edit.
 */

import { gunzipSync } from "zlib"

const GZIP_MAGIC_0 = 0x1f
const GZIP_MAGIC_1 = 0x8b

/**
 * Decompress `raw` if its leading bytes match the gzip magic. Returns
 * `raw` untouched otherwise. Decompression failures fall through and the
 * original bytes are returned so the caller's JSON.parse / text decode
 * surfaces the underlying problem.
 */
export function decompressIfGzipMagic(raw: Uint8Array): Uint8Array {
  if (raw.length >= 2 && raw[0] === GZIP_MAGIC_0 && raw[1] === GZIP_MAGIC_1) {
    try {
      const buffer = gunzipSync(raw)
      // Re-wrap as a plain Uint8Array so callers do not have to care
      // whether the runtime returned a Node Buffer.
      return Uint8Array.from(buffer)
    } catch {
      // Fall through.
    }
  }
  return raw
}

/**
 * Read a `fetch` Response's body, decompress gzip if needed, and parse it
 * as JSON. Forces the caller to declare the expected shape via the
 * generic parameter.
 */
export async function readJsonWithMagicByteSniff<T>(
  response: Response
): Promise<T> {
  const raw = new Uint8Array(await response.arrayBuffer())
  const bytes = decompressIfGzipMagic(raw)
  const text = new TextDecoder("utf-8").decode(bytes)
  return JSON.parse(text) as T
}
