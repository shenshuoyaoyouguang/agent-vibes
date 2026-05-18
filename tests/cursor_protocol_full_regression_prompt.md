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
   - 执行追踪项：为任务 5..10 各创建一条 todo，id 用 `task-5` ... `task-10`，初始 status 全部 `pending`。
   - 至少**一条 todo 设置非空 `dependencies`**（例如 `task-10` 依赖 `task-5..task-9`），覆盖该字段。
2. **read_todos 全量读回**：不传 filter，确认 8 条 todo 都在。
3. **read_todos with `status_filter=[pending]`**：覆盖 status_filter；返回的 todos 都应是 pending。
4. **read_todos with `id_filter=["proto-smoke-todo-1", "task-5"]`**：覆盖 id_filter；返回 2 条。
5. **增量合并写入（merge=true）**：用 `update_todos(merge=true, todos=[{id:"task-5", status:"in_progress"}])`
   把 `task-5` 改 `in_progress`，**只传一条**而不是整列。验收返回的 `UpdateTodosSuccess.was_merge=true`，
   且 read_todos 全量读回时其它 7 条 todo 仍然在。
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
   - `name="Cursor Protocol Smoke Regression"`；
   - `overview` 至少一句话描述本轮任务范围；
   - `plan` 用 Markdown，体现任务 5..10 的实际范围；
   - `phases` 至少 2 个（例如 `Read-only checks` / `Write & integration`），每个 phase 各嵌至少 2 条 todo；
   - `todos` 顶层至少 6 条，与任务 5..10 一一对应，**不要把多个任务合并成一条**；
   - `is_project=false`（smoke 测试，不要污染项目级 plan 注册表）。
2. 验收：
   - 至少观察到一对 `createPlanRequestQuery` / `createPlanRequestResponse`；
   - response 里 `result.success` 命中 + `plan_uri` 非空；
   - `plan_uri` 指向的文件**不在仓库工作树内**（应该在 `~/.cursor/` 或 IDE 临时目录）。

注意：`create_plan` 协议层**没有**状态回写字段（只能 create 一次）。
状态机职责完全由 `update_todos(merge=true)` 承担。**禁止**反复调 `create_plan` 假装在更新。

#### 4c. 验收（汇总）

- `update_todos` 至少被调用 4 次：1 次初始化（merge=false）+ 1 次 merge=true 试探 + 至少 2 次任务进度回写；
- `read_todos` 至少被调用 3 次（无 filter / status_filter / id_filter 各一次）；
- `create_plan` 调一次，response 含非空 `plan_uri`；
- 最终 todo 列表准确反映任务 5..10 真实结果（含 hard failure），任务 10 输出 todo 终态摘要；
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

- `fix_lints`：必须传 repo 工作区根下的真实 ts 文件（例如 `apps/protocol-bridge/src/protocol/cursor/cursor-protocol-trace.service.ts`），不要传 `<SMOKE>` 下的文件，否则会被 IDE 校验拒绝（`path is outside workspace root`），那是输入约束不是协议错。
- `report_bugfix_results`：必须传至少 1 项 dummy result（例如 `[{ "id": "smoke-probe", "status": "nop" }]`），传空数组会被入参校验拒绝。
- `setup_vm_environment`：当前桥已经从 user-facing surface 移除该工具（mapper 不再暴露）。如果客户端 surface 上看不到它，记 `not_directly_invokable`，**不要硬调**；如果意外能调到，按实际后端响应记录。

验收：每项记录 `pass / unavailable / not_directly_invokable / failed` 与原因。

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

用 Markdown 列表或表格概述 10 个任务（任务 8 拆为 8a / 8b 共 11 行）。每项至少包含：

- 任务编号和任务名称
- 状态：`pass | pass_with_gaps | failed | unavailable | not_directly_invokable`
- 任务意图
- 期望使用的客户端可见工具
- 实际触发的客户端工具
- 短证据
- gap；没有则写 `none`

任务 4 的 todo 终态摘要必须随 Task Results 一起给出（每条 todo 的 id + 最终 status，
覆盖 `proto-smoke-todo-1/2` 与 `task-5` ... `task-10`）。如有 hard failure，
对应 todo 必须落到 `failed` 或 `cancelled`，禁止保留为 `pending` / `in_progress`。

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

按完整覆盖清单 A-H 分组列出所有项目状态。覆盖状态必须来自真实调用客户端可见工具后的 trace、可见副作用或明确不可用原因；禁止为了让某项变成 pass 而事后硬调用 proto oneof、Exec/Interaction case、mapper 内部别名或未暴露工具名。

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
- F (ConversationAction)：13 个 case 全列出。
- G (ExecServerMessage 24 项 / ExecClientMessage 24 项 / Exec control 4 项)：分 3 张表全列出。
- H (aiserver RPC)：8 个 RPC 全列出。

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
