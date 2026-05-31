你现在是一名 QA 自动化工程师，正在对 `agent-vibes` 项目的 Cursor `agent.v1` 工具桥接能力执行一次**任务驱动 smoke 回归测试**。

这不是全量协议矩阵审计。不要按 Layer 1-8 展开所有 oneof 分支。
你的目标是：按下面给出的任务完成真实可见目标；任务可以显式要求调用**客户端当前暴露给 agent 的工具名**，
但不能把 proto oneof、Exec/Interaction case、mapper 内部别名、后端实现名或当前客户端没有暴露的工具名当作可调用工具。
执行后观察可见副作用、trace 摘要和最终结果，判断“任务完成得如何、实际工具映射到了哪些协议 case、还剩哪些覆盖 gap”。

## 核心原则

1. 按任务顺序执行；不要先输出方案。
2. 可以显式调用客户端当前可见的工具名；例如客户端暴露 `read_file`、`web_search`、`web_fetch` 时，可以直接要求调用这些工具。
3. 禁止把协议内部 case 当工具调用：例如 `ToolCall.tool`、`ExecServerMessage.*`、`ExecClientMessage.*`、`InteractionQuery.*`、`InteractionUpdate.*` 只能作为 trace 观察项，不能写成“调用某某 case”。
4. 禁止用未暴露或相似名字顶替真实工具名；如果客户端只暴露 `web_search`，就不能声称调用了 `exa_search`；如果只暴露 `web_fetch`，就不能声称调用了 `fetch`。
5. 如果客户端工具面没有暴露某个能力，不要硬凑调用；在最终覆盖清单中记录 `not_directly_invokable` 或 `unavailable`，并说明原因。
6. 执行方式是任务驱动，但覆盖清单不能缩水；所有当前 Cursor 协议 ToolCall / Interaction / Exec / ConversationAction / InteractionUpdate 都必须通过 trace 观察或明确判定 gap。
7. 不输出 Layer 1-8 全量矩阵；但最终报告必须按下方完整覆盖清单逐项给出状态，不能遗漏工具、功能或状态机分支。
8. 最终报告重点是：任务目标、期望客户端工具、实际触发工具、结果、证据、gap；覆盖清单用紧凑分组摘要表达。
9. 写操作只允许发生在 smoke 工作目录下（默认 `~/.agent-vibes/smoke/`，可通过环境变量 `$AGENT_VIBES_SMOKE_DIR` 覆盖）。
   **禁止**把 smoke 文件、trace 文件或其他临时产物写到仓库工作树内，包括 `.cursor-protocol-smoke/`、`apps/**/.log/`、`.log/`、`tmp/` 等子路径。
10. 禁止执行：`git reset --hard`、`git checkout --`、`git clean`、`rm -rf`、`sudo`、安装依赖、提交 commit、修改业务源码、访问敏感凭据。
11. 网络、MCP、子代理、PR、图像、VM 等外部能力可以失败；失败必须记录原因，不要因此中断整轮。
12. 如果某个工具需要用户授权或 IDE 内部状态，按实际结果记录，不要伪造成功。
13. 禁止使用 `example.com`、`example.org`、`example.net` 等保留示例域名作为网络能力证据；网络任务必须面向真实官方站点。
14. 这份 prompt 可能被多个 agent 并行执行；任何"固定文件名 / 固定 todo id / 固定 plan name"
    都要按下文 [会话隔离] 章节的规则带上 `$RUN_ID` 命名空间，**禁止**直接复用同名资源
    导致与其它并行 session 互相覆盖。

## 会话隔离 / 并行执行规约

本 smoke 测试可能由多个 agent 并行执行（同一台机器、同一个 bridge / IDE 进程）。
为了避免互相破坏对方的状态，agent **必须**在 trace baseline 之前先建立一个本轮 session 专属的命名空间：

```bash
# 8 字符随机 ID（小写 hex，足够避免碰撞，不要太长污染日志）
RUN_ID="${SMOKE_RUN_ID:-$(node -e 'process.stdout.write(require("crypto").randomBytes(4).toString("hex"))')}"
export SMOKE_RUN_ID="$RUN_ID"

# 把 smoke 工作目录指到 RUN_ID 子目录；如果用户已经显式设置过 AGENT_VIBES_SMOKE_DIR，
# 尊重用户设置（用户自己负责隔离），否则用 ~/.agent-vibes/smoke/<RUN_ID>。
if [ -z "${AGENT_VIBES_SMOKE_DIR:-}" ]; then
  export AGENT_VIBES_SMOKE_DIR="$HOME/.agent-vibes/smoke/$RUN_ID"
fi

mkdir -p "$AGENT_VIBES_SMOKE_DIR"
echo "RUN_ID=$RUN_ID  SMOKE_DIR=$AGENT_VIBES_SMOKE_DIR"
```

`capture-trace-baseline.js` 全程读 `$AGENT_VIBES_SMOKE_DIR` 来定位 smoke 目录、
`.trace-baseline.json` 状态文件以及 `reset-smoke` 写入根；只要上面这段 export 生效，
seed 文件、baseline 状态、3 节里的临时文件、4 节里的 plan_uri 引用都会自动落到本轮独立目录。

### 资源隔离矩阵

下表里**会话隔离**的资源每轮 session 必须用独立命名空间；**全局共享**的资源所有并行 session 共用一份，agent 只能通过自己 session 内的标识（callId / execId / conversationId / 时间窗）来过滤本轮事件。

| 资源                                                | 类型     | 隔离方式                                                                                    |
| --------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `<SMOKE>` 下所有种子文件 / 临时文件                 | 会话隔离 | 通过 `$AGENT_VIBES_SMOKE_DIR=...$RUN_ID/` 隔离                                              |
| `.trace-baseline.json`                              | 会话隔离 | 落在 `$AGENT_VIBES_SMOKE_DIR` 内，自动跟随                                                  |
| `create_plan` 的 `name` / `plan_uri`                | 会话隔离 | name 必须以 `RUN_ID` 后缀区分（见任务 4b）                                                  |
| Sub-agent 工作目录 `~/.cursor/subagents/<agentId>/` | 会话隔离 | `agentId` 由 bridge 生成，本身唯一                                                          |
| Cursor protocol trace 文件                          | 全局共享 | bridge 进程级；不要寄望 `new_records` 精确等于本轮事件数，按 callId / execId 关联本 session |
| bridge log (`$TMPDIR/agent-vibes-bridge.log`)       | 全局共享 | 多 session 写同一文件；grep 关键词时只看本轮 session 时间窗（用 mtime / `tail -n` 限定）    |
| Cursor IDE plan 注册表                              | 全局共享 | 多 plan 共存；用 `name` 后缀 + 校对 `plan_uri` 区分自己的 plan                              |
| Todos（`update_todos` / `read_todos`）              | 会话隔离 | bridge 把 todo 状态绑在 conversation/session 上，跨 session 不共享，无需后缀                |

### 命名约束

- 所有写入 `<SMOKE>` 的临时文件**不要**再硬编码 `created_by_test.txt` 这类全局名；
  按任务 3d 里的指示带 `RUN_ID` 后缀（见 3d 章节）。
- `create_plan` 的 `name` **必须**带 `RUN_ID` 后缀，避免 IDE 侧栏和 plan_uri 冲突。
- `proto-smoke-todo-1` / `proto-smoke-todo-2` 与 `task-5..task-11` 这些 todo id
  在 bridge 内是 session-scoped，跨 session 不共享，**无需**加后缀；保留固定 id
  方便报告核对。如果实际跑下来发现 todo 状态被串了（同一 conversation 里看到不属于本轮的 id），
  在最终报告 Failures 里记 hard failure 并写明原因。

## Trace 记录要求

开始前尝试定位 protocol trace 文件并记录基线行数或 mtime。优先路径：

1. `$CURSOR_PROTOCOL_TRACE_FILE`
2. `$AGENT_VIBES_LOG_DIR/cursor_protocol_trace.jsonl`
3. `~/.agent-vibes/logs/cursor_protocol_trace.jsonl`（默认 fallback；agent-vibes bridge 写入位置）

trace 文件不允许出现在仓库工作树内。如果在 `apps/**/.log/`、`.log/`、`<repo>/cursor_protocol_trace*` 等位置看到 trace 文件，视为污染，需要记录并删除，不能用作基线。

最终报告必须给出本轮新增 trace 的摘要：

- trace 文件路径
- 新增记录数量（baseline → 终态的 appended 行数；并行场景下这个数字**包含**其它 session 同时写入的事件，**不是**本轮 session 独占的事件数）
- 观察到的关键 `topCase` 与 `topCase.nestedCase` 直方图（前 10 即可）
- 关键 `callId/id/execId` 对齐是否大体正常
- 是否看到明显 error、abort、pending 泄漏、重复结算或提前结束

