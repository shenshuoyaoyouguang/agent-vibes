import * as vscode from "vscode"
import type { ServerState } from "../constants"
import { EXTENSION_DISPLAY_NAME } from "../constants"
import { t, tFmt } from "../i18n/messages-i18n"

const LOADING_COLOR = "#34d399"

/**
 * Bottom status bar indicator showing server state at a glance.
 */
export class StatusIndicator {
  private item: vscode.StatusBarItem
  private state: ServerState = "stopped"
  private transientStatus: {
    text: string
    tooltip: string
    backgroundColor?: vscode.ThemeColor
    color?: string | vscode.ThemeColor
  } | null = null

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    )
    this.item.command = "agentVibes.openDashboard"
    this.update("stopped")
    this.item.show()
  }

  private render(): void {
    // Always open Dashboard on click
    this.item.command = "agentVibes.openDashboard"

    if (this.transientStatus) {
      this.item.text = this.transientStatus.text
      this.item.tooltip = this.transientStatus.tooltip
      this.item.backgroundColor = this.transientStatus.backgroundColor
      this.item.color = this.transientStatus.color
      return
    }

    switch (this.state) {
      case "running":
        this.item.text = `$(circle-filled) ${EXTENSION_DISPLAY_NAME}`
        this.item.tooltip = t("status.tooltip.running")
        this.item.backgroundColor = undefined
        this.item.color = undefined
        break
      case "starting":
        this.item.text = `$(sync~spin) ${EXTENSION_DISPLAY_NAME} ${t("status.text.starting")}`
        this.item.tooltip = t("status.tooltip.starting")
        this.item.backgroundColor = undefined
        this.item.color = LOADING_COLOR
        break
      case "error":
        this.item.text = `$(warning) ${EXTENSION_DISPLAY_NAME}`
        this.item.tooltip = t("status.tooltip.error")
        this.item.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.errorBackground"
        )
        this.item.color = undefined
        break
      case "stopped":
      default:
        this.item.text = `$(circle-outline) ${EXTENSION_DISPLAY_NAME}`
        this.item.tooltip = t("status.tooltip.stopped")
        this.item.backgroundColor = undefined
        this.item.color = undefined
        break
    }
  }

  update(state: ServerState): void {
    this.state = state
    this.render()
  }

  showBusy(label: string, tooltip?: string): void {
    this.transientStatus = {
      text: `$(sync~spin) ${EXTENSION_DISPLAY_NAME} ${label}`,
      tooltip: tooltip || tFmt("status.tooltip.busy", { label }),
      backgroundColor: undefined,
      color: LOADING_COLOR,
    }
    this.render()
  }

  clearBusy(): void {
    this.transientStatus = null
    this.render()
  }

  dispose(): void {
    this.item.dispose()
  }
}
