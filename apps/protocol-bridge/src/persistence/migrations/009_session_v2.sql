-- Migration 009: Session v2 schema — split the cursor_sessions JSON blob
-- into normalized tables aligned with the post-refactor domain services.
--
-- Per /Users/recronin/.claude/plans/fancy-kindling-alpaca.md, the
-- agent-vibes turn-system architecture refactor replaces the single
-- `cursor_sessions.state_json` blob with one table per ownership domain:
--
--   sessions                   — per-conversation metadata + immutable
--                                request configuration (project context,
--                                cursor rules, custom system prompt, etc).
--                                Mutable runtime state (turn runtime,
--                                budget tracker, lastTransitionReason)
--                                stays in memory and dies with the turn.
--
--   session_messages           — append-only transcript. Ledger txn
--                                writes the matching tool_use / tool_result
--                                row alongside the ledger update so an
--                                orphan can never be persisted.
--
--   tool_call_ledger           — single source of truth for the
--                                tool_use ↔ tool_result protocol. open /
--                                close / aborted, with abort_reason and
--                                cross-references to message seq.
--
--   turn_events                — turn audit log. Every phase change /
--                                model yield / cleanup decision lands
--                                here. TurnPhase is derived from the log,
--                                not stored as a scalar.
--
--   session_file_states        — per-file before/after content snapshots.
--   session_todos              — per-conversation todo items.
--   session_message_blobs      — checkpoint message blob ids.
--   session_read_paths         — per-conversation read-path log.
--
-- Rationale: the previous design serialized everything to a single JSON
-- column at idle, which mixed durable conversation history with
-- ephemeral decision state and forced sanitize-on-read antipatterns.
-- The split lets each domain service own a focused write path with
-- transactional integrity guarantees.
--
-- Strategy: per the user's "drop all old data, no compatibility" mandate,
-- the legacy cursor_sessions table is dropped here. SessionMessage shape
-- changes have made the v1 blob unrecoverable already; this migration
-- formalises the cleanup.

DROP TABLE IF EXISTS cursor_sessions;

-- 1. session metadata
CREATE TABLE sessions (
  conversation_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  model TEXT NOT NULL,
  -- single JSON column for "configuration-class" context: projectContext /
  -- cursorRules / customSystemPrompt / supportedTools / thinkingLevel /
  -- isAgentic / browserContext / additionalRoots / contextTokenLimit etc.
  -- Mutable runtime state never lands here.
  config_json TEXT NOT NULL
);
CREATE INDEX idx_sessions_last_activity ON sessions(last_activity_at);

-- 2. transcript (append-only)
CREATE TABLE session_messages (
  conversation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,            -- monotonic per conversation
  uuid TEXT NOT NULL UNIQUE,
  message_id TEXT,                 -- Anthropic message id (split-sibling merge key)
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  is_meta INTEGER NOT NULL DEFAULT 0,
  timestamp INTEGER NOT NULL,
  content_json TEXT NOT NULL,      -- structured ContentBlock[]
  metadata_json TEXT,              -- request_id / usage / stop_reason / etc.
  PRIMARY KEY (conversation_id, seq),
  FOREIGN KEY (conversation_id)
    REFERENCES sessions(conversation_id) ON DELETE CASCADE
);
CREATE INDEX idx_session_messages_uuid ON session_messages(uuid);
CREATE INDEX idx_session_messages_conv_seq
  ON session_messages(conversation_id, seq);

-- 3. tool protocol ledger (single source of truth)
CREATE TABLE tool_call_ledger (
  conversation_id TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open', 'closed', 'aborted')),
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  abort_reason TEXT,               -- only when state='aborted'
  open_message_seq INTEGER NOT NULL,
  close_message_seq INTEGER,
  PRIMARY KEY (conversation_id, tool_use_id),
  FOREIGN KEY (conversation_id)
    REFERENCES sessions(conversation_id) ON DELETE CASCADE
);
CREATE INDEX idx_ledger_turn ON tool_call_ledger(conversation_id, turn_id);
CREATE INDEX idx_ledger_open
  ON tool_call_ledger(conversation_id, state)
  WHERE state = 'open';

-- 4. turn audit log
CREATE TABLE turn_events (
  conversation_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  event_kind TEXT NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY (conversation_id, turn_id, seq),
  FOREIGN KEY (conversation_id)
    REFERENCES sessions(conversation_id) ON DELETE CASCADE
);
CREATE INDEX idx_turn_events_turn ON turn_events(conversation_id, turn_id);

-- 5. file states (per-file before/after content snapshots)
CREATE TABLE session_file_states (
  conversation_id TEXT NOT NULL,
  path TEXT NOT NULL,
  before_content BLOB NOT NULL,
  after_content BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, path),
  FOREIGN KEY (conversation_id)
    REFERENCES sessions(conversation_id) ON DELETE CASCADE
);

-- 6. todos
CREATE TABLE session_todos (
  conversation_id TEXT NOT NULL,
  id TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  dependencies_json TEXT NOT NULL,
  PRIMARY KEY (conversation_id, id),
  FOREIGN KEY (conversation_id)
    REFERENCES sessions(conversation_id) ON DELETE CASCADE
);

-- 7. message blob ids (used by checkpoint frames)
CREATE TABLE session_message_blobs (
  conversation_id TEXT NOT NULL,
  blob_id TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, blob_id),
  FOREIGN KEY (conversation_id)
    REFERENCES sessions(conversation_id) ON DELETE CASCADE
);

-- 8. read paths
CREATE TABLE session_read_paths (
  conversation_id TEXT NOT NULL,
  path TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, path),
  FOREIGN KEY (conversation_id)
    REFERENCES sessions(conversation_id) ON DELETE CASCADE
);