为保证 trace delta 计数稳定，**必须**使用仓库自带的 baseline 工具：

```bash
# 开始 smoke 之前
node scripts/smoke/capture-trace-baseline.js capture

# smoke 结束后
node scripts/smoke/capture-trace-baseline.js delta
```

`capture` 会把当前 trace 文件的 size / line_count / mtime 写入
`$AGENT_VIBES_SMOKE_DIR/.trace-baseline.json`；因为前面的 [会话隔离] 章节已经把
`$AGENT_VIBES_SMOKE_DIR` 指到了 `<RUN_ID>` 子目录，每个并行 agent 的 baseline
状态文件互不覆盖。`delta` 只读取 baseline 偏移量之后追加的字节，输出
appended-only 的行数与 `top_cases` / `nested_cases` 直方图。脚本对 trace
文件保持只读，不会破坏其它会话的同时写入；脚本同时会拒绝把 baseline 状态文件
写到仓库工作树内（防御 `$AGENT_VIBES_SMOKE_DIR` 误配）。

**并行场景注意**：trace 文件是 bridge 进程级共享的（参考 [会话隔离] 资源矩阵）。
即便 baseline 脚本本身工作正常，`delta` 输出的 `new_records` 数字也会**包含**所有
并行 session 在同一时间窗内写入的事件。Coverage Checklist 中的 trace 关联**只能**
通过本 session 自己掌握的 `callId / id / execId` 集合做过滤，不能假设 delta 直方图里
每条事件都属于自己。报告 Trace Summary 章节里 `new_records` 直接报 baseline 工具的
原始数字即可，不需要尝试拆出"本轮 session 独占"的子集。

bridge 自身也加了一道保险：`CursorProtocolTraceService.tracePath()` 通过
`guardAgainstRepoPollution()` 检测目标路径是否落在某个 `.git/` 祖先目录下，
若是则强制回退到 `$HOME/.agent-vibes/logs/cursor_protocol_trace.jsonl`。即便
`$CURSOR_PROTOCOL_TRACE_FILE` 被误指到 `apps/**` 之下，也不会真正污染仓库。

不要输出完整 decoded frame 列表，除非发现异常。

## Smoke 工作区

所有文件任务都使用 smoke 工作目录（默认 `~/.agent-vibes/smoke/`，下文用 `<SMOKE>` 占位；如设置了 `$AGENT_VIBES_SMOKE_DIR` 则用其值）。**禁止在仓库内创建 `.cursor-protocol-smoke/` 或其他 smoke 目录**。开始时创建或重置以下文件；不得删除该目录之外任何内容：

- `<SMOKE>/a.txt`：内容 `alpha`
- `<SMOKE>/b.txt`：内容 `beta`
- `<SMOKE>/delete_me.txt`：内容 `delete`
- `<SMOKE>/todo-seed.md`：至少两行文本
- `<SMOKE>/subdir/nested.txt`：内容 `nested alpha beta`
- `<SMOKE>/env.txt`：内容 `PLACEHOLDER_ENV=old`

可以直接用仓库脚本自动化重置 smoke 目录到上述种子状态：

```bash
node scripts/smoke/capture-trace-baseline.js reset-smoke
```

脚本只会写入 `$AGENT_VIBES_SMOKE_DIR` 之内（默认 `~/.agent-vibes/smoke/`），
若该路径解析到仓库工作树会直接 throw 拒绝执行。

## 完整覆盖清单（不得删减）

执行任务时必须覆盖或判定以下清单。状态使用 5 态：`pass | failed | unavailable | not_directly_invokable | not_observed`。如果某项没有被真实触发，必须在 gap 列写清楚原因，不能因为任务分组里没有单独步骤就遗漏。

### A. AgentClientMessage / AgentServerMessage

- AgentClientMessage：`run_request`、`exec_client_message`、`kv_client_message`、`conversation_action`、`exec_client_control_message`、`interaction_response`、`client_heartbeat`、`prewarm_request`
- AgentServerMessage：`interaction_update`、`exec_server_message`、`conversation_checkpoint_update`、`kv_server_message`、`exec_server_control_message`、`interaction_query`

### B. InteractionUpdate

必须观察或判定：`text_delta`、`tool_call_started`、`tool_call_completed`、`thinking_delta`、`thinking_completed`、`user_message_appended`、`partial_tool_call`、`token_delta`、`summary`、`summary_started`、`summary_completed`、`shell_output_delta`、`heartbeat`、`turn_ended`、`tool_call_delta`、`step_started`、`step_completed`、`prompt_suggestion`、`post_request_prompt`、`active_branch_change`、`feedback_request`。

### C. InteractionQuery / InteractionResponse

必须尝试或判定 10 对 query/response：

1. `webSearchRequestQuery` ↔ `webSearchRequestResponse`
2. `askQuestionInteractionQuery` ↔ `askQuestionInteractionResponse`
3. `switchModeRequestQuery` ↔ `switchModeRequestResponse`
4. `createPlanRequestQuery` ↔ `createPlanRequestResponse`
5. `setupVmEnvironmentArgs` ↔ `setupVmEnvironmentResult`
6. `webFetchRequestQuery` ↔ `webFetchRequestResponse`
7. `prManagementRequestQuery` ↔ `prManagementResult`
8. `mcpAuthRequestQuery` ↔ `mcpAuthRequestResponse`
9. `generateImageRequestQuery` ↔ `generateImageRequestResponse`
10. `replaceEnvArgs` ↔ `replaceEnvResult`

### D. 工具家族总表（ToolCall.tool 45 项 + Mapper user-facing 名）

每一个 mapper 暴露的工具名都映射到 `agent.v1.ToolCall.tool` 的某个 proto oneof case。
不再要求逐项独立列；按下表分组覆盖即可，每组只需要：
**该家族的工具是否真被调用过 + 对应 proto case 是否在 trace 中观察到**。

| Family                 | ToolCall.tool proto case                                                                                                                                                                                             | User-facing 工具名                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| filesystem.read        | `readToolCall`、`lsToolCall`、`globToolCall`                                                                                                                                                                         | `read_file`、`read_file_v2`、`list_directory`、`list_dir`、`glob_search`、`file_search`、`view_image`                                                         |
| filesystem.write       | `editToolCall`、`deleteToolCall`                                                                                                                                                                                     | `edit_file`、`edit_file_v2`、`delete_file`、`apply_patch`、`reapply`                                                                                          |
| shell                  | `shellToolCall`、`writeShellStdinToolCall`                                                                                                                                                                           | `run_terminal_command`、`run_terminal_command_v2`、`background_shell_spawn`、`write_shell_stdin`                                                              |
| search.code            | `grepToolCall`、`semSearchToolCall`                                                                                                                                                                                  | `grep_search`、`semantic_search`、`deep_search`、`read_semsearch_files`、`search_symbols`、`go_to_definition`                                                 |
| diagnostics            | `readLintsToolCall`                                                                                                                                                                                                  | `read_lints`、`fix_lints`                                                                                                                                     |
| planning + todos       | `createPlanToolCall`、`updateTodosToolCall`、`readTodosToolCall`                                                                                                                                                     | `create_plan`、`create_diagram`、`update_todos`、`read_todos`                                                                                                 |
| network                | `webSearchToolCall`、`webFetchToolCall`、`fetchToolCall`                                                                                                                                                             | `web_search`、`web_fetch`、`fetch`、`exa_search`、`exa_fetch`、`knowledge_base`                                                                               |
| mcp                    | `mcpToolCall`、`listMcpResourcesToolCall`、`readMcpResourceToolCall`、`getMcpToolsToolCall`、`mcpAuthToolCall`                                                                                                       | `mcp_tool`、`list_mcp_resources`、`read_mcp_resource`、`get_mcp_tools`、`mcp_auth`                                                                            |
| sub-agent + background | `taskToolCall`、`awaitToolCall`                                                                                                                                                                                      | `task`、`await_task`、`await`、`wait_agent`、`kill_agent`、`spawn_agent`、`resume_agent`、`close_agent`、`send_input`、`background_composer_followup`         |
| IDE-integration        | `askQuestionToolCall`、`switchModeToolCall`、`applyAgentDiffToolCall`、`generateImageToolCall`、`recordScreenToolCall`、`computerUseToolCall`、`reflectToolCall`、`setupVmEnvironmentToolCall`、`replaceEnvToolCall` | `ask_question`、`switch_mode`、`apply_agent_diff`、`generate_image`、`record_screen`、`computer_use`、`reflect`、`setup_vm_environment`、`request_user_input` |
| project + rules        | —                                                                                                                                                                                                                    | `read_project`、`update_project`、`fetch_rules`                                                                                                               |
| PR / VCS               | `prManagementToolCall`、`blameByFilePathToolCall`、`setActiveBranchToolCall`、`updatePrCodeTourToolCall`、`editPrLabelsToolCall`                                                                                     | `fetch_pull_request`、`ai_attribution`                                                                                                                        |
| reporting              | `reportBugfixResultsToolCall`、`reportBugToolCall`、`communicateUpdateToolCall`、`sendFinalSummaryToolCall`                                                                                                          | `report_bugfix_results`                                                                                                                                       |
| grind                  | `startGrindExecutionToolCall`、`startGrindPlanningToolCall`                                                                                                                                                          | `start_grind_execution`、`start_grind_planning`                                                                                                               |
| 协议占位               | `truncatedToolCall`                                                                                                                                                                                                  | — （仅作为 size-guard 兜底；trace 里看到即视为 gap）                                                                                                          |

