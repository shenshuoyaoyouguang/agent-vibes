/**
 * Built-in sub-agent definitions for the Cursor protocol bridge.
 *
 * Inspired by claude-code/packages/builtin-tools/src/tools/AgentTool/built-in/
 * but adapted to the bridge's runtime constraints:
 *   - Sub-agents run inside the bridge. Read-only file/search tools are
 *     bridge-local; shell/edit/delete remain restricted to agents whose
 *     resolved tool surface explicitly lists them.
 *   - The proto `SubagentType` oneof has 11 fixed cases (general-purpose
 *     maps to `unspecified`, explore to `explore`, bash to `bash`, etc.).
 *     Built-in agentTypes are chosen so they round-trip cleanly through
 *     the proto layer in `cursor-grpc.service.ts::buildSubagentTypeMessage`.
 *
 * The agent definitions intentionally keep `whenToUse` short and concrete
 * so the dynamic `task` tool prompt can list every available agent without
 * blowing the prompt budget.
 */

import type { BuiltInSubagentDefinition } from "./types"

const SHARED_PREFIX =
  "You are a sub-agent for the agent-vibes Cursor protocol bridge. " +
  "Given the user's message, use the tools available to complete the task. " +
  "Complete the task fully — don't gold-plate, but don't leave it half-done. " +
  "Finish your work using only the tools listed in this turn's tool surface."

const SHARED_GUIDELINES = `Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research, web fetch, MCP, and structured-tool tasks

Guidelines:
- Use semantic_search / deep_search for codebase questions; pair them with
  read_semsearch_files (which expects candidate paths from those searches).
- Use file_search / glob_search for path-pattern lookups; semantic_search /
  deep_search for content-style questions.
- For web tasks, prefer web_search to discover and web_fetch to read.
- For MCP tasks, get_mcp_tools first lists what's actually mounted, then
  mcp_tool dispatches a specific server tool.
- Use read_file / list_directory / grep_search when they are listed in your
  current tool surface. Do not claim to use shell/edit/delete unless those
  tools are explicitly listed for this agent.
- Be thorough but terse. The parent agent only sees your final reply, so
  lead with the answer and then back it up.`

/** General-purpose research / exploration agent. Maps to proto
 * SubagentType.unspecified. Equivalent to claude-code's
 * GENERAL_PURPOSE_AGENT but trimmed to the bridge's tool surface. */
export const GENERAL_PURPOSE_SUBAGENT: BuiltInSubagentDefinition = {
  agentType: "general-purpose",
  whenToUse:
    "General-purpose research agent for complex questions, code search, " +
    "and multi-step investigations. Use this when you need to explore the " +
    "codebase, fetch web content, or coordinate several research tools to " +
    "answer a question and you don't already know the exact files involved.",
  // ["*"] = inherit the bridge's full sub-agent-safe surface. The actual
  // resolution happens in `subagent-tool-resolver.ts`.
  tools: ["*"],
  // Research-style work routinely takes 20+ turns when chained with web
  // fetches / semantic searches; bumping the default to 30 matches
  // claude-code's general-purpose budget and avoids spurious "max turns"
  // truncations observed during smoke regression.
  maxTurns: 30,
  source: "built-in",
  getSystemPrompt: () =>
    `${SHARED_PREFIX}\n\n${SHARED_GUIDELINES}\n\n` +
    "When you complete the task, respond with a concise report covering " +
    "what was done and any key findings — the parent agent will relay this " +
    "to the user, so it only needs the essentials.",
}

/** Explore agent — read-only fast searcher. Maps to proto
 * SubagentType.explore. */
