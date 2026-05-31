import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import {
  ensureDir,
  getCursorAppRootPath,
  getCursorInstallFingerprint,
  getCursorInstallVersion,
  getDefaultDataDir,
} from "../utils/platform"

type CursorPatchManifest = {
  version: 1
  appRootPath: string
  installVersion: string | null
  installFingerprint: string | null
  files: string[]
}

export interface CursorPatchBaselineStatus {
  appRootPath: string | null
  installVersion: string | null
  installFingerprint: string | null
  backupRootPath: string | null
  manifestPath: string | null
  manifestExists: boolean
  trackedFiles: string[]
}

export interface CursorPatchResetResult {
  success: boolean
  restored: number
  errors: string[]
}

type CursorPatchRestorePlanEntry = {
  relativePath: string
  backupPath: string
  targetPath: string
}

export class CursorPatchBaselineService {
  getStatus(): CursorPatchBaselineStatus {
    const appRootPath = getCursorAppRootPath()
    const installVersion = getCursorInstallVersion()
    const installFingerprint = getCursorInstallFingerprint()
    if (installFingerprint) {
      this.pruneStaleBackups(appRootPath, installFingerprint)
    }
    const backupRootPath = appRootPath
      ? this.getBackupRootPath(appRootPath, installFingerprint)
      : null
    const manifestPath = backupRootPath
      ? path.join(backupRootPath, "manifest.json")
      : null
    const manifest = manifestPath ? this.readManifest(manifestPath) : null

    return {
      appRootPath,
      installVersion,
      installFingerprint,
      backupRootPath,
      manifestPath,
      manifestExists: Boolean(manifest),
      trackedFiles: manifest?.files ?? [],
    }
  }

  hasOriginal(filePath: string): boolean {
    const appRootPath = getCursorAppRootPath()
    if (!appRootPath) return false
    const installFingerprint = getCursorInstallFingerprint()

    const relativePath = path.relative(appRootPath, filePath)
    if (
      relativePath.startsWith("..") ||
      path.isAbsolute(relativePath) ||
      relativePath.length === 0
    ) {
      return false
    }

    const backupPath = this.getBackupFilePath(
      appRootPath,
      installFingerprint,
      relativePath
    )
    return fs.existsSync(backupPath)
  }

  captureOriginalFromFile(filePath: string, sourceFilePath: string): string[] {
    const appRootPath = getCursorAppRootPath()
    if (!appRootPath) {
      throw new Error("Cursor installation not found")
    }
    if (!fs.existsSync(filePath)) {
      throw new Error(`Cursor file not found: ${filePath}`)
    }
    if (!fs.existsSync(sourceFilePath)) {
      throw new Error(`Cursor baseline source not found: ${sourceFilePath}`)
    }

    const installVersion = getCursorInstallVersion()
    const installFingerprint = getCursorInstallFingerprint()
    const status = this.getStatus()
    const backupRootPath = status.backupRootPath
    const manifestPath = status.manifestPath
    if (!backupRootPath || !manifestPath) {
      throw new Error("Cursor patch backup paths are unavailable")
    }

    ensureDir(backupRootPath)

    const manifest =
      this.readManifest(manifestPath) ??
      ({
        version: 1,
        appRootPath,
        installVersion,
        installFingerprint,
        files: [],
      } satisfies CursorPatchManifest)

    const relativePath = path.relative(appRootPath, filePath)
    if (
      relativePath.startsWith("..") ||
      path.isAbsolute(relativePath) ||
      relativePath.length === 0
    ) {
      throw new Error(`File is outside Cursor app root: ${filePath}`)
    }

    const backupPath = this.getBackupFilePath(
      appRootPath,
      installFingerprint,
      relativePath
    )

    const added: string[] = []
    if (!fs.existsSync(backupPath)) {
      ensureDir(path.dirname(backupPath))
      fs.copyFileSync(sourceFilePath, backupPath)
      added.push(relativePath)
    }

    if (!manifest.files.includes(relativePath)) {
      manifest.files.push(relativePath)
      added.push(relativePath)
    }

    manifest.files.sort()
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
    return Array.from(new Set(added))
  }

  ensureOriginals(filePaths: string[]): string[] {
    const appRootPath = getCursorAppRootPath()
    if (!appRootPath) {
      throw new Error("Cursor installation not found")
    }
    const installVersion = getCursorInstallVersion()
    const installFingerprint = getCursorInstallFingerprint()

    const status = this.getStatus()
    const backupRootPath = status.backupRootPath
    const manifestPath = status.manifestPath
    if (!backupRootPath || !manifestPath) {
      throw new Error("Cursor patch backup paths are unavailable")
    }

    ensureDir(backupRootPath)

    const manifest =
      this.readManifest(manifestPath) ??
      ({
        version: 1,
        appRootPath,
        installVersion,
        installFingerprint,
        files: [],
      } satisfies CursorPatchManifest)

    const entries = filePaths.map((filePath) => {
      const relativePath = path.relative(appRootPath, filePath)
      if (
        relativePath.startsWith("..") ||
        path.isAbsolute(relativePath) ||
        relativePath.length === 0
      ) {
        throw new Error(`File is outside Cursor app root: ${filePath}`)
      }

      if (!fs.existsSync(filePath)) {
        throw new Error(`Cursor file not found: ${relativePath}`)
      }

      return {
        relativePath,
        filePath,
        backupPath: this.getBackupFilePath(
          appRootPath,
          installFingerprint,
          relativePath
        ),
      }
    })

    const added: string[] = []
    for (const entry of entries) {
      if (!fs.existsSync(entry.backupPath)) {
        ensureDir(path.dirname(entry.backupPath))
        fs.copyFileSync(entry.filePath, entry.backupPath)
        added.push(entry.relativePath)
      }

      if (!manifest.files.includes(entry.relativePath)) {
        manifest.files.push(entry.relativePath)
      }
    }

    manifest.files.sort()
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
    return added
  }