要求：

- 每个 family 至少有一项工具被真实调用过，对应 proto case 在 trace 中可被观察。
- 没暴露的工具记 `not_directly_invokable`；暴露但本轮未调用记 `not_observed`。
- 出现 `truncatedToolCall` 即视为 inner tool 镜像或 size-guard 异常，记为 gap。
- 任何 user-facing 工具与 proto case 之间的具体映射，由 trace 的 `topCase/nestedCase` 事实决定，**不要靠脑补**。
- **filesystem.write family 必须额外验证 5 个变体**（任务 3b-3f）：noop edit
  (`[edit applied: no-op]` 路径) / 同 path 多段顺序编辑串行化 / new-file / replace_all / 同 path 并发串行化。
  任一变体回归到 `[edit_apply_failed]` 误报或文件互相覆盖，记 hard failure。
- **sub-agent family 必须额外验证 2 个并发场景**（任务 8a.5 / 8a.6）：parallel dispatch
  时间戳间隔 < 200ms，sub-agent 结果回流报告含 `Sub-agent execution summary` +
  `Tool calls:` 三段式。任一退化记 hard failure。

### E. Context Management (Live Session Observable)

验证上下文管理子系统在 live session 中的**可观测行为**。
内部实现细节（budget 计算公式、projection 算法、cache edits 插入逻辑）不在 agent 自测范围内——
agent 是被管理的对象，无法自证内部投影正确性。

本节只验证 agent 能从自身视角确认的 5 项行为。每项有明确的 pass/fail 判定标准。

- `session_memory_preserved`：context compaction 发生后，agent 能从 session memory 准确回忆至少 3 个之前的操作结果（文件内容、删除状态、todo 状态），不需要重新读取文件。
  - pass：3/3 事实问题回答正确
  - pass_with_gaps：2/3 正确
  - failed：1/3 或更少
  - not_observed：session 太短未触发 compaction，memory probe 无意义

- `tool_continuity`：context compaction 发生后，agent 能继续正常调用工具（至少 read_file + edit_file_v2 + run_terminal_command 各一次成功）。
  - pass：compaction 后三种工具各至少成功一次
  - failed：compaction 后任一工具调用失败
  - not_observed：compaction 未触发

- `no_restart_regression`：context compaction 发生后，agent 不会重新从任务 1 开始，而是从中断点继续执行。
  - pass：compaction 后第一个 agent turn 引用了正确的后续任务编号
  - failed：agent 重新从任务 1 开始或重复已完成的任务
  - not_observed：compaction 未触发

- `attachment_integrity`：context boundary 后 agent 能引用 `[Context attachment: Session Memory]`、`[Context attachment: Todo State]`、`[Context attachment: Recent File Snapshots]` 中的具体内容。
  - pass：agent 能引用至少 2 个附件中的具体数据
  - failed：附件内容丢失或不可访问
  - not_observed：compaction 未触发

- `compaction_evidence`：Cursor IDE 注入的 context attachment 存在性证据。
  Bridge 本身*也*实现了 compaction，分三层：
  1. `ToolResultCompactionService` 的 microcompact（preflight / idle / reactive 三个 trigger）
     —— 清理旧 tool result
  2. `ContextCompactRunnerService` 的 LLM compact runner —— 调用后端 no-tools 接口
     真实生成 continuation summary（替代旧的启发式 `ContextSummaryService`）
  3. `CursorConnectStreamService` 的 advising synthesis —— budget 接近阈值时
     建议模型收尾
     这些是 bridge 内部的 token budget 管理，不会直接体现为 agent 可见的 context attachment。
     Cursor IDE 客户端在 session 级别执行 compaction 后，会以 `[Context attachment: Session Memory]`
     等形式注入到下一个 turn 的 user message 中。
     验证方式（二选一即可 pass）：
  4. 当前 turn 的 user message 中存在 `[Context attachment:` 前缀的内容块（IDE 级 compaction 证据）
  5. bridge log 中存在 `LLM compact runner`、`No-tools compact summary`、`advising synthesis`、
     `Auto compact limit`、`compaction.microcompact_`、`compaction.projection_budget_exceeded`
     中至少 2 个关键词（bridge 级 compaction 证据）
  - pass：上述任一条件满足
  - not_observed：session 太短，三层 compaction 均未触发
  - unavailable：无法确定（bridge log 不可访问且无 context attachment 注入）

**后端相关项预判规则**（不需要每次 grep 验证）：

- 当前后端为 Kiro 时：`native_context_management`、`native_cache_edits` 直接标 `unavailable: kiro backend does not emit`
- 当前后端为非 Codex 时：`codex_incremental_context` 直接标 `unavailable: non-codex backend`
- `hard_fit_and_reactive_recovery` 需要 prompt 真正超过硬窗口才能触发，正常 smoke session 标
  `not_observed: session too short to exceed hard window`
  （除非 bridge log 中出现 `[REACTIVE-COMPACT]`、`compaction.projection_budget_exceeded`
  或 `reactive.recovery` 关键词；旧的 `hard_fit` 关键词已被 `projection_budget_exceeded` 取代）

### F. ConversationAction / background 状态机

必须观察或判定：

- `userMessageAction`、`resumeAction`、`cancelAction`、`summarizeAction`、`shellCommandAction`、`startPlanAction`、`executePlanAction`
- `asyncAskQuestionCompletionAction`、`cancelSubagentAction`、`backgroundTaskCompletionAction`、`backgroundShellAction`、`backgroundSubagentAction`
- `triggeringAuthId`、`triggeringUserInfo.authId`、`triggeringUserInfo.userId`。

### G. Exec 通道与 control

必须观察或判定 ExecServerMessage：

- `shellArgs`、`writeArgs`、`deleteArgs`、`grepArgs`、`readArgs`、`lsArgs`、`diagnosticsArgs`、`requestContextArgs`
- `mcpArgs`、`shellStreamArgs`、`backgroundShellSpawnArgs`、`listMcpResourcesExecArgs`、`readMcpResourceExecArgs`、`fetchArgs`
- `recordScreenArgs`、`computerUseArgs`、`writeShellStdinArgs`、`executeHookArgs`、`subagentArgs`、`redactedReadArgs`
- `forceBackgroundShellArgs`、`forceBackgroundSubagentArgs`、`mcpStateExecArgs`、`subagentAwaitArgs`。

必须观察或判定 ExecClientMessage：

- `shellResult`、`writeResult`、`deleteResult`、`grepResult`、`readResult`、`lsResult`、`diagnosticsResult`、`requestContextResult`
- `mcpResult`、`shellStream`、`backgroundShellSpawnResult`、`listMcpResourcesExecResult`、`readMcpResourceExecResult`、`fetchResult`
- `recordScreenResult`、`computerUseResult`、`writeShellStdinResult`、`executeHookResult`、`subagentResult`、`redactedReadResult`
- `forceBackgroundShellResult`、`forceBackgroundSubagentResult`、`mcpStateExecResult`、`subagentAwaitResult`。

必须观察或判定 control：`ExecServerControlMessage.abort`、`ExecClientControlMessage.streamClose`、`ExecClientControlMessage.throw`、`ExecClientControlMessage.heartbeat`。

## 必执行任务

### 任务 1：基础终端与流式输出

调用客户端可见工具 `run_terminal_command` 执行一个安全命令，完成以下目标：
确认当前项目工作目录，展示 `<SMOKE>` 下的文件，并产生 3 行间隔很短的进度输出，方便观察流式 stdout。

验收：stdout 可见，exit code 为 0；trace 中应能看到 shell 相关 tool call 和 shell stream/输出增量。

### 任务 2：文件与代码检索