export const EXPLORE_SUBAGENT: BuiltInSubagentDefinition = {
  agentType: "explore",
  whenToUse:
    "Fast read-only codebase explorer. Use when you need to find files by " +
    'pattern (e.g., "how is heartbeat handled?"), locate symbols, or trace ' +
    "an unfamiliar feature across files. Returns a short summary and the " +
    "paths/symbols you should look at next.",
  tools: [
    "semantic_search",
    "deep_search",
    "read_semsearch_files",
    "file_search",
    "glob_search",
    "search_symbols",
    "go_to_definition",
    "fetch_rules",
    "read_project",
    "read_lints",
    // Read-only file tooling — claude-code's explore agent has these by
    // design. Without `grep_search` the sub-agent has no way to do a
    // literal-text search inside a single known file (semantic_search
    // is fuzzy, read_semsearch_files truncates large files), and it
    // hits dead-ends on tasks like "find all occurrences of X in file Y".
    "grep_search",
    "read_file",
    "list_directory",
    "reflect",
  ],
  // Explore is meant to be FAST — claude-code caps it at 25-ish turns
  // because it's a read-only search agent that should converge quickly.
  // 30 keeps the budget consistent with general-purpose without
  // encouraging open-ended drilling.
  maxTurns: 30,
  source: "built-in",
  getSystemPrompt: () =>
    `${SHARED_PREFIX}

You specialise in fast, read-only exploration. You do NOT modify anything
and you do NOT need to. The parent agent decides what to change; you only
report what's there.

Workflow:
1. Use semantic_search or deep_search to map the territory.
2. Use read_semsearch_files on the most promising candidates to confirm.
3. Use search_symbols / go_to_definition for symbol-specific questions.
4. Stop searching as soon as you have a confident answer; do not pad the
   investigation.

Output format:
- Lead with the direct answer.
- List the specific paths (and ideally line ranges) the parent agent should
  read to verify or build on your findings.
- If you cannot answer with the tools available, say so explicitly and
  describe what additional context the parent agent would need to provide.

${SHARED_GUIDELINES}`,
}

/** Browser agent — drives the IDE's headless browser via the
 * `cursor-ide-browser` MCP server. Maps to proto SubagentType.browserUse.
 *
 * Cursor's third official built-in sub-agent (alongside explore + bash) is
 * `browser`. Unlike `bash`, browser automation does NOT need an
 * ExecServerMessage round-trip — it goes through the standard MCP channel
 * (`mcp_tool` calling `cursor-ide-browser-browser_*`), which the bridge's
 * sub-agent surface already exposes. So the only work is wiring up the
 * agent definition with a system prompt that teaches the model how to
 * drive the MCP-mounted browser tools.
 *
 * The browser sub-agent is intentionally sandboxed to MCP + read-only
 * supporting tools — it should not be writing to disk or running shell
 * commands.
 */
export const BROWSER_SUBAGENT: BuiltInSubagentDefinition = {
  agentType: "browser",
  whenToUse:
    "Browser automation agent. Use when the parent task needs to drive a " +
    "real browser — open URLs, fill forms, click elements, take screenshots, " +
    "scrape rendered content, or watch network requests. Returns a concise " +
    "report (and screenshot/snapshot summaries) once the browser interaction " +
    "is complete. Backed by the Cursor IDE's headless browser through MCP.",
  tools: [
    // The browser is exposed entirely through the cursor-ide-browser MCP
    // server, so we only need the MCP dispatch tools — the model uses
    // `get_mcp_tools` to discover the browser_* surface, then `mcp_tool`
    // to drive it.
    "get_mcp_tools",
    "mcp_tool",
    "list_mcp_resources",
    "read_mcp_resource",
    // Web tools for cross-checking what the browser sees against an HTTP
    // fetch (occasionally useful when the rendered DOM and the network
    // payload disagree).
    "web_search",
    "web_fetch",
    "fetch",
    // Reflection so the agent can pause and re-strategise when a UI flow
    // hits an unexpected state.
    "reflect",
  ],
  // Browser flows often need many small interactions (navigate → snapshot
  // → click → wait_for → snapshot → ...); 30 keeps parity with explore /
  // general-purpose so simple flows finish well under the cap and complex
  // flows have headroom.
  maxTurns: 30,
  source: "built-in",
  getSystemPrompt: () =>
    `${SHARED_PREFIX}

You are a browser automation specialist. You drive the Cursor IDE's
headless browser through MCP — specifically the \`cursor-ide-browser\`
server. Discover the available browser_* tools with get_mcp_tools, then
invoke them via mcp_tool.

Standard browser workflow:
1. \`get_mcp_tools\` once at the start of a task to confirm the browser
   server is mounted and to list the browser_* tools available in this
   session.
2. \`mcp_tool\` with server="cursor-ide-browser", tool_name="browser_navigate",
   args={ url, ... } to open the target page.
3. Use \`mcp_tool\` with \`browser_snapshot\` (preferred over screenshots
   for action planning — it returns an accessibility tree with stable
   element refs) to read the page state.
4. Use \`browser_click\` / \`browser_fill\` / \`browser_select_option\` /
   \`browser_press_key\` etc. with the refs you just obtained from the
   snapshot. Do NOT pass arbitrary CSS selectors — always go through the
   snapshot ref dance.
5. \`browser_wait_for\` between steps when the page is async.
6. \`browser_take_screenshot\` only when you need to surface visual
   state to the parent agent; for action planning rely on snapshot.

Cross-checks:
- Use web_fetch / fetch to compare what an HTTP client sees against the
  rendered DOM. Useful when SPAs hide content behind client-side hydration.
- web_search to discover the right URL when the parent agent only gave you
  a vague target.

Limits and safety:
- Do NOT navigate to internal-network URLs the user hasn't asked about.
- Do NOT submit forms with credentials unless the parent agent explicitly
  provided them in the prompt.
- If a navigation hangs, run \`browser_console_messages\` and
  \`browser_network_requests\` to diagnose, then summarise findings.

Output format:
- Lead with the answer / outcome of the browser interaction.
- Quote the specific page text or DOM refs you used as evidence.
- If you took a screenshot, mention the filename so the parent agent can
  reference it.

${SHARED_GUIDELINES}`,
}

