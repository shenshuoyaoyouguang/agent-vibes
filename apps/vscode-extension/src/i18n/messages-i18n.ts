import { type DashboardLocale, readDashboardLocale } from "./dashboard-i18n"

/**
 * Notification and status bar messages used across commands, services, and views.
 * Keys are grouped by feature area (forwarding/cert/sync/update/etc.) and
 * resolved via {@link t} or {@link tFmt}.
 */
const EN: Record<string, string> = {
  // ── Setup / onboarding ──
  "setup.needsSetup": "Agent Vibes needs setup: {missing} not configured.",
  "setup.missing.certs": "SSL certificates",
  "setup.missing.accounts": "backend accounts",
  "setup.action.now": "Setup Now",
  "setup.action.later": "Later",
  "setup.addAccountHint":
    "Add at least one backend account from the Agent Vibes Dashboard.",

  // ── Forwarding ──
  "forwarding.enabledRestart":
    "Forwarding is enabled. Fully restart Cursor to apply DNS/hosts changes.",
  "forwarding.action.quit": "Quit Cursor Now",
  "forwarding.alreadyActive": "Forwarding is already active.",
  "forwarding.bridgeStartedAlready":
    "Bridge started! Forwarding already active.",
  "forwarding.promptEnable":
    "Bridge is running! Enable network forwarding? (requires sudo)",
  "forwarding.action.enable": "Enable",
  "forwarding.statusLine":
    "Forwarding: {state} | Hosts: {hosts}{loopback} | {backendLabel}: {backend}",
  "forwarding.state.active": "✅ Active",
  "forwarding.state.inactive": "❌ Inactive",
  "forwarding.loopbackSuffix": " | Loopback: {flag}",

  // ── Bridge ──
  "bridge.failedRestart":
    "Agent Vibes failed to restart on port {port}: {message}",
  "bridge.restartingBusy": "Restarting…",
  "bridge.restartingTooltip": "Agent Vibes — Restarting bridge on port {port}",
  "bridge.reconfiguringBusy": "Reconfiguring…",
  "bridge.reconfiguringTooltip":
    "Agent Vibes — Reconfiguring forwarding for port {port}",

  // ── Terminal titles ──
  "terminal.enableForwarding": "Agent Vibes — Enable Forwarding",
  "terminal.disableForwarding": "Agent Vibes — Disable Forwarding",
  "terminal.reconfigureForwarding": "Agent Vibes — Reconfigure Forwarding",
  "terminal.trustCa": "Agent Vibes — Trust CA",

  // ── Cursor checksums / patches ──
  "checksums.failed": "Failed to update Cursor checksums: {detail}",
  "checksums.updated":
    "Updated {count} Cursor checksum(s). Fully restart Cursor to apply.",
  "checksums.alreadyMatched":
    "Cursor checksums already match the current core files.",
  "checksums.unknownError": "Unknown error",
  "patches.resetFailed": "Failed to reset Cursor patches: {detail}",
  "patches.resetSummary":
    "Reset {count} Cursor file(s). Fully restart Cursor to apply.",

  // ── Credential sync ──
  "sync.antigravityIde.success":
    "Synced Antigravity IDE credentials for {email}",
  "sync.antigravityIde.failed": "Credential sync failed: {message}",
  "sync.antigravityTools.notFound":
    "Antigravity Tools not found (~/.antigravity_tools/accounts.json missing)",
  "sync.antigravityTools.empty": "No accounts in Antigravity Tools",
  "sync.antigravityTools.invalid":
    "No valid accounts found in Antigravity Tools",
  "sync.antigravityTools.success":
    "Synced {count} account(s) from Antigravity Tools",
  "sync.antigravityTools.failed": "Sync failed: {message}",
  "sync.claude.failed": "Claude sync failed: {message}",
  "sync.codex.failed": "Codex sync failed: {message}",
  "sync.cpa.openLabel": "Import CPA JSONs",
  "sync.cpa.failed": "Codex CPA import failed: {message}",
  "sync.summaryWithDest": "{summary} → {dest}",

  // ── File access ──
  "file.openOpenAICompatFailed":
    "Open OpenAI-compatible accounts file failed: {message}",
  "file.openClaudeApiFailed": "Open Claude API accounts file failed: {message}",
  "file.openKiroFailed": "Open Kiro accounts file failed: {message}",
  "file.openAccountFailed": "Failed to open account file",

  // ── SSL certificates / CA trust ──
  "cert.alreadyTrusted":
    "SSL certificates regenerated. CA is already trusted (system + Node.js).",
  "cert.generated.prompt":
    "SSL certificates generated. Trust the CA now? (Requires password — configures system trust + Cursor environment)",
  "cert.action.trust": "Trust CA Now",
  "cert.action.skip": "Skip",
  "cert.failed": "Failed to generate SSL certificates: {message}",

  // ── Updates ──
  "update.checkFailed": "Update check failed: {message}",
  "update.draftWarn": "The latest GitHub release is still marked as draft.",
  "update.upToDate": "{name} is already up to date ({version}).",
  "update.assetMissing":
    "Agent Vibes {version} is available, but no VSIX asset was found for {target}.",
  "update.available":
    "Agent Vibes {version} is available from GitHub Releases.",
  "update.action.install": "Install Update",
  "update.action.viewRelease": "View Release",
  "update.action.skip": "Skip This Version",
  "update.action.openRelease": "Open Release",
  "update.installing.title": "Installing {name} {version}",
  "update.progress.downloading": "Downloading VSIX...",
  "update.progress.downloadingPct": "Downloading VSIX... {pct}%",
  "update.progress.installing": "Installing VSIX...",
  "update.installed":
    "{name} {version} installed. Reload Cursor to activate it.",
  "update.action.reload": "Reload Window",
  "update.action.later": "Later",
  "update.installFailed": "Failed to install Agent Vibes {version}: {message}",

  // ── Dashboard webview-triggered toasts ──
  "dash.logCopied": "Log file path copied",
  "dash.debugModeChanged": "Debug Mode {state}. Restart bridge to apply?",
  "dash.debugMode.enabled": "enabled",
  "dash.debugMode.disabled": "disabled",
  "dash.action.restart": "Restart",
  "dash.action.later": "Later",
  "dash.settingUpdated": "{key} updated. Restart bridge to apply.",
  "dash.settingReset": "{key} reset to default.",
  "dash.token.invalid": "No valid refresh tokens found in the input.",
  "dash.token.added": "Added {count} account(s) to {channel}.",
  "dash.codex.invalidIndex": "Codex CLI: invalid account index {index}",
  "dash.codex.noRefreshToken":
    "Codex CLI: this account has no refresh token and cannot be activated.",
  "dash.codex.switched": "Codex CLI: switched to {label}",
  "dash.codex.activateFailed": "Codex CLI activation failed: {message}",

  // ── Manual context compaction ──
  "compact.bridgeNotRunning":
    "Agent Vibes bridge is not running — start it before requesting a manual compaction.",
  "compact.noSessions": "No active Cursor sessions are loaded.",
  "compact.pickSession": "Select a session to compact now",
  "compact.applied":
    "Compacted {archived} archived messages into a {summary}-token summary.",
  "compact.noProgress":
    "No compaction was needed — the session is already within budget.",
  "compact.failed": "Manual compaction failed: {error}",

  // ── Status bar tooltips ──
  "status.tooltip.running": "Agent Vibes — Running (click to open dashboard)",
  "status.tooltip.starting": "Agent Vibes — Starting...",
  "status.tooltip.error": "Agent Vibes — Error (click to open dashboard)",
  "status.tooltip.stopped": "Agent Vibes — Stopped (click to open dashboard)",
  "status.tooltip.busy": "Agent Vibes — {label}",
  "status.text.starting": "Starting…",
}