调用客户端可见工具完成以下目标：用 `list_directory` 检查 smoke 工作区里有哪些文件，
用 `read_file` 确认 `<SMOKE>/a.txt` 的内容；再用 `glob_search` 或 `file_search` 找出 Cursor 协议相关 TypeScript 文件，
并用 `grep_search` 定位 `ExecServerMessage` 在源码中的使用位置。

验收：能读到 `alpha`；源码文件搜索和文本搜索返回非空或合理结果；trace 中能看到对应 started/completed 或 exec/result 摘要。

### 任务 3：编辑与删除闭环（含 edit 工具完整覆盖）

`edit_file_v2` 的协议形态比 `read_file` 复杂得多：含 search/replace pair、范围限定、
multi-chunk、replace_all、新文件创建、同 path 串行化。本任务必须覆盖完整子集，
不能只跑一次"alpha → alpha-1"就交差。

#### 3a. 基础读 / 改 / 重读 / 删（最小闭环）

调用客户端可见工具完成以下目标：先用 `read_file` 读取 `<SMOKE>/a.txt`，
再用 `edit_file_v2` 把其中的 `alpha` 更新为 `alpha-1`，然后再次读取确认；
接着用 `delete_file` 删除 `<SMOKE>/delete_me.txt`，最后确认 smoke 目录中已经没有这个文件。

验收：编辑和删除都有可见副作用；read 后内容是 `alpha-1`；delete_me.txt 不再存在。

#### 3b. Noop 编辑（search 与 replace 完全相同）

调一次 `edit_file_v2` 让 search 与 replace **逐字符完全相同**（例如：
search=`alpha-1`、replace=`alpha-1`）。这是模型在重试 / 上游代理重发 tool_use 输入 /
模型只想"确认某段内容存在"时的常见形态，bridge 必须区分"幂等 noop"和"真正失败"。

验收（这是 #3 修复的核心场景）：

- 工具结果状态是 **`success`**，**不是** `error`；
- 工具结果文本以 `[edit applied: no-op]` 开头，**绝不能**出现
  `[edit_apply_failed]` 或 `target_content_matches_in_current_file:` 这类
  原 failure projection 字段；
- 文件内容、mtime 都不变（写盘步骤被跳过）；
- trace 中 `editToolCall.result` 命中 `success` 分支。

如果看到 `[edit_apply_failed]`，记 hard failure 并写明 noop guard 报告路径回归。

#### 3c. 多段编辑（同 path 顺序 edit 串行化）

`replacementChunks` 是后端→bridge 的内部传输格式（由 Antigravity 的
`replace_file_content` / `multi_replace_file_content` 工具产生），**不在 agent
surface schema 中暴露**。agent 实现"多段编辑"的正确方式是对同一文件发起多次
`edit_file_v2`，由 `acquireOrQueueEdit` 保证串行化。

先把 `b.txt` 内容预置成多行（例如 3 行：`line 1\nline 2\nline 3\n`），
然后**在同一个 agent turn 内**连续调两次 `edit_file_v2`：

- edit-1：`search="line 1"` → `replace="LINE-A"`
- edit-2：`search="line 3"` → `replace="LINE-C"`

验收：

- 两次 edit 都成功，最终 b.txt 内容是 `LINE-A\nline 2\nLINE-C\n`；
- 没有出现第二次 edit 基于旧内容导致 search 失败（说明串行化生效，第二次 edit 看到的是第一次 edit 后的内容）；
- trace 中有**两次** `editToolCall.success`，且两个 `writeResult` 严格串行（acquireOrQueueEdit 同 path 排队）。

完成后把 b.txt 还原成原始 `beta` 一行（或留作多段编辑状态，但要在报告里说明）。

> **注意**：如果需要验证 bridge 内部 `replacementChunks` 路径的正确性（后端发来多 chunk 时的处理），
> 应通过单元测试或集成测试直接调用 `applyEditInputToFileText` 并传入 `replacementChunks` 数组，
> 而不是通过 agent smoke 测试——agent surface 上没有这个参数入口。

#### 3d. 新文件创建（path 不存在 + `file_text`）

调一次 `edit_file_v2` 创建一个新文件 `<SMOKE>/created_by_test_<RUN_ID>.txt`
（文件名带本轮 RUN_ID 后缀，避免并行 session 互相 race；如果当前 shell 里已经
`export SMOKE_RUN_ID=...`，直接用 `$SMOKE_RUN_ID`），
**不**使用 search/replace，而是直接传
`file_text="created via edit_file_v2 smoke probe (run=<RUN_ID>)\n"`。

验收：

- 文件被新建，内容与 `file_text` 完全一致；
- 没有 `unsafe_overwrite` 拒绝（因为 beforeContent 为空）；
- trace 中 `read_result` 失败但 dispatcher 进入 new-file 路径并发 `writeArgs`。

完成后用 `delete_file` 把这个文件删掉，避免污染后续测试。

#### 3e. `replace_all` / `allow_multiple` 多匹配

把 `<SMOKE>/a.txt` 内容预置成 `alpha\nalpha\nalpha\n`（三个 alpha），
然后调一次 `edit_file_v2(search="alpha", replace="ALPHA", replace_all=true)`。

验收：

- 三处都被替换，文件内容变成 `ALPHA\nALPHA\nALPHA\n`；
- **不**报 `ambiguous_target` —— 那只在 `replace_all=false` 且匹配数 > 1 时才出现。

完成后把 a.txt 还原成 `alpha-1`（接续 3a 的状态）。

#### 3f. 同一文件并发 edit（acquireOrQueueEdit 串行化验证）

在**同一个**用户消息 / agent turn 内，让 agent 同时调用两次 `edit_file_v2`，
都对 `<SMOKE>/a.txt` 进行不同的 search/replace（例如：
edit-1 把 `alpha-1` 改成 `alpha-2`、edit-2 把 `alpha-2` 改成 `alpha-3`）。

验收（这是 sub-agent 并行 + edit 串行化的协同验证点）：

- **两个 toolCall 都成功**，最终 a.txt 内容是 `alpha-3`（说明顺序生效，没有第二个 edit 基于 `alpha-1` 反向覆盖）；
- trace 中两个 `editToolCall.toolCallStarted` 事件**几乎同时**出现（说明 dispatcher 并发派发了），
  但两个 `writeResult` **严格串行**（acquireOrQueueEdit 同 path 排队）；
- 没有 pending 泄漏 / 重复结算。

如果两次 edit 互相覆盖（最终内容是 `alpha-2` 或 `alpha-3` 之外的状态），记 hard failure。

#### 3g. 失败诊断回报（target 找不到时的结构化 hint）

故意调一次 `edit_file_v2(path="<SMOKE>/a.txt", search="THIS_TEXT_DEFINITELY_NOT_IN_FILE", replace="x")`。

验收：

- 工具结果文本以 `[edit_apply_failed]` 开头；
- 包含 `target_content_matches_in_current_file: 0` 与
  `diagnosis: TargetContent does not exist verbatim in the current file. Re-copy the exact current_text before retrying.`；
- 包含 `latest_snapshot_source` 行（说明 bridge 找到了之前 read_file 的快照）；
- 文件内容不变。

这是 noop guard **不应该**误吞的负样本。同样需要确保 noop 修复没有把"真正找不到"的 case 也误判成 success。

### 任务 4：任务状态与计划

`agent.v1` 协议里 `create_plan` 与 `update_todos` / `read_todos` 是两个独立子系统，
但在用户 surface 上经常被混用，必须分别覆盖各自完整 schema，不要只跑一对最小调用。

#### 4a. `update_todos` / `read_todos` —— Todo 子系统完整覆盖

`UpdateTodosArgs` 协议字段：

- `todos: TodoItem[]` —— 每个 TodoItem 有 `id`、`content`、`status`
  (`pending`/`in_progress`/`completed`/`cancelled`)、`created_at`、`updated_at`、
  **`dependencies: string[]`**（依赖的其它 todo id 列表）。
- `merge: bool` —— **关键 flag**：`false` 时整列覆盖（替换全部 todos），`true` 时按 id 增量合并（已有 id 更新、新 id 追加、未提及的保留）。

`ReadTodosArgs` 协议字段：

- `status_filter: TodoStatus[]` —— 只返回这些状态的 todo（空数组 = 全部）。
- `id_filter: string[]` —— 只返回这些 id 的 todo（空数组 = 全部）。

执行步骤：

1. **初始化（merge=false）**：用 `update_todos` 一次性写入完整列表。包含两类条目：
   - 协议覆盖项：`proto-smoke-todo-1`、`proto-smoke-todo-2` 两条固定 id；
   - 执行追踪项：为任务 5..11 各创建一条 todo，id 用 `task-5` ... `task-11`，初始 status 全部 `pending`。
   - 至少**一条 todo 设置非空 `dependencies`**（例如 `task-11` 依赖 `task-5..task-10`），覆盖该字段。
