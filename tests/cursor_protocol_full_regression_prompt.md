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
6. 执行方式是任务驱动，但覆盖清单不能缩水；所有当前 Cursor 协议 ToolCall / Interaction / Exec / ConversationAction / InteractionUpdate / aiserver 兼容项都必须通过 trace 观察或明确判定 gap。
7. 不输出 Layer 1-8 全量矩阵；但最终报告必须按下方完整覆盖清单逐项给出状态，不能遗漏工具、功能或状态机分支。
8. 最终报告重点是：任务目标、期望客户端工具、实际触发工具、结果、证据、gap；覆盖清单用紧凑分组摘要表达。
9. 写操作只允许发生在 smoke 工作目录下（默认 `~/.agent-vibes/smoke/`，可通过环境变量 `$AGENT_VIBES_SMOKE_DIR` 覆盖）。
   **禁止**把 smoke 文件、trace 文件或其他临时产物写到仓库工作树内，包括 `.cursor-protocol-smoke/`、`apps/**/.log/`、`.log/`、`tmp/` 等子路径。
10. 禁止执行：`git reset --hard`、`git checkout --`、`git clean`、`rm -rf`、`sudo`、安装依赖、提交 commit、修改业务源码、访问敏感凭据。
11. 网络、MCP、子代理、PR、图像、VM 等外部能力可以失败；失败必须记录原因，不要因此中断整轮。
12. 如果某个工具需要用户授权或 IDE 内部状态，按实际结果记录，不要伪造成功。
13. 禁止使用 `example.com`、`example.org`、`example.net` 等保留示例域名作为网络能力证据；网络任务必须面向真实官方站点。

## Trace 记录要求

开始前尝试定位 protocol trace 文件并记录基线行数或 mtime。优先路径：

1. `$CURSOR_PROTOCOL_TRACE_FILE`
2. `$AGENT_VIBES_LOG_DIR/cursor_protocol_trace.jsonl`
3. `~/.agent-vibes/logs/cursor_protocol_trace.jsonl`（默认 fallback；agent-vibes bridge 写入位置）

trace 文件不允许出现在仓库工作树内。如果在 `apps/**/.log/`、`.log/`、`<repo>/cursor_protocol_trace*` 等位置看到 trace 文件，视为污染，需要记录并删除，不能用作基线。

最终报告只需要给出本轮新增 trace 的摘要：

- trace 文件路径
- 新增记录数量或时间范围
- 观察到的关键 `topCase/nestedCase`
- 关键 `callId/id/execId` 对齐是否大体正常
- 是否看到明显 error、abort、pending 泄漏、重复结算或提前结束

不要输出完整 decoded frame 列表，除非发现异常。

## Smoke 工作区

所有文件任务都使用 smoke 工作目录（默认 `~/.agent-vibes/smoke/`，下文用 `<SMOKE>` 占位；如设置了 `$AGENT_VIBES_SMOKE_DIR` 则用其值）。**禁止在仓库内创建 `.cursor-protocol-smoke/` 或其他 smoke 目录**。开始时创建或重置以下文件；不得删除该目录之外任何内容：

- `<SMOKE>/a.txt`：内容 `alpha`
- `<SMOKE>/b.txt`：内容 `beta`
- `<SMOKE>/delete_me.txt`：内容 `delete`
- `<SMOKE>/todo-seed.md`：至少两行文本
- `<SMOKE>/subdir/nested.txt`：内容 `nested alpha beta`
- `<SMOKE>/env.txt`：内容 `PLACEHOLDER_ENV=old`

## 完整覆盖清单（不得删减）

执行任务时必须覆盖或判定以下清单。状态只能是 `pass | failed | unavailable | not_directly_invokable`。如果某项没有被真实触发，必须写清楚原因，不能因为任务分组里没有单独步骤就遗漏。

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

### D. ToolCall.tool（当前 45 项）

必须逐项触发或判定：

- `shellToolCall`、`deleteToolCall`、`globToolCall`、`grepToolCall`、`readToolCall`、`updateTodosToolCall`、`readTodosToolCall`、`editToolCall`
- `lsToolCall`、`readLintsToolCall`、`mcpToolCall`、`semSearchToolCall`、`createPlanToolCall`、`webSearchToolCall`、`taskToolCall`
- `listMcpResourcesToolCall`、`readMcpResourceToolCall`、`applyAgentDiffToolCall`、`askQuestionToolCall`、`fetchToolCall`、`switchModeToolCall`
- `generateImageToolCall`、`recordScreenToolCall`、`computerUseToolCall`、`writeShellStdinToolCall`、`reflectToolCall`、`setupVmEnvironmentToolCall`
- `truncatedToolCall`、`startGrindExecutionToolCall`、`startGrindPlanningToolCall`、`webFetchToolCall`、`reportBugfixResultsToolCall`
- `aiAttributionToolCall`、`prManagementToolCall`、`mcpAuthToolCall`、`awaitToolCall`、`blameByFilePathToolCall`、`getMcpToolsToolCall`
- `reportBugToolCall`、`setActiveBranchToolCall`、`communicateUpdateToolCall`、`sendFinalSummaryToolCall`、`updatePrCodeTourToolCall`
- `replaceEnvToolCall`、`editPrLabelsToolCall`。