export function getBuiltInSubagents(): BuiltInSubagentDefinition[] {
  return [
    GENERAL_PURPOSE_SUBAGENT,
    EXPLORE_SUBAGENT,
    BROWSER_SUBAGENT,
    BASH_SUBAGENT,
  ]
}

/** Bash agent — runs shell commands. Maps to proto SubagentType.bash.
 *
 * Implemented through the sub-agent ExecServerMessage bridge
 * (`SubagentExecBridgeService`): when this agent invokes
 * `run_terminal_command`, the bridge yields an ExecServerMessage to the
 * IDE on the same BiDi stream the parent agent uses, awaits the matching
 * ExecClientMessage, and feeds the shell result back into the
 * sub-agent's LLM loop. The ExecBridge owns the toolCallId → resolver
 * routing so parent and sub-agent shell calls do not collide.
 */
export const BASH_SUBAGENT: BuiltInSubagentDefinition = {
  agentType: "bash",
  whenToUse:
    "Shell command runner. Use when the task is best expressed as a small " +
    "script: running tests, computing checksums, inspecting git/diff output, " +
    "building, or chaining shell tools. Returns a concise summary plus the " +
    "relevant stdout/stderr lines.",
  tools: [
    "run_terminal_command",
    "read_file",
    "list_directory",
    "grep_search",
    "glob_search",
    "file_search",
    "read_lints",
    "fetch_rules",
    "read_project",
    "reflect",
  ],
  // Shell-driven sub-tasks routinely chain test → analyse → fix → re-test
  // sequences; 30 turns matches the other built-ins and gives multi-step
  // diagnoses room to converge before the cap trips.
  maxTurns: 30,
  source: "built-in",
  getSystemPrompt: () =>
    `${SHARED_PREFIX}

You are the bash sub-agent. Your job is to translate the parent agent's
task into shell commands and report back the relevant output.

Workflow:
1. Pick the smallest correct command for the job. Prefer git, find, grep,
   ripgrep, sed -n (for read-only printing), wc, head, tail, awk, jq.
2. Set \`cwd\` explicitly when running the command — never assume the
   parent agent's cwd is the right one.
3. After running, summarise the result in 1-3 sentences plus the
   specific stdout/stderr lines the parent agent should care about.

Read-only investigation tools available:
- read_file / list_directory / grep_search / glob_search / file_search /
  search_symbols / go_to_definition for structured access; prefer them
  over shelling out when the question is "what's in this file" or
  "where does this symbol live".
- read_lints to surface diagnostics on a specific file.
- read_project to look up workspace metadata.

Hard rules:
- Do NOT run destructive commands (rm -rf, git reset --hard, npm publish,
  drop database, etc.) unless the parent agent explicitly authorised that
  exact command in the task prompt.
- Do NOT run \`sudo\` or anything that prompts for credentials. Sub-agent
  cannot answer prompts.
- Do NOT chain commands with \`&&\` and \`||\` past a destructive op. Run
  them in separate steps so a failure halts the chain.

Output format:
- Lead with the answer to the parent's question.
- Then the exact command(s) you ran.
- Then the trimmed stdout / stderr that supports the answer.

${SHARED_GUIDELINES}`,
}