2. **read_todos 全量读回**：不传 filter，确认 9 条 todo 都在。
3. **read_todos with `status_filter=[pending]`**：覆盖 status_filter；返回的 todos 都应是 pending。
4. **read_todos with `id_filter=["proto-smoke-todo-1", "task-5"]`**：覆盖 id_filter；返回 2 条。
5. **增量合并写入（merge=true）**：用 `update_todos(merge=true, todos=[{id:"task-5", status:"in_progress"}])`
   把 `task-5` 改 `in_progress`，**只传一条**而不是整列。验收返回的 `UpdateTodosSuccess.was_merge=true`，
   且 read_todos 全量读回时其它 8 条 todo 仍然在。
6. **任务执行期间**：每完成一个任务（或确认 failed / unavailable），立即用 `update_todos(merge=true)`
   更新对应 `task-N` 的 status 与（必要时）content（写入失败原因）。

#### 4b. `create_plan` —— Plan 子系统完整覆盖

`CreatePlanArgs` 协议字段：

- `plan: string` —— plan 主体文本（Markdown），**不是简单的 title**。
- `todos: TodoItem[]` —— plan 关联的 flat todo 列表（与 `update_todos` 共用 schema，但作用域是 plan 内）。
- `overview: string` —— plan 概述。
- `name: string` —— plan 名称（IDE 用于侧栏 / `plan_uri` 命名）。
- `is_project: bool` —— 是否项目级 plan（影响 IDE 持久化范围）。
- `phases: Phase[]` —— **嵌套**：每个 Phase 有 `name` + 自己的 `todos[]`；用于把 plan 分成阶段。

`CreatePlanResult` 字段：

- `success` / `error` 二选一；
- 顶层 `plan_uri: string` —— IDE 持久化后的 plan 文件 URI（即使 success=空也会回这个）。

执行步骤：

1. 调一次 `create_plan`，**必须**填齐：
   - `name="Cursor Protocol Smoke Regression (run=<RUN_ID>)"` —— 必须把当前 `$SMOKE_RUN_ID`
     拼进 plan 名，避免并行 session 在 IDE plan 注册表里互相覆盖；
   - `overview` 至少一句话描述本轮任务范围；
   - `plan` 用 Markdown，体现任务 5..11 的实际范围；
   - `phases` 至少 2 个（例如 `Read-only checks` / `Write & integration`），每个 phase 各嵌至少 2 条 todo；
   - `todos` 顶层至少 7 条，与任务 5..11 一一对应，**不要把多个任务合并成一条**；
   - `is_project=false`（smoke 测试，不要污染项目级 plan 注册表）。
2. 验收：
   - 至少观察到一对 `createPlanRequestQuery` / `createPlanRequestResponse`；
   - response 里 `result.success` 命中 + `plan_uri` 非空；
   - `plan_uri` 指向的文件**不在仓库工作树内**（应该在 `~/.cursor/` 或 IDE 临时目录），
     且文件名 / 路径里能看到本轮 RUN_ID 痕迹（如 `~/.cursor/plans/...run=<RUN_ID>...`），
     如果完全不带 RUN_ID 就要在 gap 里写明"plan_uri 无 session 区分，并行下可能被其它 session 覆盖"。

注意：`create_plan` 协议层**没有**状态回写字段（只能 create 一次）。
状态机职责完全由 `update_todos(merge=true)` 承担。**禁止**反复调 `create_plan` 假装在更新。

#### 4c. 验收（汇总）

- `update_todos` 至少被调用 4 次：1 次初始化（merge=false）+ 1 次 merge=true 试探 + 至少 2 次任务进度回写；
- `read_todos` 至少被调用 3 次（无 filter / status_filter / id_filter 各一次）；
- `create_plan` 调一次，response 含非空 `plan_uri`；
- 最终 todo 列表准确反映任务 5..11 真实结果（含 hard failure），任务 11 输出 todo 终态摘要；
- trace 中能看到 `updateTodosToolCall`、`readTodosToolCall`、`createPlanToolCall` 三个 proto case；
- trace 中至少观察到一对 `createPlanRequestQuery` / `createPlanRequestResponse` interaction。

#### 4d. 可选 `StartPlanAction` / `ExecutePlanAction`（仅观察，不主动触发）

`StartPlanAction` 与 `ExecutePlanAction` 是 IDE 端从 plan 模式 kickoff agent 的状态机，
**不是 user-facing 工具**——agent 自己派发不到。如果 trace 中观察到（例如用户从 IDE plan 模式启动了本次会话），
在 Coverage Checklist Summary 里记录为 pass；否则记 `not_observed: not user-invokable from this surface`，
不算 gap。

### 任务 5：诊断、项目与规则类只读能力

调用客户端可见工具完成以下目标：用 `read_lints` 检查 smoke 文件或一个已知源码文件是否有 diagnostics；
用 `read_project` 了解当前项目基本元信息；用 `fetch_rules` 读取当前生效规则；
用 `search_symbols` 或 `go_to_definition` 定位一个明显的协议相关符号（例如 `CursorProtocolTraceService` 或 `ExecServerMessage`）。

验收：返回结构合法；无结果也可以，只要工具调用没有破坏状态。

### 任务 6：网络调研

调用客户端可见网络工具完成以下目标：用 `web_search` 搜索目前最新的 Cursor 定价与套餐信息，
再用 `web_fetch` 读取 Cursor 官方定价页或官方文档页，并给出一句话摘要和来源 URL。
只使用当前客户端实际暴露的网络工具；如果 `fetch` 或 `exa_search` 没有暴露，就不要声称调用它们。

验收：成功时记录标题/摘要/URL；失败时记录限流、网络或权限错误。网络失败不算 hard failure。
禁止使用 `example.com`、`example.org`、`example.net` 等保留示例域名；示例/保留域名结果不能作为有效网络证据。

### 任务 7：MCP 能力发现

调用客户端可见 MCP 相关工具完成以下目标：

1. 用 `get_mcp_tools` 列出当前会话挂载的 MCP server / tool 清单。
   只要返回至少 1 个 tool，就认为 **MCP 通道是通的**，不要笼统记 "no MCP available"。
2. 在拿到的真实 server 名单中挑一个最小 / 最安全的 tool 实际调一次（推荐 `user-context7-resolve-library-id` + `user-context7-query-docs`，这两个不需要任何账号、只读、有真实远程响应），
   验证 MCP 通道端到端可用，并把返回内容里的关键字段（如 `Context7-compatible library ID`、Source URL）写进证据栏。
3. 用 `list_mcp_resources(<具体 server 名>)` 探测 resource 列表。如果返回 `Server "..." not found`，
   说明该 server 未挂载，不是 MCP 通道坏；要在 gap 里写明"`<server>` 未配置"，并继续在已挂载的 server 上跑 `read_mcp_resource`（如果它真有 resource）。

验收：

- 如果 `get_mcp_tools` 至少返回 1 个 tool 且 step 2 成功，记 `pass` —— `mcp_tool` / `get_mcp_tools` / `list_mcp_resources` / `read_mcp_resource` 全部归 pass，gap 写明哪些 server 未挂载。
- 如果 `get_mcp_tools` 返回空，记 `unavailable: no MCP servers configured in this session`。
- 不允许仅凭 `list_mcp_resources(<某个 server>)` 报 not found 就判定整条 MCP 通道 unavailable；那只是单个 server 没挂。

### 任务 8：子代理 / 后台 / stdin 能力

子代理（`task`）和后台 shell + stdin 是两个独立子系统，分两段执行。

#### 任务 8a：子代理生命周期

只要客户端 surface 上有 `task` 工具就必须执行，**不能因为"概要任务"听上去随意就跳过**。

子代理覆盖清单（按"最小自洽"原则各跑一次，能合并就合并，不要为了凑覆盖反复 spawn）：

1. **Foreground sub-agent — 4 个内置类型**：`general-purpose` / `explore` / `browser` / `bash` 各派发**一个**最小调用。建议任务都很轻：
   - general-purpose：用 `grep_search` 在某个仓库内文件搜某个字面量，返回命中数；
   - explore：用 `read_file` 读某个仓库内文件的若干行；
   - browser：用 `web_fetch` 抓 Cursor 官方文档/定价页（**禁止 example.\* 域名**），返回 title；
   - bash：用 `run_terminal_command` 跑 `pwd && date`，原样贴回 stdout。
     验收 sub-agent 在父任务气泡内**渲染了 inner tool 调用**（IDE 气泡里能看到 nested tool name，**不是 `[Tool: truncatedToolCall]`**），sub-agent 拿到的 brief 是 `prompt` 字段而不是 UI label `description`。