### E. Mapper 暴露的 user-facing 工具名

除了 proto case，还要尽量覆盖或判定当前 mapper 暴露的工具名：

- `read_file`、`list_directory`、`edit_file`、`edit_file_v2`、`file_search`、`glob_search`、`grep_search`、`semantic_search`
- `deep_search`、`read_semsearch_files`、`run_terminal_command`、`delete_file`、`web_search`、`web_fetch`、`fetch`、`create_plan`
- `task`、`read_todos`、`update_todos`、`reapply`、`fetch_rules`、`search_symbols`、`go_to_definition`、`background_composer_followup`
- `knowledge_base`、`fetch_pull_request`、`create_diagram`、`fix_lints`、`await_task`、`read_project`、`update_project`、`mcp_tool`
- `read_lints`、`ask_question`、`switch_mode`、`list_mcp_resources`、`read_mcp_resource`、`get_mcp_tools`、`exa_search`、`exa_fetch`
- `setup_vm_environment`、`apply_agent_diff`、`generate_image`、`report_bugfix_results`、`background_shell_spawn`、`write_shell_stdin`
- `record_screen`、`reflect`、`ai_attribution`、`await`、`mcp_auth`、`start_grind_execution`、`start_grind_planning`、`computer_use`
- `request_user_input`、`apply_patch`、`view_image`、`spawn_agent`、`send_input`、`resume_agent`、`wait_agent`、`close_agent`。

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

### H. aiserver.v1 兼容 RPC

必须观察或判定：`AiService/PrivacyCheck`、`AiService/CheckUsageBasedPrice`、`AiService/FindBugs`、`AiService/GetCloudSetupBlockers`、`AiService/ReportAgentFeedback`、`AiService/TranscribeAudio`、`AiService/StreamInterfaceAgentStatus`、`AiService/TestBidi`。

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

### 任务 3：编辑与删除闭环

调用客户端可见工具完成以下目标：先用 `read_file` 读取 `<SMOKE>/a.txt`，
再用 `edit_file_v2` 把其中的 `alpha` 更新为 `alpha-1`，然后再次读取确认；
接着用 `delete_file` 删除 `<SMOKE>/delete_me.txt`，最后确认 smoke 目录中已经没有这个文件。

验收：编辑和删除都有可见副作用；如果编辑失败，记录失败原因。

### 任务 4：任务状态与计划

调用客户端可见工具完成以下目标：

1. 用 `update_todos` 初始化一个 todo 列表，包含两类条目：
   - 协议覆盖项：保留 `proto-smoke-todo-1`、`proto-smoke-todo-2` 两条固定 id（用于覆盖 `update_todos` / `read_todos` / `updateTodosToolCall` / `readTodosToolCall`），状态可任意；
   - 执行追踪项：为剩余任务 5..10 各创建一条独立 todo（建议 id `task-5` ... `task-10`，content 写明任务名），初始 status 全部 `pending`。
2. 用 `read_todos` 读回完整列表，确认两类条目都在。
3. 用 `create_plan` 创建一份计划，标题包含 `Cursor Protocol Smoke Regression`，
   `steps` 至少 6 条，与任务 5..10 一一对应，**不要把多个任务合并成一条**；
   `create_plan` 协议层不支持后续状态回写，这里只承担"全景概要 + 协议闭环"职责。
4. 之后每完成一个任务（或确认失败、不可用），立即用 `update_todos` 把对应 `task-N`
   的 status 改为 `completed` / `failed` / `cancelled`，必要时更新 `content` 写入失败原因。
5. 任务 10 输出最终报告时，附上 todo 终态摘要（每条 id + 终态）。

验收：

- `create_plan` 调用成功，至少观察到一对 `createPlanRequestQuery` / `createPlanRequestResponse`；
- `update_todos` 至少被调用 2 次（初始化 + 至少 1 次状态回写）；不允许只写一次后再不更新；
- 最终 todo 列表能准确反映任务 5..10 的真实结果，包含 hard failure；
- 计划创建后必须继续执行后续任务，不能提前结束。

注意：`create_plan` 在 `agent.v1` 协议中只有 `CreatePlanArgs`（title + steps）和
`CreatePlanResult`（success/error 二选一），**没有任何状态回写字段**。
不要试图通过反复调用 `create_plan` 来"更新"计划状态；状态机职责完全由 `update_todos` 承担。

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

调用客户端可见工具完成以下目标：如果暴露了 `task` 或子代理工具，就委托一个最小子任务概括 `<SMOKE>` 当前状态，
并在返回 task id 时用 `await_task` 或 `await` 等当前可见等待工具等待完成；
再用 `background_shell_spawn` 或可见后台命令能力运行一个**长寿命**命令观察是否进入 background；
推荐用 `read -r line; echo "got: $line"` 或 `sleep 60` 这种会**阻塞等待**的脚本，
确保后续 `write_shell_stdin` 探测到达时进程还活着。