const ZH: Record<string, string> = {
  // ── Setup / onboarding ──
  "setup.needsSetup": "Agent Vibes 需要完成初始化：{missing} 尚未配置。",
  "setup.missing.certs": "SSL 证书",
  "setup.missing.accounts": "后端账号",
  "setup.action.now": "立即设置",
  "setup.action.later": "稍后",
  "setup.addAccountHint": "请在 Agent Vibes 控制台中至少添加一个后端账号。",

  // ── Forwarding ──
  "forwarding.enabledRestart":
    "已启用流量转发。请完整重启 Cursor 以应用 DNS / hosts 改动。",
  "forwarding.action.quit": "立即退出 Cursor",
  "forwarding.alreadyActive": "流量转发已经处于启用状态。",
  "forwarding.bridgeStartedAlready": "桥接已启动，流量转发也已生效。",
  "forwarding.promptEnable": "桥接已运行，是否启用网络转发？（需要 sudo）",
  "forwarding.action.enable": "启用",
  "forwarding.statusLine":
    "转发：{state} | Hosts：{hosts}{loopback} | {backendLabel}：{backend}",
  "forwarding.state.active": "✅ 已生效",
  "forwarding.state.inactive": "❌ 未生效",
  "forwarding.loopbackSuffix": " | Loopback：{flag}",

  // ── Bridge ──
  "bridge.failedRestart": "Agent Vibes 在端口 {port} 上重启失败：{message}",
  "bridge.restartingBusy": "重启中…",
  "bridge.restartingTooltip": "Agent Vibes — 正在端口 {port} 上重启桥接",
  "bridge.reconfiguringBusy": "重新配置中…",
  "bridge.reconfiguringTooltip": "Agent Vibes — 正在为端口 {port} 重新配置转发",

  // ── Terminal titles ──
  "terminal.enableForwarding": "Agent Vibes — 启用转发",
  "terminal.disableForwarding": "Agent Vibes — 关闭转发",
  "terminal.reconfigureForwarding": "Agent Vibes — 重新配置转发",
  "terminal.trustCa": "Agent Vibes — 信任 CA",

  // ── Cursor checksums / patches ──
  "checksums.failed": "更新 Cursor 校验和失败：{detail}",
  "checksums.updated":
    "已更新 {count} 个 Cursor 校验和。请完整重启 Cursor 以应用。",
  "checksums.alreadyMatched": "Cursor 校验和已与当前核心文件一致。",
  "checksums.unknownError": "未知错误",
  "patches.resetFailed": "重置 Cursor 补丁失败：{detail}",
  "patches.resetSummary":
    "已还原 {count} 个 Cursor 文件。请完整重启 Cursor 以应用。",

  // ── Credential sync ──
  "sync.antigravityIde.success": "已同步 Antigravity IDE 凭据（{email}）",
  "sync.antigravityIde.failed": "凭据同步失败：{message}",
  "sync.antigravityTools.notFound":
    "未找到 Antigravity Tools（缺少 ~/.antigravity_tools/accounts.json）",
  "sync.antigravityTools.empty": "Antigravity Tools 中没有账号",
  "sync.antigravityTools.invalid": "Antigravity Tools 中没有有效账号",
  "sync.antigravityTools.success": "已从 Antigravity Tools 同步 {count} 个账号",
  "sync.antigravityTools.failed": "同步失败：{message}",
  "sync.claude.failed": "Claude 同步失败：{message}",
  "sync.codex.failed": "Codex 同步失败：{message}",
  "sync.cpa.openLabel": "导入 CPA JSON",
  "sync.cpa.failed": "Codex CPA 导入失败：{message}",
  "sync.summaryWithDest": "{summary} → {dest}",

  // ── File access ──
  "file.openOpenAICompatFailed": "打开 OpenAI 兼容账号文件失败：{message}",
  "file.openClaudeApiFailed": "打开 Claude API 账号文件失败：{message}",
  "file.openKiroFailed": "打开 Kiro 账号文件失败：{message}",
  "file.openAccountFailed": "打开账号文件失败",

  // ── SSL certificates / CA trust ──
  "cert.alreadyTrusted": "SSL 证书已重新生成。CA 已被系统与 Node.js 信任。",
  "cert.generated.prompt":
    "SSL 证书已生成，是否立即信任 CA？（需要密码，将配置系统信任与 Cursor 环境）",
  "cert.action.trust": "立即信任",
  "cert.action.skip": "跳过",
  "cert.failed": "生成 SSL 证书失败：{message}",

  // ── Updates ──
  "update.checkFailed": "更新检查失败：{message}",
  "update.draftWarn": "GitHub 上最新的发布仍为草稿状态。",
  "update.upToDate": "{name} 已是最新版本（{version}）。",
  "update.assetMissing":
    "Agent Vibes {version} 已发布，但未找到适用于 {target} 的 VSIX。",
  "update.available": "GitHub Releases 上有可用更新：Agent Vibes {version}。",
  "update.action.install": "安装更新",
  "update.action.viewRelease": "查看发布",
  "update.action.skip": "跳过此版本",
  "update.action.openRelease": "打开发布页",
  "update.installing.title": "正在安装 {name} {version}",
  "update.progress.downloading": "正在下载 VSIX…",
  "update.progress.downloadingPct": "正在下载 VSIX… {pct}%",
  "update.progress.installing": "正在安装 VSIX…",
  "update.installed": "{name} {version} 已安装。请重新加载 Cursor 以激活。",
  "update.action.reload": "重新加载窗口",
  "update.action.later": "稍后",
  "update.installFailed": "安装 Agent Vibes {version} 失败：{message}",

  // ── Dashboard webview-triggered toasts ──
  "dash.logCopied": "日志文件路径已复制",
  "dash.debugModeChanged": "调试模式已{state}，是否重启桥接以应用？",
  "dash.debugMode.enabled": "启用",
  "dash.debugMode.disabled": "关闭",
  "dash.action.restart": "重启",
  "dash.action.later": "稍后",
  "dash.settingUpdated": "{key} 已更新，请重启桥接以应用。",
  "dash.settingReset": "{key} 已恢复为默认值。",
  "dash.token.invalid": "输入中未找到有效的 refresh token。",
  "dash.token.added": "已向 {channel} 添加 {count} 个账号。",
  "dash.codex.invalidIndex": "Codex CLI：无效的账号索引 {index}",
  "dash.codex.noRefreshToken":
    "Codex CLI：此账号没有 refresh token，无法激活。",
  "dash.codex.switched": "Codex CLI：已切换到 {label}",
  "dash.codex.activateFailed": "Codex CLI 激活失败：{message}",

  // ── 手动上下文压缩 ──
  "compact.bridgeNotRunning": "Agent Vibes 桥接未启动，无法触发手动压缩。",
  "compact.noSessions": "当前没有活跃的 Cursor 会话可以压缩。",
  "compact.pickSession": "选择需要立即压缩的会话",
  "compact.applied": "已压缩 {archived} 条历史消息，摘要 {summary} tokens。",
  "compact.noProgress": "当前会话尚未达到压缩阈值，无需压缩。",
  "compact.failed": "手动压缩失败：{error}",

  // ── Status bar tooltips ──
  "status.tooltip.running": "Agent Vibes — 运行中（点击打开控制台）",
  "status.tooltip.starting": "Agent Vibes — 启动中…",
  "status.tooltip.error": "Agent Vibes — 出现错误（点击打开控制台）",
  "status.tooltip.stopped": "Agent Vibes — 已停止（点击打开控制台）",
  "status.tooltip.busy": "Agent Vibes — {label}",
  "status.text.starting": "启动中…",
}

function format(
  template: string,
  vars?: Record<string, string | number>
): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : `{${name}}`
  )
}

/**
 * Resolve a localized message for the given key. Falls back to English when
 * the locale-specific entry is missing, then to the key itself.
 */
export function t(key: string): string {
  const locale: DashboardLocale = readDashboardLocale()
  const dict = locale === "zh" ? ZH : EN
  return dict[key] ?? EN[key] ?? key
}

/**
 * Resolve a localized message and interpolate `{name}` placeholders.
 */
export function tFmt(
  key: string,
  vars: Record<string, string | number>
): string {
  return format(t(key), vars)
}
