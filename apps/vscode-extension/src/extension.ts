import * as vscode from "vscode"
import { registerCommands } from "./commands"
import { CMD, STATE, type ServerState } from "./constants"
import { t, tFmt } from "./i18n/messages-i18n"
import { BridgeManager } from "./services/bridge-manager"
import { CertManager } from "./services/cert-manager"
import { ConfigManager } from "./services/config-manager"
import { ExtensionUpdateService } from "./services/extension-update"
import { NetworkManager } from "./services/network-manager"
import { logger } from "./utils/logger"
import { executePrivileged } from "./utils/terminal"
import { StatusIndicator } from "./views/status-indicator"

// Singleton references for cleanup
let bridge: BridgeManager | null = null
let network: NetworkManager | null = null
let statusIndicator: StatusIndicator | null = null

/**
 * Extension entry point — called on startup (onStartupFinished).
 */
export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  // Initialize logger
  logger.initialize()
  logger.info("Agent Vibes extension activating...")

  // Create core services
  const config = new ConfigManager()
  bridge = new BridgeManager(config, context.extensionPath)
  network = new NetworkManager()
  network.setExtensionPath(context.extensionPath)
  network.setPort(config.port)
  const cert = new CertManager(config)
  const updater = new ExtensionUpdateService(context)

  // Create UI
  statusIndicator = new StatusIndicator()

  // Update status bar when server state changes
  bridge.on("stateChanged", (state: ServerState) => {
    statusIndicator?.update(state)
  })

  // Register all commands
  registerCommands(context, bridge, config, cert, network, updater)

  let currentPort = config.port
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      const portChanged = event.affectsConfiguration("agentVibes.port")
      if (!portChanged) return

      const nextPort = config.port
      if (nextPort === currentPort) return

      const previousPort = currentPort
      currentPort = nextPort
      network?.setPort(nextPort)

      logger.info(`Agent Vibes port changed: ${previousPort} → ${nextPort}`)

      const bridgeRunning = bridge?.isRunning ?? false
      const forwardingActive = network?.isForwardingActive() ?? false

      try {
        if (bridgeRunning) {
          statusIndicator?.showBusy(
            t("bridge.restartingBusy"),
            tFmt("bridge.restartingTooltip", { port: nextPort })
          )
          await bridge?.restart()
          logger.info(`Bridge restarted on new port ${nextPort}`)
        }
      } catch (error) {
        statusIndicator?.clearBusy()
        const message = error instanceof Error ? error.message : String(error)
        logger.error(`Failed to restart bridge after port change`, error)
        void vscode.window.showErrorMessage(
          tFmt("bridge.failedRestart", { port: nextPort, message })
        )
        return
      }

      if (forwardingActive && network) {
        statusIndicator?.showBusy(
          t("bridge.reconfiguringBusy"),
          tFmt("bridge.reconfiguringTooltip", { port: nextPort })
        )
        executePrivileged(
          network.getReconfigureCommand(previousPort),
          t("terminal.reconfigureForwarding")
        )
        setTimeout(() => statusIndicator?.clearBusy(), 8000)
      } else {
        statusIndicator?.clearBusy()
      }
    })
  )

  // Push disposables
  context.subscriptions.push({
    dispose: () => {
      statusIndicator?.dispose()
      bridge?.dispose()
      network?.dispose()
      logger.dispose()
    },
  })

  // ── First-run onboarding ──────────────────────────────────────────
  const needsCerts = !config.hasCertificates()
  const hasAnyAccounts =
    config.getAccountCount(config.antigravityAccountsPath) > 0 ||
    config.getAccountCount(config.claudeApiAccountsPath) > 0 ||
    config.getAccountCount(config.codexAccountsPath) > 0 ||
    config.getAccountCount(config.openaiCompatAccountsPath) > 0

  if (needsCerts || !hasAnyAccounts) {
    const missing: string[] = []
    if (needsCerts) missing.push(t("setup.missing.certs"))
    if (!hasAnyAccounts) missing.push(t("setup.missing.accounts"))

    const action = await vscode.window.showInformationMessage(
      tFmt("setup.needsSetup", { missing: missing.join(" / ") }),
      t("setup.action.now"),
      t("setup.action.later")
    )

    if (action === t("setup.action.now")) {
      if (needsCerts) {
        await vscode.commands.executeCommand(CMD.GENERATE_CERT)
      }
      if (!hasAnyAccounts) {
        await vscode.commands.executeCommand(CMD.OPEN_DASHBOARD)
        vscode.window.showInformationMessage(t("setup.addAccountHint"))
      }
    }
  }

  const promptReloadAfterForwardingEnabled = async (): Promise<void> => {
    if (!network) return
    if (context.globalState.get<boolean>(STATE.FORWARDING_RELOAD_PROMPTED)) {
      return
    }

    const becameActive = await network.waitForForwardingActive()
    if (!becameActive) return

    await context.globalState.update(STATE.FORWARDING_RELOAD_PROMPTED, true)

    const action = await vscode.window.showInformationMessage(
      t("forwarding.enabledRestart"),
      t("forwarding.action.quit"),
      t("setup.action.later")
    )

    if (action === t("forwarding.action.quit")) {
      await vscode.commands.executeCommand("workbench.action.quit")
    }
  }

  // Auto-start if configured
  if (config.autoStart) {
    logger.info("Auto-start enabled, starting server...")
    bridge
      .start()
      .then(async () => {
        if (bridge!.state === "running") {
          logger.info("Bridge auto-started successfully")
          // Check if forwarding is already active (from previous session)
          if (network!.isForwardingActive()) {
            logger.info("Forwarding already active from previous session")
          } else {
            // Prompt user to enable forwarding via sudo terminal
            const action = await vscode.window.showInformationMessage(
              t("forwarding.promptEnable"),
              t("forwarding.action.enable"),
              t("setup.action.later")
            )
            if (action === t("forwarding.action.enable")) {
              executePrivileged(
                network!.getEnableCommand(),
                t("terminal.enableForwarding")
              )
              void promptReloadAfterForwardingEnabled()
            }
          }
        }
      })
      .catch((err) => {
        logger.warn(
          `Auto-start failed: ${err instanceof Error ? err.message : String(err)}`
        )
      })
  }

  void updater.checkForUpdatesOnStartup()

  logger.info("Agent Vibes extension activated")
}

/**
 * Extension deactivation — clean up all resources.
 */
export function deactivate(): void {
  bridge?.dispose()
  network?.dispose()
  statusIndicator?.dispose()
  logger.info("Agent Vibes extension deactivated")
  logger.dispose()
}