2. **Background sub-agent**：`task(run_in_background=true, subagent_type=...)` 派发一个最小任务，立即拿到 `agentId`。
   - 用 `await_task` 真实阻塞等到完成，确认终态 `status=completed`、`turnCount/toolCallCount/durationMs` 都有数；
   - 检查 transcript / metadata / result 三件套落盘到 `~/.cursor/subagents/<agentId>/`，
     确认 `metadata.json` 里 `conversationSteps[]` 持续累积、proto oneof 渲染为具体 case
     （如 `grepToolCall`、`shellToolCall`），而不是 `truncatedToolCall`。
3. **Kill 路径**：再 spawn 一个**会跑很久**的 background sub-agent（多步真实工具调用，
   禁止靠"无意义循环"骗时间——sub-agent 系统级 prompt 会拒绝），等它进入 `running` 后调
   `kill_agent` / `wait_agent` 等可见 kill 工具。验收 worker 在 abort checkpoint 停下，
   `metadata.status="killed"`、`errorMessage="aborted by registry"`，**不是 `failed`**。
4. **Custom agent**（可选）：如果项目根 `.cursor/agents/*.md` 有自定义 agent 定义，至少派发一次确认 `SubagentRegistryService` 能挂上来；没有则记 `not_observed`。
5. **Parallel sub-agent dispatch**（**必须执行**——验证 dispatchPreparedToolBatch 的并发 fork）：
   在**同一个用户消息 / agent turn** 内，让 agent **一次性同时**派发 3 个 foreground sub-agent
   （建议 `general-purpose` + `explore` + `bash` 各一）。每个 sub-agent 任务都要够短
   （5-10 秒级，例如各跑一次 grep_search / read_file / `pwd && date`）但**互相之间无依赖**，
   这样真并行才能体现。

   验收（这是 #1 修复的核心场景）：
   - **三个 task tool 的 `taskToolCallStarted` 帧时间戳间隔 < 200ms**（说明并发 fork 而不是串行）；
   - 三个 sub-agent 的 transcript JSONL 写入时间窗口**重叠**（互相之间起点 / 终点交错）；
   - 三个 task tool 都正常 settle，没有任何一个被前面的 sub-agent 阻塞超过 1s；
   - parent BiDi stream 上**没有出现** `proxy restarted` / NAL stall 误报；
   - 没有 pending tool call 泄漏（结束时 session.pendingToolCalls 为空）；
   - 多个 sub-agent 的 ExecServerMessage（如果他们各自调 shell / read）**没有 execId 冲突**。

   如果发现三个 sub-agent 是按时间顺序"一个完成才下一个开始"，标记 hard failure ——
   说明 `dispatchPreparedToolBatch` 退化回 sequential `yield*` 了。

6. **Sub-agent 结果回流**（**必须执行**——验证 #2 修复）：
   挑上面任意一个 foreground sub-agent，让它在最终 final answer 里**只写一句"done"**，
   但执行过程中调过若干工具（例如先 grep_search 再 read_file 再 list_directory）。

   验收（这是 #2 修复的核心场景）：
   - 父 agent 收到的 `task` 工具结果**包含三段**：
     1. sub-agent 的 final answer 原文（"done"）；
     2. `Sub-agent execution summary:` 块，含 `turns`、`tool calls`、`duration` 行；
     3. `Tool calls:` 块，含每个 sub-agent 工具调用的一行摘要
        （形如 `1. grep — pattern=...` 或 `2. read — path=... → ok: ...`）。
   - 父 agent 的下一个 LLM turn 看到的 `tool_result` **不止是** `"done"`——
     它能在自己的 reasoning 里引用 sub-agent 实际查到的内容
     （例如能说出 grep_search 的命中数、read_file 看到的关键字）。
   - 如果只看到 `"done"` / `[sub-agent completed with no output]`，
     标记 hard failure —— 说明 `buildSubAgentFinalReport` 没有被调用，
     或者 conversationSteps 没积累。

验收要点（汇总）：

- parent task tool 不重复结算；没有 pending 泄漏；inner tool 调用 case 都正确渲染；
- transcript JSONL / metadata JSON 文件都在预期路径下，不污染仓库工作树；
- BigInt 字段（`conversationSteps[]` 内嵌的 ToolCall envelope）**不抛 `Do not know how to serialize a BigInt`**；
- Sub-agent 内 `run_terminal_command` 通过 bridge 进程内 `child_process.spawn` 直跑，
  **不是**通过 `ExecServerMessage{shellArgs}` 走 IDE（这是当前临时方案；trace 里相应 toolCall
  的 family 是 `shellToolCall` 但**没有对应 ExecServerMessage**——这是预期，不是 gap）。

如果 surface 上没有 `task` 工具，记 `unavailable: task tool not exposed in this client surface`，不要伪造调用。

#### 任务 8b：后台 shell + stdin

用 `background_shell_spawn` 或可见后台命令能力运行一个**长寿命**命令观察是否进入 background；
推荐 `read -r line; echo "got: $line"` 或 `sleep 60` 这种会**阻塞等待**的脚本，
确保后续 `write_shell_stdin` 探测到达时进程还活着。

只有当真实返回可用 shellId 时，才用 `write_shell_stdin` 向该 shell 写入 stdin；不要为了覆盖而伪造 shellId 或重复调用。
注意 `Shell not found` 通常意味着进程已自然退出（短命脚本 lifecycle 问题，**不是协议层 mapper 错**）；
如果命中这条错误，需要在 gap 里说明原因（"bg shell 已退出，stdin 没有目标"），并尝试用阻塞式命令重新跑一次。

验收：parent tool 不重复结算；没有 pending 泄漏；不可用时说明缺少 task/subagent/shellId。

### 任务 9：可选 IDE/外部集成能力

`ask_question` 协议复杂度（多种 result 形态、run_async 异步路径）跟其它 IDE 集成工具不是一个量级，
分两段执行。

#### 9a. `ask_question` —— 用户交互完整覆盖

`AskQuestionArgs` 协议字段：

- `title: string` —— 整个对话框标题；
- `questions: Question[]` —— 可以**一次问多个问题**，每个 Question 有：
  - `id` —— 用于答案回写时关联；
  - `prompt` —— 问题文本；
  - `options: Option[]` —— 预设选项列表，每个 Option 有 `id` + `label`；
  - `allow_multiple: bool` —— 是否允许多选；
- `run_async: bool` —— **关键 flag**：true 时 IDE 立即回 `AskQuestionResult.async`，agent turn 结束；
  用户后续回答通过 `AsyncAskQuestionCompletionAction` 异步回送，不在原 tool call 同步 result 里；
- `async_original_tool_call_id: string` —— 异步路径的关联 id。

`AskQuestionResult` 4 态 oneof：

- `success: AskQuestionSuccess` —— 包含 `Answer[]`，每个 Answer 有 `question_id` + `selected_option_ids[]` + `freeform_text`；
- `error: AskQuestionError` —— 协议错（不要把用户拒答记成 error）；
- `rejected: AskQuestionRejected` —— **用户主动拒答**（关闭对话框 / 跳过），有 `reason` 字段；
- `async: AskQuestionAsync` —— `run_async=true` 时 IDE 占位返回，等 `asyncAskQuestionCompletionAction`。

执行步骤（按可见 surface 的 ask 工具实参格式调整 — 协议形状不变）：

1. **同步单选 + 预设选项**：调一次 `ask_question`，1 个 question，3 个 option，`allow_multiple=false`，`run_async=false`。
   验收 `AskQuestionResult.success`，answers[0].selected_option_ids 长度 = 1。
2. **同步多选 + 自由文本**：再调一次，`allow_multiple=true`，引导用户多选并填 freeform_text。
   验收 `selected_option_ids.length >= 2` 且 `freeform_text` 非空。
3. **多 question 一次性问**：再调一次，questions 至少 2 个，覆盖 IDE 同时渲染多个问题的能力。
   验收 answers 数组长度等于 questions 数量。
4. **`run_async=true` 异步路径**（如果 surface 暴露这个 flag）：调一次 `run_async=true`，
   验收：
   - 原 tool call 同步 result 是 `AskQuestionResult.async`（**不是 success**），agent turn 立即结束；
   - trace 中后续观察到一个 `ConversationAction.asyncAskQuestionCompletionAction`，里面带 `original_tool_call_id`、`original_args`、`result`；
   - `result` 命中 `success` / `rejected` 之一，**不是再嵌套 async**。
5. **`rejected` 路径**（可选，依赖用户配合）：调一次后由用户**主动关闭/跳过对话框**。
   验收 result 是 `rejected`，且 `reason` 非空。