  resetAll(): CursorPatchResetResult {
    try {
      const status = this.getStatus()
      if (
        !status.appRootPath ||
        !status.backupRootPath ||
        !status.manifestPath
      ) {
        return {
          success: false,
          restored: 0,
          errors: ["Cursor installation not found"],
        }
      }

      const plan = this.buildRestorePlan(status, status.trackedFiles)
      if (plan.errors.length > 0) {
        return {
          success: false,
          restored: 0,
          errors: plan.errors,
        }
      }

      for (const entry of plan.entries) {
        ensureDir(path.dirname(entry.targetPath))
        fs.copyFileSync(entry.backupPath, entry.targetPath)
      }

      return {
        success: true,
        restored: plan.entries.length,
        errors: [],
      }
    } catch (error) {
      return {
        success: false,
        restored: 0,
        errors: [error instanceof Error ? error.message : String(error)],
      }
    }
  }

  restoreFiles(filePaths: string[]): CursorPatchResetResult {
    try {
      const status = this.getStatus()
      if (
        !status.appRootPath ||
        !status.backupRootPath ||
        !status.manifestPath
      ) {
        return {
          success: false,
          restored: 0,
          errors: ["Cursor installation not found"],
        }
      }

      const relativePaths = Array.from(
        new Set(
          filePaths.map((filePath) => {
            const relativePath = path.relative(status.appRootPath!, filePath)
            if (
              relativePath.startsWith("..") ||
              path.isAbsolute(relativePath) ||
              relativePath.length === 0
            ) {
              throw new Error(`File is outside Cursor app root: ${filePath}`)
            }
            return relativePath
          })
        )
      )

      const plan = this.buildRestorePlan(status, relativePaths)
      if (plan.errors.length > 0) {
        return {
          success: false,
          restored: 0,
          errors: plan.errors,
        }
      }

      for (const entry of plan.entries) {
        ensureDir(path.dirname(entry.targetPath))
        fs.copyFileSync(entry.backupPath, entry.targetPath)
      }

      return {
        success: true,
        restored: plan.entries.length,
        errors: [],
      }
    } catch (error) {
      return {
        success: false,
        restored: 0,
        errors: [error instanceof Error ? error.message : String(error)],
      }
    }
  }

  private buildRestorePlan(
    status: CursorPatchBaselineStatus,
    relativePaths: string[]
  ): { entries: CursorPatchRestorePlanEntry[]; errors: string[] } {
    if (!status.appRootPath || !status.manifestPath) {
      return {
        entries: [],
        errors: ["Cursor installation not found"],
      }
    }

    const manifest = this.readManifest(status.manifestPath)
    if (!manifest || manifest.files.length === 0) {
      return {
        entries: [],
        errors: ["No original patch baseline has been captured yet"],
      }
    }

    const entries: CursorPatchRestorePlanEntry[] = []
    const errors: string[] = []
    for (const relativePath of relativePaths) {
      if (!manifest.files.includes(relativePath)) {
        errors.push(`No captured baseline for: ${relativePath}`)
        continue
      }

      const backupPath = this.getBackupFilePath(
        status.appRootPath,
        status.installFingerprint,
        relativePath
      )
      if (!fs.existsSync(backupPath)) {
        errors.push(`Backup missing: ${relativePath}`)
        continue
      }

      entries.push({
        relativePath,
        backupPath,
        targetPath: path.join(status.appRootPath, relativePath),
      })
    }

    return { entries, errors }
  }

  private readManifest(manifestPath: string): CursorPatchManifest | null {
    try {
      const raw = fs.readFileSync(manifestPath, "utf-8")
      const parsed = JSON.parse(raw) as CursorPatchManifest
      if (
        parsed &&
        parsed.version === 1 &&
        typeof parsed.appRootPath === "string" &&
        ("installVersion" in parsed
          ? parsed.installVersion === null ||
            typeof parsed.installVersion === "string"
          : true) &&
        ("installFingerprint" in parsed
          ? parsed.installFingerprint === null ||
            typeof parsed.installFingerprint === "string"
          : true) &&
        Array.isArray(parsed.files)
      ) {
        return parsed
      }
    } catch {
      // noop
    }
    return null
  }

  private pruneStaleBackups(
    appRootPath: string | null,
    installFingerprint: string | null
  ): void {
    if (!appRootPath) return

    const backupsRoot = path.join(getDefaultDataDir(), "cursor-patch-backups")
    if (!fs.existsSync(backupsRoot)) return

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(backupsRoot, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const backupRootPath = path.join(backupsRoot, entry.name)
      const manifestPath = path.join(backupRootPath, "manifest.json")
      const manifest = this.readManifest(manifestPath)
      if (!manifest) continue
      if (manifest.appRootPath !== appRootPath) continue
      if (manifest.installFingerprint === installFingerprint) continue

      try {
        fs.rmSync(backupRootPath, { recursive: true, force: true })
      } catch {
        // noop
      }
    }
  }

  private getBackupRootPath(
    appRootPath: string,
    installFingerprint: string | null
  ): string {
    const installId = crypto
      .createHash("sha256")
      .update(JSON.stringify({ appRootPath, installFingerprint }))
      .digest("hex")
      .slice(0, 16)
    return path.join(getDefaultDataDir(), "cursor-patch-backups", installId)
  }

  private getBackupFilePath(
    appRootPath: string,
    installFingerprint: string | null,
    relativePath: string
  ): string {
    return path.join(
      this.getBackupRootPath(appRootPath, installFingerprint),
      "files",
      relativePath
    )
  }
}
