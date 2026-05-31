/**
 * Multi-root workspace boundary resolver.
 *
 * Two responsibilities, intentionally co-located so all callers see
 * the same normalization rules:
 *
 *  1. **Normalize a path for boundary comparison.**
 *     Apply `realpathSync` (resolve symlinks), then collapse the
 *     macOS `/private/var` ↔ `/var` and `/private/tmp` ↔ `/tmp`
 *     pairs that the OS exposes as two physical paths to the same
 *     directory. This matches claude-code's `pathInWorkingPath`
 *     semantics so `/tmp/foo` and `/private/tmp/foo` are treated as
 *     identical paths.
 *
 *  2. **Decide whether a candidate path is inside any allowed
 *     workspace root.** The allowed set unions:
 *       - `projectContext.rootPath` (legacy single-root field, kept
 *         for back-compat — equals `workspaceFolders[0].path` when
 *         workspaceFolders is populated, but the field stays around
 *         because old persisted sessions may not have
 *         workspaceFolders).
 *       - `projectContext.workspaceFolders[].path` (multi-root
 *         from IDE — Cursor `RepositoryIndexingInfo` etc.).
 *       - `additionalRoots[].path` (REST API + config file).
 *
 * The resolver is **stateless** — every public function takes the
 * inputs it needs and returns a value. State (the additionalRoots
 * map, IDE-pushed workspaceFolders) lives on `SessionRecord` and is
 * passed in. This keeps the resolver trivially testable (no Nest DI,
 * no fixtures) and makes it explicit which pieces of session state
 * affect boundary decisions.
 *
 * Memoization is deliberately NOT done here. `realpathSync` on a
 * 5-character `/foo` path is sub-microsecond; the boundary check
 * happens once per tool call. Caching would just introduce stale-
 * resolution bugs when the user `mv`s a directory mid-session.
 */

import * as fs from "fs"
import * as path from "path"

/**
 * macOS exposes `/var`, `/tmp`, `/etc` as symlinks to
 * `/private/var`, `/private/tmp`, `/private/etc`. `realpath` resolves
 * to the `/private/...` form, but the user (and the IDE!) typically
 * sees and types the short form. To make boundary checks consistent
 * regardless of which form was supplied, we collapse the two by
 * stripping the `/private` prefix when it precedes one of these
 * well-known short-form roots.
 *
 * Other platforms: noop (Linux has no /private, Windows has no
 * symlink at the OS level for these paths).
 */
const MACOS_PRIVATE_PREFIX = "/private"
const MACOS_PRIVATE_SHORTFORM_ROOTS = ["/var", "/tmp", "/etc"]

/**
 * Strip the macOS `/private` prefix when the rest of the path
 * starts with `/var`, `/tmp`, or `/etc`. Idempotent — paths that
 * don't match the pattern pass through unchanged.
 */
export function stripMacosPrivatePrefix(absPath: string): string {
  if (process.platform !== "darwin") return absPath
  if (!absPath.startsWith(MACOS_PRIVATE_PREFIX)) return absPath
  const tail = absPath.slice(MACOS_PRIVATE_PREFIX.length)
  for (const shortRoot of MACOS_PRIVATE_SHORTFORM_ROOTS) {
    if (tail === shortRoot || tail.startsWith(`${shortRoot}/`)) {
      return tail
    }
  }
  return absPath
}

/**
 * Normalize a path for boundary comparison. Steps:
 *
 *   1. `path.resolve` → produce an absolute path. Relative paths are
 *      resolved against `process.cwd()`, which is the bridge process
 *      cwd (typically the workspace root); callers that need a
 *      different base should pass an already-absolute path.
 *   2. `realpathSync` → resolve symlinks. Falls through silently
 *      when the path doesn't exist (boundary checks frequently run
 *      on paths that haven't been created yet — e.g. the user
 *      asks the agent to write a new file in an allowed root). In
 *      that case we still return the resolved absolute form
 *      (without symlink expansion) so the prefix comparison still
 *      works against ancestor directories that DO exist.
 *   3. `stripMacosPrivatePrefix` → collapse `/private/var` ↔ `/var`.
 *
 * Returns the normalized absolute path. Never throws — when both
 * `path.resolve` and `realpathSync` fail, returns the input
 * unchanged so callers can still compare it (it just won't match
 * any normalized root).
 */