如果 surface 上 `ask_question` 不暴露 `run_async` / 多 question / freeform_text 等高级字段，
分别记 `not_directly_invokable: <字段名>` 并继续测试其它字段；不要硬凑参数让 surface 校验报错。

#### 9b. 其它 IDE / 外部集成能力

根据当前客户端可见工具面做最小安全调用或判定：如果暴露了 `switch_mode`、`apply_agent_diff`、`generate_image`、
`record_screen`、`computer_use`、`fetch_pull_request`、`report_bugfix_results`、`ai_attribution`、`setup_vm_environment`、`mcp_auth` 等工具，
则各尝试一次最小安全用例；写入类能力只能作用于 `<SMOKE>` 或安全占位。
不要为了覆盖而硬造 PR、图片、VM、shellId 或外部状态；未暴露的工具记为 `not_directly_invokable`。

调用约定（避免误把业务校验记成协议错）：

- `fix_lints`：必须传 repo 工作区根下的真实 ts 文件
  （例如 `apps/protocol-bridge/src/protocol/cursor/cursor-protocol-trace.service.ts`），
  不要传 `<SMOKE>` 下的文件，否则会被 IDE 校验拒绝
  （`path is outside workspace root`），那是输入约束不是协议错。
- `report_bugfix_results`：必须传至少 1 项 dummy result
  （例如 `[{ "id": "smoke-probe", "status": "nop" }]`），传空数组会被入参校验拒绝。
- `setup_vm_environment`：mapper 仍保留
  `CLIENT_SIDE_TOOL_V2_SETUP_VM_ENVIRONMENT` 的 backward-compat 定义，但
  **默认 agent surface 与 executableViaExecServerMessage set 都主动 omit 它**
  （proxy runtime 没有 VM broker，调用必失败）。如果客户端 surface 上看不到它，
  记 `not_directly_invokable: VM broker not implemented`；
  如果意外能调到，按实际后端响应记录。
- `wait_agent`：mapper 把 `wait_agent` 作为 `await_task` 的输入侧别名解析；
  客户端 surface 上看到的是 `await_task`。在覆盖清单里 `wait_agent` 这一行应记
  `not_directly_invokable: alias for await_task on this surface`，
  并在 gap 列写明等价 user-facing 工具是 `await_task`。
- `kill_agent`：proto 层**没有**独立的 `killAgentToolCall` oneof case；
  它是 bridge 自己定义的 inline tool，路由到
  `ConversationAction.cancelSubagentAction`。如果客户端 surface 暴露了它，
  可以正常调用；trace 里观察到的是 `cancelSubagentAction`，不是新的
  ToolCall case。

验收：每项记录 `pass / unavailable / not_directly_invokable / failed` 与原因。

### 任务 10：上下文管理 / 压缩 / 续接回归

本任务验证上下文管理子系统的**可观测行为**。agent 是被管理的对象，无法自证内部投影正确性，
因此只验证从 agent 视角能确认的外部效果。不修改业务源码、不把内部 service 名称当
user-facing 工具调用。

#### 10a. Session memory probe（compaction 后记忆验证）

在不重新读取文件的前提下，回答以下 3 个事实问题：

1. `<SMOKE>/a.txt` 的当前内容是什么？
2. `<SMOKE>/delete_me.txt` 是否已删除？
3. 任务 8 中任一 sub-agent 返回了什么关键信息？

判定标准：

- 3/3 正确 → `session_memory_preserved: pass`
- 2/3 正确 → `session_memory_preserved: pass_with_gaps`
- 1/3 或更少 → `session_memory_preserved: failed`

如果 context compaction 尚未发生（session 太短），允许重新读取文件验证，
但必须标注 `session_memory_preserved: not_observed (compaction not triggered)`。

#### 10b. Tool continuity（compaction 后工具连续性）

如果 context compaction 已发生，确认 compaction 后至少成功调用过：

- `read_file`（任一文件）
- `edit_file_v2`（任一编辑）
- `run_terminal_command`（任一命令）

判定方法：回顾 compaction boundary 之后的 tool call 历史。

- 三种工具各至少成功一次 → `tool_continuity: pass`
- 任一工具在 compaction 后未被调用 → `tool_continuity: not_observed`
- 任一工具在 compaction 后调用失败 → `tool_continuity: failed`

如果 compaction 未触发，标 `tool_continuity: not_observed (no compaction)`。

#### 10c. No-restart regression（无重启回归）

判定方法：观察 compaction boundary 之后 agent 的第一个动作。

- 继续执行后续任务（引用正确任务编号） → `no_restart_regression: pass`
- 重新从任务 1 开始或重复已完成任务 → `no_restart_regression: failed`
- compaction 未触发 → `no_restart_regression: not_observed`

#### 10d. Compaction evidence（bridge log + context attachment 检查）

Bridge 实现了三层 compaction 机制：

1. **Microcompact**（`ToolResultCompactionService`）：每次 API 调用前 / 空闲触发 /
   预算紧张反应式触发，清除旧 tool result，保留最近 N 个
   （telemetry: `compaction.microcompact_preflight` / `compaction.microcompact_idle` /
   `compaction.microcompact_reactive`）
2. **LLM compact runner**（`ContextCompactRunnerService`）：调用路由后端 no-tools 接口
   真实生成 continuation summary，写入 transcript-native 的 boundary / summary 事件；
   旧的启发式 `ContextSummaryService` 已删除（log: `LLM compact runner applied commit=...`、
   `No-tools compact summary generated`）
3. **Advising synthesis**（`CursorConnectStreamService`）：当 prompt budget 接近阈值时，
   向模型发出收尾建议（log: `Top-level agent turn advising synthesis ...`）

预算无法塞下时不再静默 hard-fit 截断，而是抛 `ContextProjectionBudgetExceededError`
并发 `compaction.projection_budget_exceeded` telemetry，由上层走 `[REACTIVE-COMPACT]`
路径退避重试。此外，Cursor IDE 客户端在 session 级别也会执行 compaction，
以 `[Context attachment: ...]` 形式注入。

用 `run_terminal_command` 对 bridge log 执行只读 grep，检查以下关键词。

`$BRIDGE_LOG` 的 source-of-truth 是 `apps/vscode-extension/src/services/bridge-manager.ts`
里的 `path.join(os.tmpdir(), "agent-vibes-bridge.log")`，对应平台路径如下（与
`README.md` "Logs" 章节一致）：

- macOS：`$TMPDIR/agent-vibes-bridge.log`，实际形如
  `/var/folders/<xx>/<yy>/T/agent-vibes-bridge.log`（注意 `/private` 软链同效）
- Linux：`/tmp/agent-vibes-bridge.log`
- Windows：`%TEMP%\agent-vibes-bridge.log`

**禁止**直接把 `~/.agent-vibes/logs/agent-vibes-bridge.log` 当作 bridge log 来 grep
——那个目录历史上确实存在过，但当前 bridge 进程不再写入，里面残留的文件 mtime 通常停在
旧版本上线日，会让任意 compaction 关键词都假返回 0，是上一轮 smoke 误判
`compaction_evidence: not_observed` 的根因。

agent 在 smoke 内必须用以下 snippet **从 `os.tmpdir()` 解析** `$BRIDGE_LOG`，
不要硬编码绝对路径。**并行场景注意**：bridge log 是 bridge 进程级共享文件
（参考 [会话隔离] 资源矩阵），多 session 写同一文件，整文件 grep 会把其它 session
的关键词也算进来。要把统计窗口收紧到本轮 session：

```bash
BRIDGE_LOG="${BRIDGE_LOG:-$(node -e 'process.stdout.write(require("os").tmpdir())')/agent-vibes-bridge.log}"
echo "BRIDGE_LOG=$BRIDGE_LOG  RUN_ID=$SMOKE_RUN_ID"
ls -la "$BRIDGE_LOG"   # 必须看到本轮 session 内的 mtime；停在旧日期视为路径错

# 只看 baseline capture 之后的尾部增量（按字节偏移截取，不依赖时间戳格式）。
# baseline 文件由 capture-trace-baseline.js 写入，里面有当时的 bridge log size。
BASELINE_FILE="$AGENT_VIBES_SMOKE_DIR/.trace-baseline.json"
if [ -f "$BASELINE_FILE" ] && command -v node >/dev/null 2>&1; then
  BRIDGE_OFFSET=$(node -e '
    const fs = require("node:fs");
    try {
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(String(j.bridge_log_size_bytes ?? 0));
    } catch { process.stdout.write("0"); }
  ' "$BASELINE_FILE")
else
  BRIDGE_OFFSET=0
fi

# 只 grep baseline 之后追加的字节；如果 baseline 里没有 bridge_log_size_bytes 字段
# (旧版脚本)，回退到整文件 grep 并在报告里标注"未按 RUN_ID 收窄"。
if [ "$BRIDGE_OFFSET" -gt 0 ]; then
  tail -c +$((BRIDGE_OFFSET + 1)) "$BRIDGE_LOG" | grep -c "LLM compact runner\|No-tools compact summary\|advising synthesis\|Auto compact limit\|compaction.microcompact_\|compaction.projection_budget_exceeded\|\[REACTIVE-COMPACT\]"
else
  grep -c "LLM compact runner\|No-tools compact summary\|advising synthesis\|Auto compact limit\|compaction.microcompact_\|compaction.projection_budget_exceeded\|\[REACTIVE-COMPACT\]" "$BRIDGE_LOG"
fi
```

