/**
 * Cursor Tool Definition Mapper
 * Maps Cursor's CLIENT_SIDE_TOOL_V2_* tools to Anthropic tool format
 * for sending to backend API, and handles tool call responses
 */

// Tool definition in Anthropic format
export interface AnthropicTool {
  name: string
  description: string
  input_schema: {
    type: "object"
    properties: Record<string, unknown>
    required?: string[]
  }
}

// Mapping of Cursor tool names to Anthropic tool definitions
const CURSOR_TOOL_DEFINITIONS: Record<string, AnthropicTool> = {
  CLIENT_SIDE_TOOL_V2_READ_FILE: {
    name: "read_file",
    description:
      "Read the contents of a file at the specified path. Prefer this tool over run_terminal_command for file inspection. Do not use cat, sed, head, tail, or similar shell commands when read_file can express the request. CRITICAL: This tool ONLY works on files. If the path is a directory, using this tool will cause a crash. Use list_directory for directories.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "The path to the file to read (MUST be a file, not a directory)",
        },
      },
      required: ["path"],
    },
  },

  CLIENT_SIDE_TOOL_V2_READ_FILE_V2: {
    name: "read_file",
    description:
      "Read the contents of a file at the specified path. Prefer this tool over run_terminal_command for file inspection. Do not use cat, sed, head, tail, or similar shell commands when read_file can express the request. CRITICAL: This tool ONLY works on files. If the path is a directory, using this tool will cause a crash. Use list_directory for directories.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "The path to the file to read (MUST be a file, not a directory)",
        },
        start_line: { type: "number", description: "Start line (1-indexed)" },
        end_line: { type: "number", description: "End line (1-indexed)" },
      },
      required: ["path"],
    },
  },

  CLIENT_SIDE_TOOL_V2_LIST_DIR: {
    name: "list_directory",
    description:
      "List the contents of a directory. Prefer this tool over run_terminal_command with ls, find, or similar shell commands when you need workspace file/directory discovery.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The path to the directory to list",
        },
        recursive: {
          type: "boolean",
          description: "Whether to list recursively",
        },
      },
      required: ["path"],
    },
  },

  CLIENT_SIDE_TOOL_V2_LIST_DIR_V2: {
    name: "list_directory",
    description:
      "List the contents of a directory. Prefer this tool over run_terminal_command with ls, find, or similar shell commands when you need workspace file/directory discovery.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The path to the directory to list",
        },
        recursive: {
          type: "boolean",
          description: "Whether to list recursively",
        },
      },
      required: ["path"],
    },
  },

  CLIENT_SIDE_TOOL_V2_EDIT_FILE: {
    name: "edit_file",
    description:
      "Edit a file by applying changes. Before editing, read the file in the current conversation. Copy the existing text verbatim from read_file output, excluding any display-only line number prefixes. Prefer a small unique old_text snippet instead of large blocks of surrounding context.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The path to the file to edit" },
        old_text: { type: "string", description: "The text to replace" },
        new_text: { type: "string", description: "The replacement text" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },

  CLIENT_SIDE_TOOL_V2_EDIT_FILE_V2: {
    name: "edit_file_v2",
    description:
      "Edit a file with exact search and replace. Before editing an existing file, read the file in the current conversation. Prefer a small unique search snippet copied verbatim from read_file output. To create a new file, set search to an empty string and replace to the full file content. If read_file output includes display-only line number prefixes, do not include those prefixes in search or replace. Prefer this tool over run_terminal_command with cat heredoc, tee, echo redirection, sed, perl, python, or shell patching for normal file creation or edits — those still work for ephemeral paths or scripted setup, but edit_file_v2 keeps the diff reviewable in the IDE. The edit FAILS if `search` matches more than once in the file: either provide a larger snippet with surrounding context to make it unique, or set `replace_all: true` to change every occurrence (useful for variable renames or batch alias updates).",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The path to the file to edit" },
        search: { type: "string", description: "The text to search for" },
        replace: { type: "string", description: "The replacement text" },
        replace_all: {
          type: "boolean",
          description:
            "When true, replaces every occurrence of `search` instead of failing on multi-match. Default false. Use for variable renames or batch alias updates.",
        },
      },
      required: ["path", "search", "replace"],
    },
  },

  CLIENT_SIDE_TOOL_V2_FILE_SEARCH: {
    name: "file_search",
    description:
      "Search for files by name pattern. Prefer this tool over run_terminal_command with find or ls for file discovery when the task is to locate files rather than execute shell logic.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query or pattern" },
      },
      required: ["query"],
    },
  },

  CLIENT_SIDE_TOOL_V2_GLOB_FILE_SEARCH: {
    name: "glob_search",
    description:
      "Search for files using glob patterns. Prefer this tool over run_terminal_command with find or ls for file discovery when glob matching is sufficient.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The glob pattern to match" },
      },
      required: ["pattern"],
    },
  },

  CLIENT_SIDE_TOOL_V2_RIPGREP_SEARCH: {
    name: "grep_search",
    description:
      "Search file contents using ripgrep. ALWAYS use this tool for repository text/code search instead of run_terminal_command with grep, rg, find, or similar shell search commands, unless the user explicitly asks for shell command execution.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        path: { type: "string", description: "The path to search in" },
        case_sensitive: {
          type: "boolean",
          description: "Case sensitive search",
        },
      },
      required: ["query"],
    },
  },

  CLIENT_SIDE_TOOL_V2_RIPGREP_RAW_SEARCH: {
    name: "grep_search",
    description:
      "Search file contents using ripgrep. ALWAYS use this tool for repository text/code search instead of run_terminal_command with grep, rg, find, or similar shell search commands, unless the user explicitly asks for shell command execution.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        path: { type: "string", description: "The path to search in" },
        case_sensitive: {
          type: "boolean",
          description: "Case sensitive search",
        },
      },
      required: ["query"],
    },
  },

  CLIENT_SIDE_TOOL_V2_SEMANTIC_SEARCH_FULL: {
    name: "semantic_search",
    description:
      "Find code by intent across the indexed codebase. Use for content " +
      "questions ('where is heartbeat handled?'). Returns candidate file " +
      "paths and snippets — pair with read_semsearch_files to read full " +
      "context for the most promising candidates. For exact-text or path " +
      "patterns prefer grep_search / glob_search instead.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The semantic search query" },
      },
      required: ["query"],
    },
  },

  CLIENT_SIDE_TOOL_V2_RUN_TERMINAL_COMMAND_V2: {
    name: "run_terminal_command",
    description:
      "Run a command in the terminal. Prefer dedicated tools (grep_search, read_file, list_directory, edit_file_v2, etc.) when one fits the task — they keep output structured and reviewable. Use run_terminal_command for build/test execution, system commands, scripts that compute or verify something, or work that no structured tool can express. Shell file writes whose targets land inside the workspace are blocked by the bridge; ephemeral paths (/tmp, smoke fixtures, OS temp dirs) and read-only commands run normally.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run" },
        cwd: {
          type: "string",
          description: "Working directory for the command",
        },
      },
      required: ["command"],
    },
  },

  CLIENT_SIDE_TOOL_V2_DELETE_FILE: {
    name: "delete_file",
    description: "Delete a file at the specified path",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The path to the file to delete" },
      },
      required: ["path"],
    },
  },

  CLIENT_SIDE_TOOL_V2_WEB_SEARCH: {
    name: "web_search",
    description: "Search the web for information",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
      },
      required: ["query"],
    },
  },

  CLIENT_SIDE_TOOL_V2_WEB_FETCH: {
    name: "web_fetch",
    description: "Fetch and summarize content from a URL",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch" },
      },
      required: ["url"],
    },
  },

  CLIENT_SIDE_TOOL_V2_CREATE_PLAN: {
    name: "create_plan",
    description: "Create an implementation plan for a task",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Plan title" },
        steps: {
          type: "array",
          description: "List of steps",
          items: { type: "string" },
        },
      },
      required: ["title", "steps"],
    },
  },

  CLIENT_SIDE_TOOL_V2_TASK: {
    name: "task",
    description:
      "Delegate a focused sub-task to a specialised sub-agent that runs " +
      "in its own isolated context. The sub-agent returns a single final " +
      "message; you must relay a concise summary to the user since the " +
      "sub-agent's intermediate output is not visible to them.",
    input_schema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description:
            "3-5 word label shown in the UI bubble while the sub-agent runs.",
        },
        prompt: {
          type: "string",
          description:
            "The detailed brief you give the sub-agent. Treat the " +
            "sub-agent like a colleague with no prior context: state the " +
            "goal, what's already known/ruled out, and the deliverable. " +
            "Avoid one-liner prompts — they produce shallow output.",
        },
        model: {
          type: "string",
          description:
            "Optional model override. Use only when the sub-agent " +
            "definition explicitly says to.",
        },
        subagent_type: {
          type: "string",
          description:
            "Pick from the available `subagent_type` values listed in " +
            "this tool's description. Omit to fall back to 'general-purpose'.",
        },
        run_in_background: {
          type: "boolean",
          description:
            "When true, the sub-agent runs asynchronously: the tool call " +
            "returns immediately with an `agentId` and the user can keep " +
            "chatting while the sub-agent works. Progress is written to " +
            "`~/.cursor/subagents/<agentId>/transcript.jsonl` and the " +
            "final answer to `~/.cursor/subagents/<agentId>/result.txt` " +
            "— use read_file on those paths to follow up. Background " +
            "sub-agents only get inline tools (no shell, no file edits, " +
            "no run_terminal_command); they're best for parallel " +
            "research / web fetches / MCP work that doesn't need to " +
            "block the user. Default false (foreground, blocks until " +
            "the sub-agent finishes and returns its result inline).",
        },
      },
      required: ["description"],
    },
  },

  CLIENT_SIDE_TOOL_V2_TASK_V2: {
    name: "task",
    description:
      "Delegate a focused sub-task to a specialised sub-agent that runs " +
      "in its own isolated context. The sub-agent returns a single final " +
      "message; you must relay a concise summary to the user since the " +
      "sub-agent's intermediate output is not visible to them.",
    input_schema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description:
            "3-5 word label shown in the UI bubble while the sub-agent runs.",
        },
        prompt: {
          type: "string",
          description:
            "The detailed brief you give the sub-agent. Treat the " +
            "sub-agent like a colleague with no prior context: state the " +
            "goal, what's already known/ruled out, and the deliverable. " +
            "Avoid one-liner prompts — they produce shallow output.",
        },
        model: {
          type: "string",
          description:
            "Optional model override. Use only when the sub-agent " +
            "definition explicitly says to.",
        },
        subagent_type: {
          type: "string",
          description:
            "Pick from the available `subagent_type` values listed in " +
            "this tool's description. Omit to fall back to 'general-purpose'.",
        },
        run_in_background: {
          type: "boolean",
          description:
            "When true, the sub-agent runs asynchronously: the tool call " +
            "returns immediately with an `agentId` and the user can keep " +
            "chatting while the sub-agent works. Progress is written to " +
            "`~/.cursor/subagents/<agentId>/transcript.jsonl` and the " +
            "final answer to `~/.cursor/subagents/<agentId>/result.txt` " +
            "— use read_file on those paths to follow up. Background " +
            "sub-agents only get inline tools (no shell, no file edits, " +
            "no run_terminal_command); they're best for parallel " +
            "research / web fetches / MCP work that doesn't need to " +
            "block the user. Default false (foreground, blocks until " +
            "the sub-agent finishes and returns its result inline).",
        },
      },
      required: ["description"],
    },
  },

  CLIENT_SIDE_TOOL_V2_TODO_READ: {
    name: "read_todos",
    description: "Read current todo items and optional filtered subsets",
    input_schema: {
      type: "object",
      properties: {
        status_filter: {
          type: "array",
          description:
            "Optional todo status filter (pending/in_progress/completed/cancelled)",
          items: { type: "string" },
        },
        id_filter: {
          type: "array",
          description: "Optional todo id filter",
          items: { type: "string" },
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_TODO_WRITE: {
    name: "update_todos",
    description: "Update todo items, optionally merging into current list",
    input_schema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "Todo objects to write",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "Stable todo id",
              },
              content: {
                type: "string",
                description: "Human-readable todo text",
              },
              status: {
                type: "string",
                description:
                  "Todo status enum (TODO_STATUS_PENDING/IN_PROGRESS/COMPLETED/CANCELLED)",
              },
              dependencies: {
                type: "array",
                description: "Optional upstream todo ids",
                items: { type: "string" },
              },
              createdAt: {
                type: "string",
                description: "Optional creation timestamp (unix ms)",
              },
              updatedAt: {
                type: "string",
                description: "Optional update timestamp (unix ms)",
              },
            },
            required: ["id", "content", "status"],
          },
        },
        merge: {
          type: "boolean",
          description: "Whether to merge with existing todos",
        },
      },
      required: ["todos"],
    },
  },

  CLIENT_SIDE_TOOL_V2_DEEP_SEARCH: {
    name: "deep_search",
    description:
      "Like semantic_search but spends more compute on harder queries. " +
      "Returns candidate file paths and snippets — pair with " +
      "read_semsearch_files for full content. Prefer semantic_search for " +
      "first-pass exploration; use deep_search only when semantic_search " +
      "comes back empty or too noisy.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The deep search query" },
      },
      required: ["query"],
    },
  },

  CLIENT_SIDE_TOOL_V2_READ_SEMSEARCH_FILES: {
    name: "read_semsearch_files",
    description:
      "Read full context for files returned by semantic_search or " +
      "deep_search. Pass the candidate paths from those calls (not " +
      "arbitrary paths) so the indexer can stream cached snippets " +
      "efficiently. For arbitrary file paths use read_file instead.",
    input_schema: {
      type: "object",
      properties: {
        file_paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Candidate file paths returned by a prior semantic_search " +
            "or deep_search call",
        },
      },
      required: ["file_paths"],
    },
  },

  CLIENT_SIDE_TOOL_V2_REAPPLY: {
    name: "reapply",
    description: "Reapply a previously suggested patch or diff",
    input_schema: {
      type: "object",
      properties: {
        patch: { type: "string", description: "Patch content to reapply" },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_FETCH_RULES: {
    name: "fetch_rules",
    description:
      "Fetch active project/agent rules, or load a specific Cursor skill by name",
    input_schema: {
      type: "object",
      properties: {
        skill_name: {
          type: "string",
          description:
            "Optional Cursor skill name to activate and load, such as canvas",
        },
        query: {
          type: "string",
          description:
            "Optional natural-language task description; when provided, the proxy ranks available skills by relevance using a lightweight TF-IDF index and returns the top hits in `search_hits` for discovery purposes",
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_SEARCH_SYMBOLS: {
    name: "search_symbols",
    description: "Search symbols in workspace index",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Symbol query" },
      },
      required: ["query"],
    },
  },

  CLIENT_SIDE_TOOL_V2_BACKGROUND_COMPOSER_FOLLOWUP: {
    name: "background_composer_followup",
    description: "Submit a follow-up message to a background composer task",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Follow-up user message" },
      },
      required: ["message"],
    },
  },

  CLIENT_SIDE_TOOL_V2_KNOWLEDGE_BASE: {
    name: "knowledge_base",
    description: "Query knowledge base for supporting information",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Knowledge base query" },
      },
      required: ["query"],
    },
  },

  CLIENT_SIDE_TOOL_V2_FETCH_PULL_REQUEST: {
    name: "fetch_pull_request",
    description: "Fetch pull request metadata/content by URL or identifier",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Pull request URL" },
        id: { type: "string", description: "Optional pull request identifier" },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_CREATE_DIAGRAM: {
    name: "create_diagram",
    description:
      "Create an architecture or flow diagram from text instructions",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Diagram creation prompt" },
      },
      required: ["prompt"],
    },
  },

  CLIENT_SIDE_TOOL_V2_FIX_LINTS: {
    name: "fix_lints",
    description: "Apply automatic lint fixes for targeted files",
    input_schema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Files to lint-fix",
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_GO_TO_DEFINITION: {
    name: "go_to_definition",
    description: "Resolve symbol definition location",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol name or token" },
        path: { type: "string", description: "Optional current file path" },
      },
      required: ["symbol"],
    },
  },

  CLIENT_SIDE_TOOL_V2_AWAIT_TASK: {
    name: "await_task",
    description:
      "Wait for a previously spawned background sub-agent (run_in_background=true) " +
      "to finish. Pass the agentId returned by the original `task` tool call. " +
      "Resolves when the sub-agent completes or fails; if it is still running " +
      "after the optional `block_until_ms` window, returns the still-running " +
      "snapshot (turn / tool call counts) so the parent agent can decide to " +
      "wait again, peek at the transcript, or move on.",
    input_schema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description:
            "The agentId returned by the spawning task tool call. Also " +
            "accepts agent_id / agentId / taskId.",
        },
        block_until_ms: {
          type: "number",
          description:
            "How long (ms) to block before reporting still-running. " +
            "Defaults to 5 minutes; capped at 30 minutes.",
        },
      },
      required: [],
    },
  },

  // bridge-internal definition: there is no ClientSideToolV2 enum value
  // for kill_agent because the proto only exposes CancelSubagentAction
  // (a ConversationAction, not a ToolCall oneof). We surface it as a
  // bridge-defined inline tool so the parent agent can stop a
  // run-away background sub-agent on demand.
  CLIENT_SIDE_TOOL_V2_KILL_AGENT: {
    name: "kill_agent",
    description:
      "Stop a previously spawned background sub-agent. The worker will " +
      "halt at the next abort checkpoint and write a 'killed' terminal " +
      "status to its metadata.json. Pass the agentId returned by the " +
      "original `task` tool call.",
    input_schema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "The agentId of the background sub-agent to kill.",
        },
      },
      required: ["agent_id"],
    },
  },

  CLIENT_SIDE_TOOL_V2_READ_PROJECT: {
    name: "read_project",
    description: "Read project-level settings and metadata",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Optional project key selector" },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_UPDATE_PROJECT: {
    name: "update_project",
    description: "Update project-level settings and metadata",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Project key to update" },
        value: { type: "string", description: "Value to set" },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_MCP: {
    name: "mcp_tool",
    description: "Call a Model Context Protocol tool",
    input_schema: {
      type: "object",
      properties: {
        server_name: { type: "string", description: "MCP server name" },
        tool_name: { type: "string", description: "Tool name to call" },
        arguments: { type: "object", description: "Tool arguments" },
      },
      required: ["server_name", "tool_name"],
    },
  },

  CLIENT_SIDE_TOOL_V2_CALL_MCP_TOOL: {
    name: "mcp_tool",
    description: "Call a Model Context Protocol tool",
    input_schema: {
      type: "object",
      properties: {
        server_name: { type: "string", description: "MCP server name" },
        tool_name: { type: "string", description: "Tool name to call" },
        arguments: { type: "object", description: "Tool arguments" },
      },
      required: ["server_name", "tool_name"],
    },
  },

  CLIENT_SIDE_TOOL_V2_DIAGNOSTICS: {
    name: "read_lints",
    description: "Read lint/diagnostic warnings and errors for files",
    input_schema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "File paths to check for diagnostics",
        },
      },
      required: ["paths"],
    },
  },

  CLIENT_SIDE_TOOL_V2_READ_LINTS: {
    name: "read_lints",
    description: "Read lint/diagnostic warnings and errors for files",
    input_schema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "File paths to check for diagnostics",
        },
      },
      required: ["paths"],
    },
  },

  CLIENT_SIDE_TOOL_V2_ASK_FOLLOWUP_QUESTION: {
    name: "ask_question",
    description: "Ask a follow-up question to the user",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask" },
        title: { type: "string", description: "Question panel title" },
        questions: {
          type: "array",
          description: "Structured question list for interactive UI selection",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Question identifier" },
              prompt: { type: "string", description: "Question prompt text" },
              options: {
                type: "array",
                description: "Selectable options for this question",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "Option identifier" },
                    label: { type: "string", description: "Option label" },
                  },
                  required: ["id", "label"],
                },
              },
              allow_multiple: {
                type: "boolean",
                description: "Allow selecting multiple options",
              },
            },
            required: ["prompt"],
          },
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_ASK_QUESTION: {
    name: "ask_question",
    description: "Ask a follow-up question to the user",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask" },
        title: { type: "string", description: "Question panel title" },
        questions: {
          type: "array",
          description: "Structured question list for interactive UI selection",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Question identifier" },
              prompt: { type: "string", description: "Question prompt text" },
              options: {
                type: "array",
                description: "Selectable options for this question",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "Option identifier" },
                    label: { type: "string", description: "Option label" },
                  },
                  required: ["id", "label"],
                },
              },
              allow_multiple: {
                type: "boolean",
                description: "Allow selecting multiple options",
              },
            },
            required: ["prompt"],
          },
        },
        run_async: {
          type: "boolean",
          description: "Whether to run asynchronously",
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_SWITCH_MODE: {
    name: "switch_mode",
    description: "Switch the current agent mode",
    input_schema: {
      type: "object",
      properties: {
        targetModeId: { type: "string", description: "Target mode id" },
        explanation: {
          type: "string",
          description: "Why the mode switch is needed",
        },
      },
      required: ["targetModeId"],
    },
  },

  CLIENT_SIDE_TOOL_V2_LIST_MCP_RESOURCES: {
    name: "list_mcp_resources",
    description: "List resources from an MCP server",
    input_schema: {
      type: "object",
      properties: {
        serverName: { type: "string", description: "MCP server name" },
      },
      required: ["serverName"],
    },
  },

  CLIENT_SIDE_TOOL_V2_READ_MCP_RESOURCE: {
    name: "read_mcp_resource",
    description: "Read a resource from an MCP server",
    input_schema: {
      type: "object",
      properties: {
        serverName: { type: "string", description: "MCP server name" },
        uri: { type: "string", description: "Resource URI to read" },
      },
      required: ["serverName", "uri"],
    },
  },

  CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS: {
    name: "get_mcp_tools",
    description: "List MCP tools currently available to the agent",
    input_schema: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "Optional MCP server filter",
        },
        tool_name: {
          type: "string",
          description: "Optional MCP tool name filter",
        },
        pattern: {
          type: "string",
          description: "Optional fuzzy match across tool metadata",
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_EXA_SEARCH: {
    name: "exa_search",
    description: "Search the web using Exa",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        type: { type: "string", description: "Optional result type" },
        num_results: {
          type: "number",
          description: "Maximum number of results",
        },
      },
      required: ["query"],
    },
  },

  CLIENT_SIDE_TOOL_V2_EXA_FETCH: {
    name: "exa_fetch",
    description: "Fetch documents by Exa ids or URLs",
    input_schema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Document ids or URLs to fetch",
        },
      },
      required: ["ids"],
    },
  },

  CLIENT_SIDE_TOOL_V2_SETUP_VM_ENVIRONMENT: {
    name: "setup_vm_environment",
    description: "Setup VM environment commands for the current task",
    input_schema: {
      type: "object",
      properties: {
        installCommand: {
          type: "string",
          description: "Install/dependency command",
        },
        startCommand: {
          type: "string",
          description: "Start command after setup",
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_APPLY_AGENT_DIFF: {
    name: "apply_agent_diff",
    description: "Apply an agent-produced diff payload",
    input_schema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent identifier" },
        diff: { type: "string", description: "Unified diff to apply" },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_GENERATE_IMAGE: {
    name: "generate_image",
    description: "Generate an image artifact from a prompt",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Image generation prompt" },
        filePath: {
          type: "string",
          description: "Optional output file path",
        },
      },
      required: ["prompt"],
    },
  },

  CLIENT_SIDE_TOOL_V2_REPORT_BUGFIX_RESULTS: {
    name: "report_bugfix_results",
    description:
      "Report bugfix verification results. Each result item must include " +
      "a non-empty bugId, bugTitle, explanation, and a verdict (one of " +
      '"fixed", "false_positive", "could_not_fix", or the integer 1/2/3).',
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Bugfix summary" },
        results: {
          type: "array",
          description:
            "Structured bugfix results. Must contain at least one item.",
          items: {
            type: "object",
            properties: {
              bugId: {
                type: "string",
                description:
                  'Identifier of the bug being verified (also accepts "bug_id" or "id").',
              },
              bugTitle: {
                type: "string",
                description:
                  'Short title of the bug (also accepts "bug_title" or "title").',
              },
              verdict: {
                description:
                  'Bugfix verdict: "fixed" (1), "false_positive" (2), or "could_not_fix" (3). String or integer accepted.',
                oneOf: [
                  {
                    type: "string",
                    enum: [
                      "fixed",
                      "false_positive",
                      "could_not_fix",
                      "not_fixed",
                      "failed",
                    ],
                  },
                  { type: "integer", minimum: 1, maximum: 3 },
                ],
              },
              explanation: {
                type: "string",
                description:
                  'Reason / details supporting the verdict (also accepts "reason" or "details").',
              },
            },
            required: ["bugId", "bugTitle", "verdict", "explanation"],
          },
          minItems: 1,
        },
      },
      required: ["results"],
    },
  },

  CLIENT_SIDE_TOOL_V2_BACKGROUND_SHELL_SPAWN: {
    name: "background_shell_spawn",
    description: "Spawn a long-running background process",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run" },
        cwd: { type: "string", description: "Working directory" },
      },
      required: ["command"],
    },
  },

  CLIENT_SIDE_TOOL_V2_WRITE_SHELL_STDIN: {
    name: "write_shell_stdin",
    description: "Write input to a running shell process",
    input_schema: {
      type: "object",
      properties: {
        shellId: { type: "number", description: "The shell process ID" },
        data: { type: "string", description: "The data to write" },
      },
      required: ["shellId", "data"],
    },
  },

  CLIENT_SIDE_TOOL_V2_RECORD_SCREEN: {
    name: "record_screen",
    description: "Start/save/discard screen recording in IDE",
    input_schema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          description: "Recording mode such as start/save/discard",
        },
        saveAsFilename: {
          type: "string",
          description: "Optional file name when saving recording",
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_REFLECT: {
    name: "reflect",
    description: "Run reflective reasoning before continuing execution",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  /**
   * AI 代码归因工具 — 对齐 Cursor proto agent/v1.proto AiAttributionArgs。
   * 用于在指定文件/行范围内查找 AI 生成的代码片段。
   */
  CLIENT_SIDE_TOOL_V2_AI_ATTRIBUTION: {
    name: "ai_attribution",
    description:
      "Check AI attribution for code in specified files and line ranges",
    input_schema: {
      type: "object",
      properties: {
        file_paths: {
          type: "array",
          items: { type: "string" },
          description: "File paths to check for AI attribution",
        },
        start_line: {
          type: "number",
          description: "Optional start line number",
        },
        end_line: {
          type: "number",
          description: "Optional end line number",
        },
        commit_hashes: {
          type: "array",
          items: { type: "string" },
          description: "Optional commit hashes to check",
        },
        output_mode: {
          type: "string",
          description: "Output mode for attribution results",
        },
        max_commits: {
          type: "number",
          description: "Maximum number of commits to analyze",
        },
        include_line_ranges: {
          type: "boolean",
          description: "Whether to include line ranges in output",
        },
      },
      required: [],
    },
  },

  /**
   * 通用异步等待工具 — 对齐 Cursor proto agent/v1.proto AwaitArgs。
   * AWAIT_TASK 的升级版，支持 block_until_ms 超时和 regex 匹配。
   */
  CLIENT_SIDE_TOOL_V2_AWAIT: {
    name: "await",
    description:
      "Wait for a background task to complete, with optional timeout and output regex matching",
    input_schema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "ID of the background task to await",
        },
        block_until_ms: {
          type: "number",
          description:
            "Maximum time in milliseconds to block waiting for completion",
        },
        regex: {
          type: "string",
          description: "Optional regex pattern to match against task output",
        },
      },
      required: ["task_id"],
    },
  },

  /**
   * MCP 认证工具 — 对齐 Cursor proto agent/v1.proto McpAuthArgs。
   * 用于触发 MCP 服务器的认证流程。
   */
  CLIENT_SIDE_TOOL_V2_MCP_AUTH: {
    name: "mcp_auth",
    description:
      "Authenticate with an MCP server to unlock access to its tools and " +
      "resources. Call this ONLY in response to an upstream auth requirement: " +
      "either a previous mcp_tool / list_mcp_resources / read_mcp_resource " +
      "result that returned an authentication-required error carrying a " +
      "toolCallId, or an explicit instruction from the user to (re-)auth a " +
      "specific server. Do not invent a toolCallId; copy it verbatim from " +
      "the prior tool error envelope so the IDE can correlate the auth " +
      "exchange back to that pending tool call.",
    input_schema: {
      type: "object",
      properties: {
        server_identifier: {
          type: "string",
          description:
            "Stable identifier of the MCP server to authenticate. Use the " +
            "exact `server` / `providerIdentifier` value reported by " +
            "get_mcp_tools or by the failing mcp_* tool's error payload " +
            "(NOT a human-readable display name).",
        },
        tool_call_id: {
          type: "string",
          description:
            "REQUIRED in practice: the toolCallId of the previous mcp_* " +
            "call whose error indicated that authentication is required. " +
            "If you are running mcp_auth proactively (no upstream error " +
            "exists), set this to a stable identifier the IDE can echo " +
            "back, but never omit the field.",
        },
      },
      // server_identifier is the only proto-level required field; we keep
      // tool_call_id optional in the schema to stay compatible with the
      // proto, but the description above makes its practical necessity
      // explicit so the model does not silently drop it.
      required: ["server_identifier"],
    },
  },

  CLIENT_SIDE_TOOL_V2_START_GRIND_EXECUTION: {
    name: "start_grind_execution",
    description: "Start grind execution workflow",
    input_schema: {
      type: "object",
      properties: {
        explanation: {
          type: "string",
          description: "Optional explanation for the execution request",
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_START_GRIND_PLANNING: {
    name: "start_grind_planning",
    description: "Start grind planning workflow",
    input_schema: {
      type: "object",
      properties: {
        explanation: {
          type: "string",
          description: "Optional explanation for the planning request",
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_COMPUTER_USE: {
    name: "computer_use",
    description: "Perform computer-use actions in IDE automation sandbox",
    input_schema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          description: "Computer-use action list",
          items: { type: "object" },
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_FETCH: {
    name: "fetch",
    description: "Fetch content from a URL",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch" },
      },
      required: ["url"],
    },
  },
}

const PREFERRED_CURSOR_KEY_BY_TOOL_NAME: Record<string, string> = {
  ask_question: "CLIENT_SIDE_TOOL_V2_ASK_QUESTION",
  create_plan: "CLIENT_SIDE_TOOL_V2_CREATE_PLAN",
  switch_mode: "CLIENT_SIDE_TOOL_V2_SWITCH_MODE",
  mcp_tool: "CLIENT_SIDE_TOOL_V2_CALL_MCP_TOOL",
  web_search: "CLIENT_SIDE_TOOL_V2_WEB_SEARCH",
  web_fetch: "CLIENT_SIDE_TOOL_V2_WEB_FETCH",
  exa_search: "CLIENT_SIDE_TOOL_V2_EXA_SEARCH",
  exa_fetch: "CLIENT_SIDE_TOOL_V2_EXA_FETCH",
  // setup_vm_environment intentionally omitted from preferred surface keys —
  // the proxy runtime does not implement a VM environment broker, so we do
  // not advertise it on the user-facing surface. Server-originated tool
  // definitions for SETUP_VM_ENVIRONMENT are still recognized via the
  // CLIENT_SIDE_TOOL_V2_SETUP_VM_ENVIRONMENT definition for backward
  // compatibility, but we never invite the model to call it.
  read_lints: "CLIENT_SIDE_TOOL_V2_READ_LINTS",
  list_mcp_resources: "CLIENT_SIDE_TOOL_V2_LIST_MCP_RESOURCES",
  read_mcp_resource: "CLIENT_SIDE_TOOL_V2_READ_MCP_RESOURCE",
  get_mcp_tools: "CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS",
  task: "CLIENT_SIDE_TOOL_V2_TASK_V2",
  read_todos: "CLIENT_SIDE_TOOL_V2_TODO_READ",
  update_todos: "CLIENT_SIDE_TOOL_V2_TODO_WRITE",
  apply_agent_diff: "CLIENT_SIDE_TOOL_V2_APPLY_AGENT_DIFF",
  generate_image: "CLIENT_SIDE_TOOL_V2_GENERATE_IMAGE",
  report_bugfix_results: "CLIENT_SIDE_TOOL_V2_REPORT_BUGFIX_RESULTS",
  read_semsearch_files: "CLIENT_SIDE_TOOL_V2_READ_SEMSEARCH_FILES",
  reapply: "CLIENT_SIDE_TOOL_V2_REAPPLY",
  fetch_rules: "CLIENT_SIDE_TOOL_V2_FETCH_RULES",
  search_symbols: "CLIENT_SIDE_TOOL_V2_SEARCH_SYMBOLS",
  background_composer_followup:
    "CLIENT_SIDE_TOOL_V2_BACKGROUND_COMPOSER_FOLLOWUP",
  knowledge_base: "CLIENT_SIDE_TOOL_V2_KNOWLEDGE_BASE",
  fetch_pull_request: "CLIENT_SIDE_TOOL_V2_FETCH_PULL_REQUEST",
  create_diagram: "CLIENT_SIDE_TOOL_V2_CREATE_DIAGRAM",
  fix_lints: "CLIENT_SIDE_TOOL_V2_FIX_LINTS",
  go_to_definition: "CLIENT_SIDE_TOOL_V2_GO_TO_DEFINITION",
  await_task: "CLIENT_SIDE_TOOL_V2_AWAIT_TASK",
  await: "CLIENT_SIDE_TOOL_V2_AWAIT",
  ai_attribution: "CLIENT_SIDE_TOOL_V2_AI_ATTRIBUTION",
  mcp_auth: "CLIENT_SIDE_TOOL_V2_MCP_AUTH",
  read_project: "CLIENT_SIDE_TOOL_V2_READ_PROJECT",
  update_project: "CLIENT_SIDE_TOOL_V2_UPDATE_PROJECT",
  reflect: "CLIENT_SIDE_TOOL_V2_REFLECT",
  start_grind_execution: "CLIENT_SIDE_TOOL_V2_START_GRIND_EXECUTION",
  start_grind_planning: "CLIENT_SIDE_TOOL_V2_START_GRIND_PLANNING",
  // wait_agent / kill_agent: friendlier surface for the
  // run_in_background sub-agent lifecycle. wait_agent shares the proto
  // CLIENT_SIDE_TOOL_V2_AWAIT_TASK envelope so dispatch lands in the
  // same registry-aware await flow; kill_agent is a bridge-defined
  // inline tool routed through truncated_tool_call.
  wait_agent: "CLIENT_SIDE_TOOL_V2_AWAIT_TASK",
  kill_agent: "CLIENT_SIDE_TOOL_V2_KILL_AGENT",
}

const TOOL_KEY_ALIASES: Record<string, string> = {
  client_side_tool_v2_ask_followup_question: "CLIENT_SIDE_TOOL_V2_ASK_QUESTION",
  client_side_tool_v2_diagnostics: "CLIENT_SIDE_TOOL_V2_READ_LINTS",
  client_side_tool_v2_call_mcp_tool: "CLIENT_SIDE_TOOL_V2_CALL_MCP_TOOL",
  client_side_tool_v2_read_file: "CLIENT_SIDE_TOOL_V2_READ_FILE",
  client_side_tool_v2_list_dir: "CLIENT_SIDE_TOOL_V2_LIST_DIR",
  client_side_tool_v2_ripgrep_search: "CLIENT_SIDE_TOOL_V2_RIPGREP_SEARCH",
  client_side_tool_v2_record_screen: "CLIENT_SIDE_TOOL_V2_RECORD_SCREEN",
  client_side_tool_v2_computer_use: "CLIENT_SIDE_TOOL_V2_COMPUTER_USE",
  client_side_tool_v2_task: "CLIENT_SIDE_TOOL_V2_TASK",
  client_side_tool_v2_task_v2: "CLIENT_SIDE_TOOL_V2_TASK_V2",
  client_side_tool_v2_todo_read: "CLIENT_SIDE_TOOL_V2_TODO_READ",
  client_side_tool_v2_todo_write: "CLIENT_SIDE_TOOL_V2_TODO_WRITE",
  client_side_tool_v2_apply_agent_diff: "CLIENT_SIDE_TOOL_V2_APPLY_AGENT_DIFF",
  client_side_tool_v2_generate_image: "CLIENT_SIDE_TOOL_V2_GENERATE_IMAGE",
  client_side_tool_v2_report_bugfix_results:
    "CLIENT_SIDE_TOOL_V2_REPORT_BUGFIX_RESULTS",
  client_side_tool_v2_read_semsearch_files:
    "CLIENT_SIDE_TOOL_V2_READ_SEMSEARCH_FILES",
  client_side_tool_v2_reapply: "CLIENT_SIDE_TOOL_V2_REAPPLY",
  client_side_tool_v2_fetch_rules: "CLIENT_SIDE_TOOL_V2_FETCH_RULES",
  client_side_tool_v2_search_symbols: "CLIENT_SIDE_TOOL_V2_SEARCH_SYMBOLS",
  client_side_tool_v2_background_composer_followup:
    "CLIENT_SIDE_TOOL_V2_BACKGROUND_COMPOSER_FOLLOWUP",
  client_side_tool_v2_knowledge_base: "CLIENT_SIDE_TOOL_V2_KNOWLEDGE_BASE",
  client_side_tool_v2_fetch_pull_request:
    "CLIENT_SIDE_TOOL_V2_FETCH_PULL_REQUEST",
  client_side_tool_v2_create_diagram: "CLIENT_SIDE_TOOL_V2_CREATE_DIAGRAM",
  client_side_tool_v2_fix_lints: "CLIENT_SIDE_TOOL_V2_FIX_LINTS",
  client_side_tool_v2_go_to_definition: "CLIENT_SIDE_TOOL_V2_GO_TO_DEFINITION",
  client_side_tool_v2_await_task: "CLIENT_SIDE_TOOL_V2_AWAIT_TASK",
  client_side_tool_v2_await: "CLIENT_SIDE_TOOL_V2_AWAIT",
  client_side_tool_v2_ai_attribution: "CLIENT_SIDE_TOOL_V2_AI_ATTRIBUTION",
  client_side_tool_v2_mcp_auth: "CLIENT_SIDE_TOOL_V2_MCP_AUTH",
  client_side_tool_v2_read_project: "CLIENT_SIDE_TOOL_V2_READ_PROJECT",
  client_side_tool_v2_update_project: "CLIENT_SIDE_TOOL_V2_UPDATE_PROJECT",
  client_side_tool_v2_reflect: "CLIENT_SIDE_TOOL_V2_REFLECT",
  client_side_tool_v2_start_grind_execution:
    "CLIENT_SIDE_TOOL_V2_START_GRIND_EXECUTION",
  client_side_tool_v2_start_grind_planning:
    "CLIENT_SIDE_TOOL_V2_START_GRIND_PLANNING",
  client_side_tool_v2_exa_search: "CLIENT_SIDE_TOOL_V2_EXA_SEARCH",
  client_side_tool_v2_exa_fetch: "CLIENT_SIDE_TOOL_V2_EXA_FETCH",
  client_side_tool_v2_setup_vm_environment:
    "CLIENT_SIDE_TOOL_V2_SETUP_VM_ENVIRONMENT",
  web_search: "CLIENT_SIDE_TOOL_V2_WEB_SEARCH",
  web_fetch: "CLIENT_SIDE_TOOL_V2_WEB_FETCH",
  ask_question: "CLIENT_SIDE_TOOL_V2_ASK_QUESTION",
  create_plan: "CLIENT_SIDE_TOOL_V2_CREATE_PLAN",
  switch_mode: "CLIENT_SIDE_TOOL_V2_SWITCH_MODE",
  exa_search: "CLIENT_SIDE_TOOL_V2_EXA_SEARCH",
  exa_fetch: "CLIENT_SIDE_TOOL_V2_EXA_FETCH",
  // setup_vm_environment alias intentionally omitted from snake-case alias
  // table for the same reason as above (no proxy backend).
  list_mcp_resources: "CLIENT_SIDE_TOOL_V2_LIST_MCP_RESOURCES",
  read_mcp_resource: "CLIENT_SIDE_TOOL_V2_READ_MCP_RESOURCE",
  client_side_tool_v2_get_mcp_tools: "CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS",
  get_mcp_tools: "CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS",
  read_lints: "CLIENT_SIDE_TOOL_V2_READ_LINTS",
  task: "CLIENT_SIDE_TOOL_V2_TASK_V2",
  read_todos: "CLIENT_SIDE_TOOL_V2_TODO_READ",
  update_todos: "CLIENT_SIDE_TOOL_V2_TODO_WRITE",
  todo_read: "CLIENT_SIDE_TOOL_V2_TODO_READ",
  todo_write: "CLIENT_SIDE_TOOL_V2_TODO_WRITE",
  apply_agent_diff: "CLIENT_SIDE_TOOL_V2_APPLY_AGENT_DIFF",
  generate_image: "CLIENT_SIDE_TOOL_V2_GENERATE_IMAGE",
  report_bugfix_results: "CLIENT_SIDE_TOOL_V2_REPORT_BUGFIX_RESULTS",
  read_semsearch_files: "CLIENT_SIDE_TOOL_V2_READ_SEMSEARCH_FILES",
  reapply: "CLIENT_SIDE_TOOL_V2_REAPPLY",
  fetch_rules: "CLIENT_SIDE_TOOL_V2_FETCH_RULES",
  search_symbols: "CLIENT_SIDE_TOOL_V2_SEARCH_SYMBOLS",
  background_composer_followup:
    "CLIENT_SIDE_TOOL_V2_BACKGROUND_COMPOSER_FOLLOWUP",
  knowledge_base: "CLIENT_SIDE_TOOL_V2_KNOWLEDGE_BASE",
  fetch_pull_request: "CLIENT_SIDE_TOOL_V2_FETCH_PULL_REQUEST",
  create_diagram: "CLIENT_SIDE_TOOL_V2_CREATE_DIAGRAM",
  fix_lints: "CLIENT_SIDE_TOOL_V2_FIX_LINTS",
  go_to_definition: "CLIENT_SIDE_TOOL_V2_GO_TO_DEFINITION",
  await_task: "CLIENT_SIDE_TOOL_V2_AWAIT_TASK",
  await: "CLIENT_SIDE_TOOL_V2_AWAIT",
  ai_attribution: "CLIENT_SIDE_TOOL_V2_AI_ATTRIBUTION",
  mcp_auth: "CLIENT_SIDE_TOOL_V2_MCP_AUTH",
  read_project: "CLIENT_SIDE_TOOL_V2_READ_PROJECT",
  update_project: "CLIENT_SIDE_TOOL_V2_UPDATE_PROJECT",
  reflect: "CLIENT_SIDE_TOOL_V2_REFLECT",
  start_grind_execution: "CLIENT_SIDE_TOOL_V2_START_GRIND_EXECUTION",
  start_grind_planning: "CLIENT_SIDE_TOOL_V2_START_GRIND_PLANNING",
  // wait_agent / kill_agent: friendlier surface for the
  // run_in_background sub-agent lifecycle. wait_agent shares the proto
  // CLIENT_SIDE_TOOL_V2_AWAIT_TASK envelope so dispatch lands in the
  // same registry-aware await flow; kill_agent is a bridge-defined
  // inline tool routed through truncated_tool_call.
  wait_agent: "CLIENT_SIDE_TOOL_V2_AWAIT_TASK",
  kill_agent: "CLIENT_SIDE_TOOL_V2_KILL_AGENT",
}

const DEFAULT_AGENT_BUILTIN_CURSOR_TOOLS = [
  "CLIENT_SIDE_TOOL_V2_READ_FILE_V2",
  "CLIENT_SIDE_TOOL_V2_LIST_DIR_V2",
  "CLIENT_SIDE_TOOL_V2_RIPGREP_RAW_SEARCH",
  "CLIENT_SIDE_TOOL_V2_FILE_SEARCH",
  "CLIENT_SIDE_TOOL_V2_GLOB_FILE_SEARCH",
  "CLIENT_SIDE_TOOL_V2_SEMANTIC_SEARCH_FULL",
  "CLIENT_SIDE_TOOL_V2_DEEP_SEARCH",
  "CLIENT_SIDE_TOOL_V2_EDIT_FILE_V2",
  "CLIENT_SIDE_TOOL_V2_RUN_TERMINAL_COMMAND_V2",
  "CLIENT_SIDE_TOOL_V2_DELETE_FILE",
  "CLIENT_SIDE_TOOL_V2_READ_LINTS",
  "CLIENT_SIDE_TOOL_V2_FETCH_RULES",
  "CLIENT_SIDE_TOOL_V2_SEARCH_SYMBOLS",
  "CLIENT_SIDE_TOOL_V2_GO_TO_DEFINITION",
  "CLIENT_SIDE_TOOL_V2_READ_PROJECT",
  "CLIENT_SIDE_TOOL_V2_TASK_V2",
  "CLIENT_SIDE_TOOL_V2_AWAIT_TASK",
  "CLIENT_SIDE_TOOL_V2_AWAIT",
  "CLIENT_SIDE_TOOL_V2_AI_ATTRIBUTION",
  "CLIENT_SIDE_TOOL_V2_MCP_AUTH",
  "CLIENT_SIDE_TOOL_V2_TODO_READ",
  "CLIENT_SIDE_TOOL_V2_TODO_WRITE",
  "CLIENT_SIDE_TOOL_V2_ASK_QUESTION",
  "CLIENT_SIDE_TOOL_V2_CREATE_PLAN",
  "CLIENT_SIDE_TOOL_V2_SWITCH_MODE",
  "CLIENT_SIDE_TOOL_V2_LIST_MCP_RESOURCES",
  "CLIENT_SIDE_TOOL_V2_READ_MCP_RESOURCE",
  "CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS",
  "CLIENT_SIDE_TOOL_V2_CALL_MCP_TOOL",
  "CLIENT_SIDE_TOOL_V2_BACKGROUND_SHELL_SPAWN",
  "CLIENT_SIDE_TOOL_V2_WRITE_SHELL_STDIN",
  "CLIENT_SIDE_TOOL_V2_FETCH",
  "CLIENT_SIDE_TOOL_V2_RECORD_SCREEN",
  "CLIENT_SIDE_TOOL_V2_COMPUTER_USE",
  "CLIENT_SIDE_TOOL_V2_REFLECT",
  "CLIENT_SIDE_TOOL_V2_APPLY_AGENT_DIFF",
  "CLIENT_SIDE_TOOL_V2_REAPPLY",
  "CLIENT_SIDE_TOOL_V2_FIX_LINTS",
  "CLIENT_SIDE_TOOL_V2_READ_SEMSEARCH_FILES",
  "CLIENT_SIDE_TOOL_V2_BACKGROUND_COMPOSER_FOLLOWUP",
  "CLIENT_SIDE_TOOL_V2_KNOWLEDGE_BASE",
  "CLIENT_SIDE_TOOL_V2_FETCH_PULL_REQUEST",
  "CLIENT_SIDE_TOOL_V2_CREATE_DIAGRAM",
  "CLIENT_SIDE_TOOL_V2_UPDATE_PROJECT",
  // CLIENT_SIDE_TOOL_V2_SETUP_VM_ENVIRONMENT intentionally omitted from the
  // default agent builtin tool surface — the proxy runtime does not implement
  // a VM environment broker, so we do not advertise it on the user-facing
  // surface to avoid wasting model tokens on a tool that always fails.
  "CLIENT_SIDE_TOOL_V2_GENERATE_IMAGE",
  "CLIENT_SIDE_TOOL_V2_REPORT_BUGFIX_RESULTS",
  "CLIENT_SIDE_TOOL_V2_START_GRIND_EXECUTION",
  "CLIENT_SIDE_TOOL_V2_START_GRIND_PLANNING",
  "CLIENT_SIDE_TOOL_V2_EXA_SEARCH",
  "CLIENT_SIDE_TOOL_V2_EXA_FETCH",
  "CLIENT_SIDE_TOOL_V2_WEB_SEARCH",
  "CLIENT_SIDE_TOOL_V2_WEB_FETCH",
] as const

const DEFAULT_CODEX_IMPLICIT_CURSOR_TOOLS = [
  "CLIENT_SIDE_TOOL_V2_READ_FILE_V2",
  "CLIENT_SIDE_TOOL_V2_LIST_DIR_V2",
  "CLIENT_SIDE_TOOL_V2_RIPGREP_RAW_SEARCH",
  "CLIENT_SIDE_TOOL_V2_FILE_SEARCH",
  "CLIENT_SIDE_TOOL_V2_GLOB_FILE_SEARCH",
  "CLIENT_SIDE_TOOL_V2_EDIT_FILE_V2",
  "CLIENT_SIDE_TOOL_V2_RUN_TERMINAL_COMMAND_V2",
  "CLIENT_SIDE_TOOL_V2_DELETE_FILE",
  "CLIENT_SIDE_TOOL_V2_READ_LINTS",
  "CLIENT_SIDE_TOOL_V2_FETCH_RULES",
  "CLIENT_SIDE_TOOL_V2_SEARCH_SYMBOLS",
  "CLIENT_SIDE_TOOL_V2_GO_TO_DEFINITION",
  "CLIENT_SIDE_TOOL_V2_READ_PROJECT",
  "CLIENT_SIDE_TOOL_V2_TODO_READ",
  "CLIENT_SIDE_TOOL_V2_TODO_WRITE",
  "CLIENT_SIDE_TOOL_V2_CREATE_PLAN",
  "CLIENT_SIDE_TOOL_V2_LIST_MCP_RESOURCES",
  "CLIENT_SIDE_TOOL_V2_READ_MCP_RESOURCE",
  "CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS",
  "CLIENT_SIDE_TOOL_V2_CALL_MCP_TOOL",
  "CLIENT_SIDE_TOOL_V2_WEB_SEARCH",
  "CLIENT_SIDE_TOOL_V2_WEB_FETCH",
] as const

const BUILTIN_CURSOR_TOOL_KEYS = new Set<string>(
  DEFAULT_AGENT_BUILTIN_CURSOR_TOOLS
)

const BUILTIN_WEB_SEARCH_TOOL_KEYS = new Set<string>([
  "CLIENT_SIDE_TOOL_V2_WEB_SEARCH",
])

const BUILTIN_WEB_FETCH_TOOL_KEYS = new Set<string>([
  "CLIENT_SIDE_TOOL_V2_WEB_FETCH",
])

const BUILTIN_LINT_TOOL_KEYS = new Set<string>([
  "CLIENT_SIDE_TOOL_V2_DIAGNOSTICS",
  "CLIENT_SIDE_TOOL_V2_READ_LINTS",
])

function normalizeToolIdentifier(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
}

function resolveToolDefinitionKey(rawTool: string): string | undefined {
  if (!rawTool) return undefined

  const normalized = normalizeToolIdentifier(rawTool)
  const alias = TOOL_KEY_ALIASES[normalized]
  if (alias && CURSOR_TOOL_DEFINITIONS[alias]) {
    return alias
  }

  if (CURSOR_TOOL_DEFINITIONS[rawTool]) {
    return rawTool
  }

  for (const [key, definition] of Object.entries(CURSOR_TOOL_DEFINITIONS)) {
    if (normalizeToolIdentifier(key) === normalized) {
      return key
    }
    if (normalizeToolIdentifier(definition.name) === normalized) {
      return key
    }
  }

  return undefined
}

export function resolveCursorToolDefinitionKey(
  rawTool: string
): string | undefined {
  return resolveToolDefinitionKey(rawTool)
}

/**
 * Convert Cursor supportedTools list to Anthropic tool definitions
 */
export function mapCursorToolsToAnthropic(
  supportedTools: string[]
): AnthropicTool[] {
  const tools: AnthropicTool[] = []
  const seen = new Set<string>()

  for (const cursorTool of supportedTools) {
    const definitionKey = resolveToolDefinitionKey(cursorTool)
    if (!definitionKey || seen.has(definitionKey)) continue
    seen.add(definitionKey)

    const definition = CURSOR_TOOL_DEFINITIONS[definitionKey]
    if (definition) {
      tools.push(definition)
    }
  }

  return tools
}

/**
 * Map Anthropic tool_use response back to Cursor tool name
 */
export function mapAnthropicToolToCursor(anthropicToolName: string): string {
  const normalizedName = normalizeToolIdentifier(anthropicToolName)
  const preferred = PREFERRED_CURSOR_KEY_BY_TOOL_NAME[normalizedName]
  if (preferred && CURSOR_TOOL_DEFINITIONS[preferred]) {
    return preferred
  }

  // Reverse lookup
  for (const [cursorName, def] of Object.entries(CURSOR_TOOL_DEFINITIONS)) {
    if (def.name === anthropicToolName) {
      return cursorName
    }
  }
  // If no mapping found, return as-is (might be a custom tool)
  return anthropicToolName
}

/**
 * Get all available tool names for logging/debugging
 */
export function getAvailableTools(): string[] {
  return Object.keys(CURSOR_TOOL_DEFINITIONS)
}

function shouldIncludeBuiltInTool(
  definitionKey: string,
  options?: CursorBuiltInToolCapabilityOptions
): boolean {
  const hasExplicitWebCapability =
    options?.webSearchEnabled !== undefined ||
    options?.webFetchEnabled !== undefined

  if (BUILTIN_WEB_SEARCH_TOOL_KEYS.has(definitionKey)) {
    return hasExplicitWebCapability ? options?.webSearchEnabled === true : true
  }

  if (BUILTIN_WEB_FETCH_TOOL_KEYS.has(definitionKey)) {
    return hasExplicitWebCapability ? options?.webFetchEnabled === true : true
  }

  if (BUILTIN_LINT_TOOL_KEYS.has(definitionKey)) {
    if (options?.readLintsEnabled === false) return false
  }

  return true
}

export function getDefaultAgentToolNames(
  options?: CursorBuiltInToolCapabilityOptions
): string[] {
  return DEFAULT_AGENT_BUILTIN_CURSOR_TOOLS.filter((toolName) =>
    shouldIncludeBuiltInTool(toolName, options)
  )
}

function normalizeToolSet(toolNames: string[]): string[] {
  return Array.from(
    new Set(
      toolNames
        .map((toolName) => resolveToolDefinitionKey(toolName) || toolName)
        .filter(Boolean)
    )
  ).sort()
}

export function matchesImplicitDefaultAgentToolNames(
  toolNames: string[],
  options?: CursorBuiltInToolCapabilityOptions
): boolean {
  const normalizedActual = normalizeToolSet(toolNames)
  const normalizedDefault = normalizeToolSet(getDefaultAgentToolNames(options))

  if (normalizedActual.length !== normalizedDefault.length) {
    return false
  }

  return normalizedActual.every(
    (toolName, index) => toolName === normalizedDefault[index]
  )
}

export function getDefaultCodexImplicitAgentToolNames(
  options?: CursorBuiltInToolCapabilityOptions
): string[] {
  return DEFAULT_CODEX_IMPLICIT_CURSOR_TOOLS.filter((toolName) =>
    shouldIncludeBuiltInTool(toolName, options)
  )
}

export function isCursorBuiltInToolAllowed(
  toolName: string,
  options?: CursorBuiltInToolCapabilityOptions
): boolean {
  if (!BUILTIN_CURSOR_TOOL_KEYS.has(toolName)) {
    return true
  }
  return shouldIncludeBuiltInTool(toolName, options)
}

// ToolDefinition format compatible with CreateMessageDto
export interface McpToolDefinitionForApi {
  name: string
  toolName?: string
  providerIdentifier?: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface BuildToolsForApiOptions {
  mcpToolDefs?: McpToolDefinitionForApi[]
  backend?: string
  /**
   * Sub-agent definitions visible to the current session. When provided,
   * the `task` tool's description is rewritten to enumerate every agent's
   * `agentType`, `whenToUse`, and resolved tool surface — mirroring
   * claude-code's `getPrompt(agentDefinitions)` behaviour. Without this,
   * the model only knows the static "Delegate a task/sub-agent execution
   * request" sentence and has to guess what `subagent_type` to pass.
   *
   * Optional: when undefined the static description is used (preserves
   * the legacy contract for callers that don't have a registry yet,
   * e.g. very early bootstrap paths).
   */
  subagentDefinitions?: Array<{
    agentType: string
    whenToUse: string
    /** Pre-resolved user-facing tool names for this sub-agent. */
    toolNames: string[]
  }>
  /**
   * Mark this tool list as being assembled for a sub-agent's own LLM turn
   * rather than the top-level agent. Sub-agents must NOT see the `task`
   * tool itself (no nested sub-agents through the `task` channel — they
   * have no ExecServerMessage path to spawn one), so the dispatcher
   * filters it out when this flag is set.
   */
  forSubAgent?: boolean
}

export interface CursorBuiltInToolCapabilityOptions {
  webSearchEnabled?: boolean
  webFetchEnabled?: boolean
  readLintsEnabled?: boolean
}

export interface ToolDefinition {
  type: "function" | "custom" | "web_search"
  name: string
  description: string
  input_schema?: Record<string, unknown>
  strict?: boolean
  format?: Record<string, unknown>
  external_web_access?: boolean
  search_content_types?: string[]
}

function normalizeToolInputSchema(
  schema: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return {
      type: "object",
      properties: {},
    }
  }
  const normalizedType =
    typeof schema.type === "string" && schema.type.length > 0
      ? schema.type
      : "object"
  const properties =
    normalizedType === "object" &&
    schema.properties &&
    typeof schema.properties === "object"
      ? (schema.properties as Record<string, unknown>)
      : {}
  return {
    ...schema,
    type: normalizedType,
    ...(normalizedType === "object" ? { properties } : {}),
  }
}

const CODEX_APPLY_PATCH_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`

function cloneToolDefinition(tool: ToolDefinition): ToolDefinition {
  return JSON.parse(JSON.stringify(tool)) as ToolDefinition
}

const CODEX_NATIVE_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    name: "exec_command",
    description:
      "Run a shell command and return output or a session id for continued interaction.",
    input_schema: {
      type: "object",
      properties: {
        cmd: { type: "string", description: "Shell command to execute." },
        justification: {
          type: "string",
          description:
            "Optional explanation shown when the command requires elevated permissions.",
        },
        login: {
          type: "boolean",
          description: "Run the shell with login semantics.",
        },
        max_output_tokens: {
          type: "number",
          description: "Maximum output tokens to return.",
        },
        prefix_rule: {
          type: "array",
          description: "Optional reusable command prefix rule.",
          items: { type: "string" },
        },
        sandbox_permissions: {
          type: "string",
          description: "Requested sandbox policy for the command.",
        },
        shell: {
          type: "string",
          description: "Optional shell binary override.",
        },
        tty: {
          type: "boolean",
          description: "Allocate a TTY for interactive commands.",
        },
        workdir: {
          type: "string",
          description: "Optional working directory.",
        },
        yield_time_ms: {
          type: "number",
          description: "How long to wait before yielding output.",
        },
      },
      required: ["cmd"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "write_stdin",
    description:
      "Write characters to a running exec session and return recent output.",
    input_schema: {
      type: "object",
      properties: {
        chars: {
          type: "string",
          description: "Bytes to write to stdin. Empty means poll only.",
        },
        max_output_tokens: {
          type: "number",
          description: "Maximum output tokens to return.",
        },
        session_id: {
          type: "number",
          description: "Identifier of the running exec session.",
        },
        yield_time_ms: {
          type: "number",
          description: "How long to wait before yielding output.",
        },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_mcp_resources",
    description: "List resources exposed by configured MCP servers.",
    input_schema: {
      type: "object",
      properties: {
        cursor: {
          type: "string",
          description: "Opaque pagination cursor from a previous result.",
        },
        server: {
          type: "string",
          description: "Optional MCP server name filter.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_mcp_resource_templates",
    description: "List MCP resource templates exposed by configured servers.",
    input_schema: {
      type: "object",
      properties: {
        cursor: {
          type: "string",
          description: "Opaque pagination cursor from a previous result.",
        },
        server: {
          type: "string",
          description: "Optional MCP server name filter.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_mcp_resource",
    description: "Read a resource from an MCP server by server name and URI.",
    input_schema: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "MCP server name exactly as configured.",
        },
        uri: {
          type: "string",
          description: "Resource URI returned by list_mcp_resources.",
        },
      },
      required: ["server", "uri"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_todos",
    description:
      "Read current todo items and optionally filter by status or id.",
    input_schema: {
      type: "object",
      properties: {
        status_filter: {
          type: "array",
          description:
            "Optional todo status filter (pending/in_progress/completed/cancelled).",
          items: { type: "string" },
        },
        id_filter: {
          type: "array",
          description: "Optional todo id filter.",
          items: { type: "string" },
        },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "update_todos",
    description:
      "Update todo items and optionally merge them into the current list.",
    input_schema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "Todo objects to write.",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "Stable todo id.",
              },
              content: {
                type: "string",
                description: "Human-readable todo text.",
              },
              status: {
                type: "string",
                description:
                  "Todo status enum (TODO_STATUS_PENDING/IN_PROGRESS/COMPLETED/CANCELLED).",
              },
              dependencies: {
                type: "array",
                description: "Optional upstream todo ids.",
                items: { type: "string" },
              },
              createdAt: {
                type: "string",
                description: "Optional creation timestamp (unix ms).",
              },
              updatedAt: {
                type: "string",
                description: "Optional update timestamp (unix ms).",
              },
            },
            required: ["id", "content", "status"],
            additionalProperties: false,
          },
        },
        merge: {
          type: "boolean",
          description: "Whether to merge with existing todos.",
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "update_plan",
    description: "Update the active task plan and plan item statuses.",
    input_schema: {
      type: "object",
      properties: {
        explanation: { type: "string" },
        plan: {
          type: "array",
          description: "Plan items in execution order.",
          items: {
            type: "object",
            properties: {
              status: {
                type: "string",
                description: "One of pending, in_progress, or completed.",
              },
              step: { type: "string" },
            },
            required: ["step", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["plan"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "request_user_input",
    description: "Ask the user one to three short structured questions.",
    input_schema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "Structured question list.",
          items: {
            type: "object",
            properties: {
              header: {
                type: "string",
                description: "Short header label shown in the UI.",
              },
              id: {
                type: "string",
                description: "Stable identifier for the question.",
              },
              options: {
                type: "array",
                description: "Mutually exclusive answer choices.",
                items: {
                  type: "object",
                  properties: {
                    description: {
                      type: "string",
                      description: "Short impact or tradeoff description.",
                    },
                    label: {
                      type: "string",
                      description: "User-facing choice label.",
                    },
                  },
                  required: ["label", "description"],
                  additionalProperties: false,
                },
              },
              question: {
                type: "string",
                description: "Single-sentence prompt shown to the user.",
              },
            },
            required: ["id", "header", "question", "options"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
  },
  {
    type: "custom",
    name: "apply_patch",
    description: "Apply a freeform patch using the Codex apply_patch grammar.",
    format: {
      type: "grammar",
      syntax: "lark",
      definition: CODEX_APPLY_PATCH_GRAMMAR,
    },
  },
  {
    type: "web_search",
    name: "web_search",
    description: "Search the web when local and MCP context is insufficient.",
    external_web_access: true,
    search_content_types: ["text", "image"],
  },
  {
    type: "function",
    name: "view_image",
    description:
      "View a local image file by absolute path within the active workspace.",
    input_schema: {
      type: "object",
      properties: {
        detail: {
          type: "string",
          description: "Optional detail override. Supported value: original.",
        },
        path: {
          type: "string",
          description:
            "Absolute filesystem path to the image inside the active workspace.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "spawn_agent",
    description: "Spawn a sub-agent for an explicitly delegated task.",
    input_schema: {
      type: "object",
      properties: {
        agent_type: {
          type: "string",
          description:
            "Optional sub-agent role such as default, explorer, or worker.",
        },
        fork_context: {
          type: "boolean",
          description: "Fork the current thread history into the new agent.",
        },
        items: {
          type: "array",
          description: "Structured input items for the sub-agent.",
          items: {
            type: "object",
            properties: {
              image_url: { type: "string" },
              name: { type: "string" },
              path: { type: "string" },
              text: { type: "string" },
              type: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        message: {
          type: "string",
          description: "Initial plain-text task for the sub-agent.",
        },
        model: {
          type: "string",
          description: "Optional model override.",
        },
        reasoning_effort: {
          type: "string",
          description: "Optional reasoning effort override.",
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "send_input",
    description: "Send additional input to an existing sub-agent.",
    input_schema: {
      type: "object",
      properties: {
        interrupt: {
          type: "boolean",
          description: "Interrupt the agent and handle this input immediately.",
        },
        items: {
          type: "array",
          description: "Structured input items.",
          items: {
            type: "object",
            properties: {
              image_url: { type: "string" },
              name: { type: "string" },
              path: { type: "string" },
              text: { type: "string" },
              type: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        message: {
          type: "string",
          description: "Plain-text message for the target agent.",
        },
        target: {
          type: "string",
          description: "Agent id to message.",
        },
      },
      required: ["target"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "resume_agent",
    description: "Resume a previously closed agent by id.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Agent id to resume." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "wait_agent",
    description: "Wait for one or more agents to reach a final status.",
    input_schema: {
      type: "object",
      properties: {
        targets: {
          type: "array",
          description: "Agent ids to wait on.",
          items: { type: "string" },
        },
        timeout_ms: {
          type: "number",
          description: "Optional wait timeout in milliseconds.",
        },
      },
      required: ["targets"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "close_agent",
    description: "Close an agent and any open descendants.",
    input_schema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Agent id to close." },
      },
      required: ["target"],
      additionalProperties: false,
    },
  },
]

const CODEX_NATIVE_TOOL_BY_NAME = new Map(
  CODEX_NATIVE_TOOL_DEFINITIONS.map((definition) => [
    normalizeToolIdentifier(definition.name),
    definition,
  ])
)

const EXPLICIT_CODEX_NATIVE_FALLBACK_NAMES = new Set([
  "exec_command",
  "write_stdin",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
  "read_todos",
  "update_todos",
  "update_plan",
  "request_user_input",
  "apply_patch",
  "view_image",
  "spawn_agent",
  "send_input",
  "resume_agent",
  "wait_agent",
  "close_agent",
])

function addCodexToolDefinition(
  tools: ToolDefinition[],
  seenToolNames: Set<string>,
  toolName: string
): void {
  const normalized = normalizeToolIdentifier(toolName)
  const definition = CODEX_NATIVE_TOOL_BY_NAME.get(normalized)
  if (!definition || seenToolNames.has(normalized)) {
    return
  }

  seenToolNames.add(normalized)
  tools.push(cloneToolDefinition(definition))
}

/**
 * Build the dynamic `task` tool description shown to the parent agent.
 *
 * Mirrors claude-code's getPrompt(agentDefinitions) — the model needs to
 * see which sub-agents are available, what each is good for, and what
 * tools each one can use, so it can pick a `subagent_type` that actually
 * matches the task instead of falling back to "general-purpose" with a
 * mismatched tool surface.
 *
 * The static description is preserved as the first paragraph so any
 * model that never reads past the first sentence still gets the original
 * contract; the agent listing follows.
 */
function buildDynamicTaskToolDescription(
  staticDescription: string,
  subagentDefinitions: NonNullable<
    BuildToolsForApiOptions["subagentDefinitions"]
  >
): string {
  if (subagentDefinitions.length === 0) {
    return staticDescription
  }
  const lines: string[] = [
    staticDescription,
    "",
    "Available `subagent_type` values and what each one is good for. Pass " +
      "`subagent_type` to choose; omit it to fall back to `general-purpose`.",
    "",
  ]
  for (const def of subagentDefinitions) {
    const toolList =
      def.toolNames.length === 0
        ? "(no tools)"
        : def.toolNames.length > 8
          ? `${def.toolNames.slice(0, 8).join(", ")}, +${def.toolNames.length - 8} more`
          : def.toolNames.join(", ")
    lines.push(`- ${def.agentType}: ${def.whenToUse} (Tools: ${toolList})`)
  }
  lines.push("")
  lines.push(
    "Sub-agents do NOT have file-system or shell tools (read_file, " +
      "list_directory, run_terminal_command, edit_file_v2, delete_file are " +
      "intentionally omitted). For tasks needing those, do the work yourself " +
      "instead of delegating."
  )
  lines.push(
    "When you delegate, write the prompt as if briefing a colleague who " +
      "just walked into the room with no prior context: state the goal, what " +
      "you've already learned or ruled out, and the specific question or " +
      "deliverable. Terse one-liner prompts produce shallow output."
  )
  return lines.join("\n")
}

function buildCodexToolsForApi(
  supportedTools: string[],
  options?: BuildToolsForApiOptions
): ToolDefinition[] {
  const tools: ToolDefinition[] = []
  const executableViaExecServerMessage = new Set<string>([
    "CLIENT_SIDE_TOOL_V2_READ_FILE",
    "CLIENT_SIDE_TOOL_V2_READ_FILE_V2",
    "CLIENT_SIDE_TOOL_V2_LIST_DIR",
    "CLIENT_SIDE_TOOL_V2_LIST_DIR_V2",
    "CLIENT_SIDE_TOOL_V2_EDIT_FILE",
    "CLIENT_SIDE_TOOL_V2_EDIT_FILE_V2",
    "CLIENT_SIDE_TOOL_V2_RIPGREP_SEARCH",
    "CLIENT_SIDE_TOOL_V2_RIPGREP_RAW_SEARCH",
    "CLIENT_SIDE_TOOL_V2_RUN_TERMINAL_COMMAND_V2",
    "CLIENT_SIDE_TOOL_V2_DELETE_FILE",
    "CLIENT_SIDE_TOOL_V2_MCP",
    "CLIENT_SIDE_TOOL_V2_CALL_MCP_TOOL",
    "CLIENT_SIDE_TOOL_V2_DIAGNOSTICS",
    "CLIENT_SIDE_TOOL_V2_READ_LINTS",
    "CLIENT_SIDE_TOOL_V2_LIST_MCP_RESOURCES",
    "CLIENT_SIDE_TOOL_V2_READ_MCP_RESOURCE",
    "CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS",
    "CLIENT_SIDE_TOOL_V2_ASK_QUESTION",
    "CLIENT_SIDE_TOOL_V2_CREATE_PLAN",
    "CLIENT_SIDE_TOOL_V2_SWITCH_MODE",
    "CLIENT_SIDE_TOOL_V2_BACKGROUND_SHELL_SPAWN",
    "CLIENT_SIDE_TOOL_V2_WRITE_SHELL_STDIN",
    "CLIENT_SIDE_TOOL_V2_RECORD_SCREEN",
    "CLIENT_SIDE_TOOL_V2_COMPUTER_USE",
    "CLIENT_SIDE_TOOL_V2_FETCH",
    "CLIENT_SIDE_TOOL_V2_WEB_SEARCH",
    "CLIENT_SIDE_TOOL_V2_WEB_FETCH",
    "CLIENT_SIDE_TOOL_V2_EXA_SEARCH",
    "CLIENT_SIDE_TOOL_V2_EXA_FETCH",
    "CLIENT_SIDE_TOOL_V2_TASK",
    "CLIENT_SIDE_TOOL_V2_TASK_V2",
    "CLIENT_SIDE_TOOL_V2_TODO_READ",
    "CLIENT_SIDE_TOOL_V2_TODO_WRITE",
    "CLIENT_SIDE_TOOL_V2_APPLY_AGENT_DIFF",
    "CLIENT_SIDE_TOOL_V2_GENERATE_IMAGE",
    "CLIENT_SIDE_TOOL_V2_REPORT_BUGFIX_RESULTS",
    "CLIENT_SIDE_TOOL_V2_FIX_LINTS",
    "CLIENT_SIDE_TOOL_V2_READ_SEMSEARCH_FILES",
    "CLIENT_SIDE_TOOL_V2_REAPPLY",
    "CLIENT_SIDE_TOOL_V2_FETCH_RULES",
    "CLIENT_SIDE_TOOL_V2_SEARCH_SYMBOLS",
    "CLIENT_SIDE_TOOL_V2_BACKGROUND_COMPOSER_FOLLOWUP",
    "CLIENT_SIDE_TOOL_V2_KNOWLEDGE_BASE",
    "CLIENT_SIDE_TOOL_V2_FETCH_PULL_REQUEST",
    "CLIENT_SIDE_TOOL_V2_CREATE_DIAGRAM",
    "CLIENT_SIDE_TOOL_V2_GO_TO_DEFINITION",
    "CLIENT_SIDE_TOOL_V2_AWAIT_TASK",
    "CLIENT_SIDE_TOOL_V2_KILL_AGENT",
    "CLIENT_SIDE_TOOL_V2_AWAIT",
    "CLIENT_SIDE_TOOL_V2_AI_ATTRIBUTION",
    "CLIENT_SIDE_TOOL_V2_MCP_AUTH",
    "CLIENT_SIDE_TOOL_V2_READ_PROJECT",
    "CLIENT_SIDE_TOOL_V2_UPDATE_PROJECT",
    "CLIENT_SIDE_TOOL_V2_REFLECT",
    "CLIENT_SIDE_TOOL_V2_START_GRIND_EXECUTION",
    "CLIENT_SIDE_TOOL_V2_START_GRIND_PLANNING",
    "CLIENT_SIDE_TOOL_V2_FILE_SEARCH",
    "CLIENT_SIDE_TOOL_V2_SEMANTIC_SEARCH_FULL",
    "CLIENT_SIDE_TOOL_V2_DEEP_SEARCH",
    "CLIENT_SIDE_TOOL_V2_GLOB_FILE_SEARCH",
  ])
  const seenDefinitionKeys = new Set<string>()
  const seenToolNames = new Set<string>()
  const resolvedDefinitionKeys = new Set<string>()
  const normalizedSupported = new Set<string>()
  const mcpDefByNormalizedName = new Map<string, McpToolDefinitionForApi>()

  const addCursorToolDefinition = (definitionKey: string): void => {
    if (
      seenDefinitionKeys.has(definitionKey) ||
      !executableViaExecServerMessage.has(definitionKey)
    ) {
      return
    }

    const definition = CURSOR_TOOL_DEFINITIONS[definitionKey]
    if (!definition) {
      return
    }

    const normalizedToolName = normalizeToolIdentifier(definition.name)
    seenDefinitionKeys.add(definitionKey)
    if (seenToolNames.has(normalizedToolName)) {
      return
    }

    seenToolNames.add(normalizedToolName)
    tools.push({
      type: "function",
      ...definition,
    })
  }

  for (const supportedTool of supportedTools) {
    const normalizedSupportedTool = normalizeToolIdentifier(supportedTool)
    if (normalizedSupportedTool) {
      normalizedSupported.add(normalizedSupportedTool)
    }

    const definitionKey = resolveToolDefinitionKey(supportedTool)
    if (!definitionKey) {
      continue
    }

    resolvedDefinitionKeys.add(definitionKey)
    normalizedSupported.add(normalizeToolIdentifier(definitionKey))
    const definition = CURSOR_TOOL_DEFINITIONS[definitionKey]
    if (definition?.name) {
      normalizedSupported.add(normalizeToolIdentifier(definition.name))
    }
  }

  for (const mcpToolDef of options?.mcpToolDefs || []) {
    if (!mcpToolDef || typeof mcpToolDef.name !== "string") continue
    const normalizedFullName = normalizeToolIdentifier(mcpToolDef.name)
    if (normalizedFullName && !mcpDefByNormalizedName.has(normalizedFullName)) {
      mcpDefByNormalizedName.set(normalizedFullName, mcpToolDef)
    }
    if (typeof mcpToolDef.toolName === "string" && mcpToolDef.toolName) {
      const normalizedToolName = normalizeToolIdentifier(mcpToolDef.toolName)
      if (
        normalizedToolName &&
        !mcpDefByNormalizedName.has(normalizedToolName)
      ) {
        mcpDefByNormalizedName.set(normalizedToolName, mcpToolDef)
      }
    }
  }

  for (const supportedTool of supportedTools) {
    const definitionKey = resolveToolDefinitionKey(supportedTool)
    if (definitionKey) {
      if (
        (definitionKey === "CLIENT_SIDE_TOOL_V2_CALL_MCP_TOOL" ||
          definitionKey === "CLIENT_SIDE_TOOL_V2_MCP") &&
        mcpDefByNormalizedName.size > 0
      ) {
        continue
      }
      addCursorToolDefinition(definitionKey)
      continue
    }

    const normalizedCursorTool = normalizeToolIdentifier(supportedTool)
    const mcpToolDef = mcpDefByNormalizedName.get(normalizedCursorTool)
    if (!mcpToolDef || !mcpToolDef.name) continue

    const normalizedMcpName = normalizeToolIdentifier(mcpToolDef.name)
    if (!normalizedMcpName || seenToolNames.has(normalizedMcpName)) continue

    seenToolNames.add(normalizedMcpName)
    tools.push({
      type: "function",
      name: mcpToolDef.name,
      description:
        mcpToolDef.description ||
        `MCP tool ${mcpToolDef.toolName || mcpToolDef.name}`,
      input_schema: normalizeToolInputSchema(mcpToolDef.inputSchema),
    })
  }

  const hasSupportedTool = (...toolAliases: string[]): boolean =>
    toolAliases.some((toolAlias) => {
      if (resolvedDefinitionKeys.has(toolAlias)) {
        return true
      }
      return normalizedSupported.has(normalizeToolIdentifier(toolAlias))
    })

  if (
    hasSupportedTool(
      "CLIENT_SIDE_TOOL_V2_RUN_TERMINAL_COMMAND_V2",
      "CLIENT_SIDE_TOOL_V2_BACKGROUND_SHELL_SPAWN",
      "run_terminal_command",
      "run_terminal_command_v2",
      "background_shell_spawn",
      "exec_command"
    )
  ) {
    addCursorToolDefinition("CLIENT_SIDE_TOOL_V2_WRITE_SHELL_STDIN")
  }

  if (
    hasSupportedTool(
      "CLIENT_SIDE_TOOL_V2_CALL_MCP_TOOL",
      "CLIENT_SIDE_TOOL_V2_MCP",
      "mcp",
      "mcp_tool"
    )
  ) {
    for (const mcpToolDef of options?.mcpToolDefs || []) {
      if (!mcpToolDef || typeof mcpToolDef.name !== "string") continue
      const normalizedMcpName = normalizeToolIdentifier(mcpToolDef.name)
      if (!normalizedMcpName || seenToolNames.has(normalizedMcpName)) continue

      seenToolNames.add(normalizedMcpName)
      tools.push({
        type: "function",
        name: mcpToolDef.name,
        description:
          mcpToolDef.description ||
          `MCP tool ${mcpToolDef.toolName || mcpToolDef.name}`,
        input_schema: normalizeToolInputSchema(mcpToolDef.inputSchema),
      })
    }
  }

  for (const supportedTool of supportedTools) {
    const normalizedSupportedTool = normalizeToolIdentifier(supportedTool)
    if (!EXPLICIT_CODEX_NATIVE_FALLBACK_NAMES.has(normalizedSupportedTool)) {
      continue
    }
    addCodexToolDefinition(tools, seenToolNames, supportedTool)
  }

  return tools
}

/**
 * Build tool definitions for the API backend (CreateMessageDto format).
 * This is the single source of truth — replaces the duplicate buildToolDefinitions
 * in cursor-connect-stream.service.ts.
 */
export function buildToolsForApi(
  supportedTools: string[],
  options?: BuildToolsForApiOptions
): ToolDefinition[] {
  if (options?.backend === "codex") {
    return buildCodexToolsForApi(supportedTools, options)
  }

  const tools: ToolDefinition[] = []
  const executableViaExecServerMessage = new Set<string>([
    "CLIENT_SIDE_TOOL_V2_READ_FILE",
    "CLIENT_SIDE_TOOL_V2_READ_FILE_V2",
    "CLIENT_SIDE_TOOL_V2_LIST_DIR",
    "CLIENT_SIDE_TOOL_V2_LIST_DIR_V2",
    "CLIENT_SIDE_TOOL_V2_EDIT_FILE",
    "CLIENT_SIDE_TOOL_V2_EDIT_FILE_V2",
    "CLIENT_SIDE_TOOL_V2_RIPGREP_SEARCH",
    "CLIENT_SIDE_TOOL_V2_RIPGREP_RAW_SEARCH",
    "CLIENT_SIDE_TOOL_V2_RUN_TERMINAL_COMMAND_V2",
    "CLIENT_SIDE_TOOL_V2_DELETE_FILE",
    "CLIENT_SIDE_TOOL_V2_MCP",
    "CLIENT_SIDE_TOOL_V2_CALL_MCP_TOOL",
    "CLIENT_SIDE_TOOL_V2_DIAGNOSTICS",
    "CLIENT_SIDE_TOOL_V2_READ_LINTS",
    "CLIENT_SIDE_TOOL_V2_LIST_MCP_RESOURCES",
    "CLIENT_SIDE_TOOL_V2_READ_MCP_RESOURCE",
    "CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS",
    "CLIENT_SIDE_TOOL_V2_ASK_QUESTION",
    "CLIENT_SIDE_TOOL_V2_ASK_FOLLOWUP_QUESTION",
    "CLIENT_SIDE_TOOL_V2_CREATE_PLAN",
    "CLIENT_SIDE_TOOL_V2_SWITCH_MODE",
    "CLIENT_SIDE_TOOL_V2_BACKGROUND_SHELL_SPAWN",
    "CLIENT_SIDE_TOOL_V2_WRITE_SHELL_STDIN",
    "CLIENT_SIDE_TOOL_V2_RECORD_SCREEN",
    "CLIENT_SIDE_TOOL_V2_COMPUTER_USE",
    "CLIENT_SIDE_TOOL_V2_FETCH",
    // Deferred / inline interaction tools.
    "CLIENT_SIDE_TOOL_V2_WEB_SEARCH",
    "CLIENT_SIDE_TOOL_V2_WEB_FETCH",
    "CLIENT_SIDE_TOOL_V2_EXA_SEARCH",
    "CLIENT_SIDE_TOOL_V2_EXA_FETCH",
    // CLIENT_SIDE_TOOL_V2_SETUP_VM_ENVIRONMENT intentionally omitted —
    // the proxy runtime does not implement a VM environment broker, so we
    // do not advertise it on the user-facing surface to avoid wasting model
    // tokens on a tool that always fails with "backend not configured".
    "CLIENT_SIDE_TOOL_V2_TASK",
    "CLIENT_SIDE_TOOL_V2_TASK_V2",
    "CLIENT_SIDE_TOOL_V2_TODO_READ",
    "CLIENT_SIDE_TOOL_V2_TODO_WRITE",
    "CLIENT_SIDE_TOOL_V2_APPLY_AGENT_DIFF",
    "CLIENT_SIDE_TOOL_V2_GENERATE_IMAGE",
    "CLIENT_SIDE_TOOL_V2_REPORT_BUGFIX_RESULTS",
    "CLIENT_SIDE_TOOL_V2_FIX_LINTS",
    "CLIENT_SIDE_TOOL_V2_READ_SEMSEARCH_FILES",
    "CLIENT_SIDE_TOOL_V2_REAPPLY",
    "CLIENT_SIDE_TOOL_V2_FETCH_RULES",
    "CLIENT_SIDE_TOOL_V2_SEARCH_SYMBOLS",
    "CLIENT_SIDE_TOOL_V2_BACKGROUND_COMPOSER_FOLLOWUP",
    "CLIENT_SIDE_TOOL_V2_KNOWLEDGE_BASE",
    "CLIENT_SIDE_TOOL_V2_FETCH_PULL_REQUEST",
    "CLIENT_SIDE_TOOL_V2_CREATE_DIAGRAM",
    "CLIENT_SIDE_TOOL_V2_GO_TO_DEFINITION",
    "CLIENT_SIDE_TOOL_V2_AWAIT_TASK",
    "CLIENT_SIDE_TOOL_V2_KILL_AGENT",
    "CLIENT_SIDE_TOOL_V2_READ_PROJECT",
    "CLIENT_SIDE_TOOL_V2_UPDATE_PROJECT",
    "CLIENT_SIDE_TOOL_V2_REFLECT",
    "CLIENT_SIDE_TOOL_V2_START_GRIND_EXECUTION",
    "CLIENT_SIDE_TOOL_V2_START_GRIND_PLANNING",
    "CLIENT_SIDE_TOOL_V2_FILE_SEARCH",
    "CLIENT_SIDE_TOOL_V2_SEMANTIC_SEARCH_FULL",
    "CLIENT_SIDE_TOOL_V2_DEEP_SEARCH",
    "CLIENT_SIDE_TOOL_V2_GLOB_FILE_SEARCH",
  ])
  const seenDefinitionKeys = new Set<string>()
  const seenToolNames = new Set<string>()
  const mcpDefByNormalizedName = new Map<string, McpToolDefinitionForApi>()

  for (const mcpToolDef of options?.mcpToolDefs || []) {
    if (!mcpToolDef || typeof mcpToolDef.name !== "string") continue
    const normalizedFullName = normalizeToolIdentifier(mcpToolDef.name)
    if (normalizedFullName && !mcpDefByNormalizedName.has(normalizedFullName)) {
      mcpDefByNormalizedName.set(normalizedFullName, mcpToolDef)
    }
    if (typeof mcpToolDef.toolName === "string" && mcpToolDef.toolName) {
      const normalizedToolName = normalizeToolIdentifier(mcpToolDef.toolName)
      if (
        normalizedToolName &&
        !mcpDefByNormalizedName.has(normalizedToolName)
      ) {
        mcpDefByNormalizedName.set(normalizedToolName, mcpToolDef)
      }
    }
  }

  for (const cursorTool of supportedTools) {
    const definitionKey = resolveToolDefinitionKey(cursorTool)
    if (definitionKey && !seenDefinitionKeys.has(definitionKey)) {
      // AgentService/Run currently dispatches tool execution via ExecServerMessage.
      // Keep the exposed tool list aligned with that executable subset to avoid
      // protocol-invalid fallbacks for unsupported tool families.
      if (!executableViaExecServerMessage.has(definitionKey)) {
        continue
      }

      // Sub-agents do not get the `task` tool — they cannot spawn nested
      // sub-agents because there is no ExecServerMessage path for the
      // child task envelope. Drop it from the tool list when assembling
      // for a sub-agent's own LLM turn.
      if (
        options?.forSubAgent &&
        (definitionKey === "CLIENT_SIDE_TOOL_V2_TASK" ||
          definitionKey === "CLIENT_SIDE_TOOL_V2_TASK_V2")
      ) {
        seenDefinitionKeys.add(definitionKey)
        continue
      }

      const definition = CURSOR_TOOL_DEFINITIONS[definitionKey]
      if (definition) {
        const normalizedToolName = normalizeToolIdentifier(definition.name)
        if (seenToolNames.has(normalizedToolName)) {
          continue
        }
        seenDefinitionKeys.add(definitionKey)
        seenToolNames.add(normalizedToolName)

        // For the parent agent's `task` tool, rewrite the description so
        // the model can see the available sub-agents (mirrors claude-code's
        // dynamic getPrompt(agentDefinitions)). Without this, the model
        // only sees "Delegate a task/sub-agent execution request" and has
        // to guess what `subagent_type` to pass.
        const isTaskTool =
          definitionKey === "CLIENT_SIDE_TOOL_V2_TASK" ||
          definitionKey === "CLIENT_SIDE_TOOL_V2_TASK_V2"
        const description =
          isTaskTool && options?.subagentDefinitions
            ? buildDynamicTaskToolDescription(
                definition.description,
                options.subagentDefinitions
              )
            : definition.description

        tools.push({
          type: "function",
          ...definition,
          description,
        })
      }
      continue
    }

    const normalizedCursorTool = normalizeToolIdentifier(cursorTool)
    const mcpToolDef = mcpDefByNormalizedName.get(normalizedCursorTool)
    if (!mcpToolDef || !mcpToolDef.name) continue

    const normalizedMcpName = normalizeToolIdentifier(mcpToolDef.name)
    if (!normalizedMcpName || seenToolNames.has(normalizedMcpName)) continue

    seenToolNames.add(normalizedMcpName)
    tools.push({
      type: "function",
      name: mcpToolDef.name,
      description:
        mcpToolDef.description ||
        `MCP tool ${mcpToolDef.toolName || mcpToolDef.name}`,
      input_schema: normalizeToolInputSchema(mcpToolDef.inputSchema),
    })
  }

  return tools
}

/**
 * Get default tools for agent mode (when supportedTools is empty)
 */
export function getDefaultAgentTools(
  options?: CursorBuiltInToolCapabilityOptions
): AnthropicTool[] {
  return mapCursorToolsToAnthropic(getDefaultAgentToolNames(options))
}

/**
 * Get the ClientSideToolV2Type enum value for a given tool name
 *
 * NOTE: These values are extracted from Cursor source code static analysis.
 * The generated proto file has outdated values, so we hardcode the correct ones.
 */
export function getToolTypeEnumValue(toolName: string): number {
  // Corrected enum values from Cursor source analysis (2026-01-19)
  const TOOL_ENUM_VALUES: Record<string, number> = {
    CLIENT_SIDE_TOOL_V2_READ_FILE: 5,
    CLIENT_SIDE_TOOL_V2_READ_SEMSEARCH_FILES: 1,
    CLIENT_SIDE_TOOL_V2_LIST_DIR: 6,
    CLIENT_SIDE_TOOL_V2_EDIT_FILE: 7,
    CLIENT_SIDE_TOOL_V2_RIPGREP_SEARCH: 3,
    CLIENT_SIDE_TOOL_V2_FILE_SEARCH: 8,
    CLIENT_SIDE_TOOL_V2_SEMANTIC_SEARCH_FULL: 9,
    CLIENT_SIDE_TOOL_V2_DEEP_SEARCH: 27,
    CLIENT_SIDE_TOOL_V2_DELETE_FILE: 11,
    CLIENT_SIDE_TOOL_V2_REAPPLY: 12,
    CLIENT_SIDE_TOOL_V2_FETCH_RULES: 16,
    CLIENT_SIDE_TOOL_V2_RUN_TERMINAL_COMMAND_V2: 15,
    CLIENT_SIDE_TOOL_V2_WEB_SEARCH: 18,
    CLIENT_SIDE_TOOL_V2_MCP: 19,
    CLIENT_SIDE_TOOL_V2_SEARCH_SYMBOLS: 23,
    CLIENT_SIDE_TOOL_V2_BACKGROUND_COMPOSER_FOLLOWUP: 24,
    CLIENT_SIDE_TOOL_V2_KNOWLEDGE_BASE: 25,
    CLIENT_SIDE_TOOL_V2_FETCH_PULL_REQUEST: 26,
    CLIENT_SIDE_TOOL_V2_CREATE_DIAGRAM: 28,
    CLIENT_SIDE_TOOL_V2_FIX_LINTS: 29,
    CLIENT_SIDE_TOOL_V2_GO_TO_DEFINITION: 31,
    CLIENT_SIDE_TOOL_V2_WEB_FETCH: 57,
    CLIENT_SIDE_TOOL_V2_EDIT_FILE_V2: 38,
    CLIENT_SIDE_TOOL_V2_LIST_DIR_V2: 39,
    CLIENT_SIDE_TOOL_V2_READ_FILE_V2: 40,
    CLIENT_SIDE_TOOL_V2_RIPGREP_RAW_SEARCH: 41,
    CLIENT_SIDE_TOOL_V2_GLOB_FILE_SEARCH: 42,
    CLIENT_SIDE_TOOL_V2_CREATE_PLAN: 43,
    CLIENT_SIDE_TOOL_V2_LIST_MCP_RESOURCES: 44,
    CLIENT_SIDE_TOOL_V2_READ_MCP_RESOURCE: 45,
    CLIENT_SIDE_TOOL_V2_READ_PROJECT: 46,
    CLIENT_SIDE_TOOL_V2_UPDATE_PROJECT: 47,
    CLIENT_SIDE_TOOL_V2_TASK: 32,
    CLIENT_SIDE_TOOL_V2_AWAIT_TASK: 33,
    CLIENT_SIDE_TOOL_V2_TASK_V2: 48,
    CLIENT_SIDE_TOOL_V2_CALL_MCP_TOOL: 49,
    CLIENT_SIDE_TOOL_V2_APPLY_AGENT_DIFF: 50,
    CLIENT_SIDE_TOOL_V2_ASK_QUESTION: 51,
    CLIENT_SIDE_TOOL_V2_SWITCH_MODE: 52,
    CLIENT_SIDE_TOOL_V2_GENERATE_IMAGE: 53,
    CLIENT_SIDE_TOOL_V2_COMPUTER_USE: 54,
    CLIENT_SIDE_TOOL_V2_WRITE_SHELL_STDIN: 55,
    CLIENT_SIDE_TOOL_V2_RECORD_SCREEN: 56,
    CLIENT_SIDE_TOOL_V2_REPORT_BUGFIX_RESULTS: 58,
    CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS: 63,
    CLIENT_SIDE_TOOL_V2_READ_LINTS: 30,
    CLIENT_SIDE_TOOL_V2_TODO_READ: 34,
    CLIENT_SIDE_TOOL_V2_TODO_WRITE: 35,
  }

  // 1. Direct match on tool name
  const directValue = TOOL_ENUM_VALUES[toolName]
  if (directValue !== undefined) {
    return directValue
  }

  // 2. Find the Cursor tool key by anthropic name
  for (const [key, def] of Object.entries(CURSOR_TOOL_DEFINITIONS)) {
    const enumValue = TOOL_ENUM_VALUES[key]
    if (def.name === toolName && enumValue !== undefined) {
      return enumValue
    }
  }

  // Default: UNSPECIFIED = 0
  return 0
}