export function normalizePathForBoundaryCheck(rawPath: string): string {
  if (!rawPath) return ""
  let absolute: string
  try {
    absolute = path.resolve(rawPath)
  } catch {
    return rawPath
  }
  let resolved = absolute
  try {
    resolved = fs.realpathSync(absolute)
  } catch {
    // Path doesn't exist or is inaccessible — fall through with the
    // pre-realpath absolute form. Walk up the path looking for the
    // closest ancestor that DOES exist, realpath that, then re-
    // append the unresolved tail. This gives correct boundary
    // semantics for write-new-file flows where the leaf doesn't
    // exist yet but its parent dir is inside an allowed root.
    const parts = absolute.split(path.sep)
    for (let i = parts.length - 1; i > 0; i--) {
      const head = parts.slice(0, i).join(path.sep) || path.sep
      try {
        const headResolved = fs.realpathSync(head)
        const tail = parts.slice(i).join(path.sep)
        resolved = tail ? path.join(headResolved, tail) : headResolved
        break
      } catch {
        // Keep walking up.
      }
    }
  }
  return stripMacosPrivatePrefix(resolved)
}

/**
 * Test whether `candidatePath` is contained inside any of the
 * `allowedRoots`. Both inputs are normalized via
 * `normalizePathForBoundaryCheck` before comparison.
 *
 * "Contained inside" means: candidate equals a root, or candidate
 * is a descendant of a root. The relative-path technique
 * (`path.relative(root, candidate)`) handles symlink-resolved
 * comparisons correctly and rejects `../` traversal attempts.
 *
 * Empty `allowedRoots` always returns `false` — callers that want
 * "no roots = allow everything" must check that explicitly. We err
 * on the side of denying because the boundary check is the last
 * line of defense before a sub-agent reads from disk.
 */
export function isPathWithinAllowedRoots(
  candidatePath: string,
  allowedRoots: ReadonlyArray<string>
): boolean {
  if (!candidatePath) return false
  if (allowedRoots.length === 0) return false

  const normalizedCandidate = normalizePathForBoundaryCheck(candidatePath)
  if (!normalizedCandidate) return false

  for (const root of allowedRoots) {
    if (!root) continue
    const normalizedRoot = normalizePathForBoundaryCheck(root)
    if (!normalizedRoot) continue
    const relative = path.relative(normalizedRoot, normalizedCandidate)
    // `relative === ""` means same path; non-`..`-prefixed and
    // non-absolute means strictly inside the root. This rejects
    // both `..` traversal and unrelated absolute paths in one
    // check.
    if (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    ) {
      return true
    }
  }
  return false
}

/**
 * Resolve the full set of allowed workspace roots for a session.
 *
 * Order is significant — earlier roots win for display purposes
 * (e.g. when picking the "primary" root for a relative-path
 * resolution fallback in `buildSubAgentWorkspaceTarget`). The
 * order matches Cursor's own ordering: IDE-pushed first, then
 * user-extended.
 */
export interface AllowedRootsInput {
  /** Legacy single-root field. Always included if non-empty. */
  rootPath?: string
  /** IDE-synced multi-root from `projectContext.workspaceFolders`. */
  workspaceFolders?: ReadonlyArray<{ path: string }>
  /** REST/config-added entries. */
  additionalRoots?:
    | ReadonlyMap<string, { path: string }>
    | ReadonlyArray<{
        path: string
      }>
}

export function resolveAllowedWorkspaceRoots(
  input: AllowedRootsInput
): string[] {
  const seen = new Set<string>()
  const out: string[] = []

  const push = (raw: string | undefined) => {
    if (!raw) return
    const normalized = normalizePathForBoundaryCheck(raw)
    if (!normalized) return
    if (seen.has(normalized)) return
    seen.add(normalized)
    out.push(normalized)
  }

  push(input.rootPath)
  for (const folder of input.workspaceFolders || []) push(folder.path)
  if (input.additionalRoots) {
    if (input.additionalRoots instanceof Map) {
      const mapRoots = input.additionalRoots as ReadonlyMap<
        string,
        { path: string }
      >
      for (const entry of mapRoots.values()) push(entry.path)
    } else if (Array.isArray(input.additionalRoots)) {
      const arrayRoots = input.additionalRoots as ReadonlyArray<{
        path: string
      }>
      for (const entry of arrayRoots) push(entry.path)
    }
  }
  return out
}