只有当真实返回可用 shellId 时，才用 `write_shell_stdin` 向该 shell 写入 stdin；不要为了覆盖而伪造 shellId 或重复调用。
注意 `Shell not found` 通常意味着进程已自然退出（短命脚本 lifecycle 问题，**不是协议层 mapper 错**）；
如果命中这条错误，需要在 gap 里说明原因（"bg shell 已退出，stdin 没有目标"），并尝试用阻塞式命令重新跑一次。

验收：parent tool 不重复结算；没有 pending 泄漏；不可用时说明缺少 task/subagent/shellId。

### 任务 9：可选 IDE/外部集成能力

根据当前客户端可见工具面做最小安全调用或判定：如果暴露了 `ask_question`、`switch_mode`、`apply_agent_diff`、`generate_image`、
`record_screen`、`computer_use`、`fetch_pull_request`、`report_bugfix_results`、`ai_attribution`、`setup_vm_environment`、`mcp_auth` 等工具，
则各尝试一次最小安全用例；写入类能力只能作用于 `<SMOKE>` 或安全占位。
不要为了覆盖而硬造 PR、图片、VM、shellId 或外部状态；未暴露的工具记为 `not_directly_invokable`。

调用约定（避免误把业务校验记成协议错）：

- `fix_lints`：必须传 repo 工作区根下的真实 ts 文件（例如 `apps/protocol-bridge/src/protocol/cursor/cursor-protocol-trace.service.ts`），不要传 `<SMOKE>` 下的文件，否则会被 IDE 校验拒绝（`path is outside workspace root`），那是输入约束不是协议错。
- `report_bugfix_results`：必须传至少 1 项 dummy result（例如 `[{ "id": "smoke-probe", "status": "nop" }]`），传空数组会被入参校验拒绝。
- `setup_vm_environment`：当前桥已经从 user-facing surface 移除该工具（mapper 不再暴露）。如果客户端 surface 上看不到它，记 `not_directly_invokable`，**不要硬调**；如果意外能调到，按实际后端响应记录。

验收：每项记录 `pass/unavailable/not_directly_invokable/failed` 与原因。

### 任务 10：收集证据并输出报告

最后读取 trace 新增范围或桥日志摘要，输出最终 Markdown 报告。报告不要超过必要长度，不要输出全量协议矩阵。

## 最终报告格式

只输出 Markdown，包含以下章节。

### Overall Summary

- `session_result`: `pass | pass_with_gaps | failed`
- `hard_failures`: 数字
- `tasks_attempted`: 数字
- `tasks_passed`: 数字
- `notes`: 一句话总结

### Task Results

用 Markdown 列表或表格概述 10 个任务。每项至少包含：

- 任务编号和任务名称
- 状态：`pass | failed | unavailable | not_directly_invokable`
- 任务意图
- 期望使用的客户端可见工具
- 实际触发的客户端工具
- 短证据
- gap；没有则写 `none`

任务 4 的 todo 终态摘要必须随 Task Results 一起给出（每条 todo 的 id + 最终 status，
覆盖 `proto-smoke-todo-1/2` 与 `task-5` ... `task-10`）。如有 hard failure，
对应 todo 必须落到 `failed` 或 `cancelled`，禁止保留为 `pending` / `in_progress`。

### Tool Call Log

用 Markdown 列表或表格按实际调用顺序列出关键工具，不需要 45 行全量矩阵。这里的工具名必须来自客户端实际发起的调用或 trace，不要补写未真实调用的工具。每项至少包含：

- 工具名
- 状态：`pass | failed | unavailable | not_directly_invokable`
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

按完整覆盖清单 A-H 分组列出所有项目状态。覆盖状态必须来自真实调用客户端可见工具后的 trace、可见副作用或明确不可用原因；禁止为了让某项变成 pass 而事后硬调用 proto oneof、Exec/Interaction case、mapper 内部别名或未暴露工具名。

用标准 Markdown 列表、嵌套列表或表格组织覆盖结果。每个覆盖项至少包含：

- 分组名称
- 项目名称
- 状态：`pass | failed | unavailable | not_directly_invokable`
- 证据来源：trace、工具返回、可见副作用或 `not_observed`
- gap；没有则写 `none`

要求：

- ToolCall.tool 必须 45 项全列出。
- InteractionQuery/Response 必须 10 对全列出。
- ExecServerMessage、ExecClientMessage、Exec control 必须全列出。
- ConversationAction、InteractionUpdate、AgentClientMessage、AgentServerMessage、aiserver RPC 必须全列出。
- Mapper user-facing 工具名必须全列出或归并到对应 proto case，但归并时必须写 `mapped_to=<proto/tool case>`，不能静默省略。

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