如果 `capture-trace-baseline.js` 当前版本没有把 `bridge_log_size_bytes` 写进 baseline
状态，agent 可以 fallback 到 `grep -c ... "$BRIDGE_LOG"` 整文件统计，但要在
Coverage Checklist 的 `compaction_evidence` gap 列里写一句 "bridge log 整文件统计，
并行下可能含其它 session 关键词"。这种情况下"至少 2 个关键词"判定仍然有效，
只是不能保证全部都来自本轮 session。

判定标准（二选一即可 pass）：

- 截断后 bridge log 中至少 2 个关键词出现 → `compaction_evidence: pass`
- 当前 turn 中存在 `[Context attachment:` 块 → `compaction_evidence: pass`
- 两者都不满足 → `compaction_evidence: not_observed`
- bridge log 不可访问且无 context attachment → `compaction_evidence: unavailable`

同时记录后端相关项的预判（不需要 grep 验证，直接按后端类型判定）：

- Kiro 后端 → `native_context_management: unavailable`, `native_cache_edits: unavailable`
- 非 Codex 后端 → `codex_incremental_context: unavailable`
- 未超过硬窗口 → `hard_fit_and_reactive_recovery: not_observed`（除非 log 中出现
  `[REACTIVE-COMPACT]`、`compaction.projection_budget_exceeded` 或 `reactive.recovery`；
  旧的 `hard_fit` 关键词已被 `projection_budget_exceeded` 取代）

#### 10e. Todo 回写

任务 10 完成后用 `update_todos(merge=true)` 更新 `task-10`：

- 10a-10d 全部 pass 或 not_observed（无 failed）：status=`completed`
- 任一 hard failure：status=`cancelled`，content 以 `failed:` 开头并写明失败点
- 禁止把 `task-10` 留在 `pending` / `in_progress`

### 任务 11：收集证据并输出报告

最后读取 trace 新增范围或桥日志摘要，输出最终 Markdown 报告。报告不要超过必要长度，不要输出全量协议矩阵。

输出 final 前先用 `update_todos(merge=true)` 更新 `task-11`：trace delta 和报告材料都完成后设
status=`completed`；如果 trace delta 读取失败或报告证据不完整，设 status=`cancelled` 并写明原因。

## 最终报告格式

只输出 Markdown，包含以下章节。

### Overall Summary

- `smoke_run_id`: 本轮 `$SMOKE_RUN_ID`（来自会话隔离章节生成的 8 字符 hex；
  并行场景下多份报告堆在一起时靠这个区分谁是谁。如果当时没 export，写 `unset`
  并在 notes 里说明）
- `smoke_dir`: 实际生效的 `$AGENT_VIBES_SMOKE_DIR` 绝对路径
- `session_result`: `pass | pass_with_gaps | failed`
- `hard_failures`: 数字
- `tasks_attempted`: 数字
- `tasks_passed`: 数字
- `notes`: 一句话总结

### Task Results

用 Markdown 列表或表格概述 11 个任务（任务 8 拆为 8a / 8b 共 12 行）。每项至少包含：

- 任务编号和任务名称
- 状态：`pass | pass_with_gaps | failed | unavailable | not_directly_invokable`
- 任务意图
- 期望使用的客户端可见工具
- 实际触发的客户端工具
- 短证据
- gap；没有则写 `none`

任务 4 的 todo 终态摘要必须随 Task Results 一起给出（每条 todo 的 id + 最终 status，
覆盖 `proto-smoke-todo-1/2` 与 `task-5` ... `task-11`）。如有 hard failure，
对应 todo status 必须是 `cancelled`，content 以 `failed:` 开头；禁止保留为 `pending` / `in_progress`。

### Tool Call Log

用 Markdown 列表或表格按实际调用顺序列出本轮真实发起过的工具调用。**不要补写未真实调用的工具**——那些项目在 Coverage Checklist Summary 里以 `not_observed` / `unavailable` / `not_directly_invokable` 体现即可。每项至少包含：

- 工具名
- 状态：`pass | failed`（实际调过的工具只可能这两态）
- 可见结果摘要
- trace 关联信息：`callId`、`id`、`execId` 或 `not_observed`

### Visible Side Effects

用 Markdown 列表或表格只列 `<SMOKE>` 下文件。每项至少包含：

- 路径
- 动作：`created | modified | deleted | read`
- 短证据

### Trace Summary

- `trace_path`: 实际读取路径或 `not_found`
- `baseline`: 起始行数/mtime
- `new_records`: 数字或 `unknown`
- `observed_cases`: 简短列出关键 `topCase/nestedCase`
- `correlation`: `pass|partial|failed|not_observed`
- `trace_findings`: 异常摘要；没有则写 `none`

### Coverage Checklist Summary

按完整覆盖清单 A-G 分组列出所有项目状态。覆盖状态必须来自真实调用客户端可见工具后的 trace、可见副作用或明确不可用原因；禁止为了让某项变成 pass 而事后硬调用 proto oneof、Exec/Interaction case、mapper 内部别名或未暴露工具名。

判定状态使用 5 态：

- `pass` —— 真实触发并在 trace / 副作用中观察到
- `failed` —— 真实触发但返回错误或行为不符预期
- `unavailable` —— 客户端 surface 未暴露、外部依赖（MCP/PR/VM/网络）缺失或环境受限
- `not_directly_invokable` —— 协议级 case，没有对应 user-facing 工具入口（如 `truncatedToolCall` size-guard）
- `not_observed` —— 工具存在且 surface 暴露，但本轮任务没派发到（必须在 gap 列说明原因）

为了避免 60 行散点列表，每个分组用**单张表格**组织，表头固定为：`项目 | 状态 | 证据 | gap`。
不允许用一行 "all pass" 蒙混过关——分组内若存在非 pass 项，必须逐项列出。

要求：

- A (AgentClientMessage / AgentServerMessage)：14 个 case 全列出。
- B (InteractionUpdate)：21 个 case 全列出。
- C (InteractionQuery / Response)：10 对全列出。
- D (工具家族总表)：14 个 family 全列出，每行附 `proto cases pass / 总数`、`user-facing tools pass / 总数`、聚合状态；gap 列必须写明本 family 内未 pass 的具体项目。**禁止**用单行 "all pass" 蒙混过关。
- E (Context Management)：5 个可观测行为项 + 后端相关预判项全列出。
- F (ConversationAction)：13 个 case 全列出。
- G (ExecServerMessage 24 项 / ExecClientMessage 24 项 / Exec control 4 项)：分 3 张表全列出。

任何 user-facing 工具与 proto case 之间的具体映射，由 trace 的 `topCase/nestedCase` 事实决定，**不要靠脑补**；不确定的项标 `not_observed`，并在 gap 列写为何没观察到（如"工具未暴露"、"任务未派发"）。

### Gaps / Unavailable

列出不可用工具族和原因，例如 MCP 未配置、PR 环境缺失、image/VM/tool surface 不存在、无 shellId 等。

### Invalid Evidence / Mis-invocation

列出被排除的证据，例如：

- 使用了 `example.com` 等保留示例域名；
- 口头声称测试 `fetch` / `exa_search`，但实际调用的是 `web_fetch` / `web_search`；
- 为了覆盖工具而重复重试，导致 proxy abort/restarted；
- 调用了 proto oneof、Exec/Interaction case、mapper 内部别名或当前客户端未暴露的工具名。

这些项目不能计为 pass，只能作为执行缺陷或无效证据记录。

### Failures

只列真正失败：工具返回错误、可见副作用不符合预期、trace 发现 pending 泄漏/重复结算/提前结束等。没有则写 `none`。

### Safety Check

- `<SMOKE>` 之外是否改动：`Yes/No`
- 是否执行受禁命令：`Yes/No`
- 是否提交 commit：`Yes/No`
- 是否修改业务源码：`Yes/No`
- 是否访问敏感凭据：`Yes/No`

---

如果你理解，立即开始执行任务 1，不要先解释方案。
