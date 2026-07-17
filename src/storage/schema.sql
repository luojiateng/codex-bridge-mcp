create table if not exists runtime_host (
  id text primary key,
  project_root text not null unique,
  port integer not null,
  endpoint text not null,
  pid integer,
  window_title text,
  status text not null,
  started_at text,
  last_heartbeat_at text,
  created_at text not null,
  updated_at text not null
);

create table if not exists project_session (
  id text primary key,
  project_key text not null unique,
  project_root text not null,
  generation integer not null,
  runtime_host_id text,
  active_task_id text,
  codex_thread_id text,
  status text not null,
  claim_token text,
  claim_expires_at text,
  created_at text not null,
  updated_at text not null
);

create table if not exists tui_instance (
  session_id text primary key,
  generation integer not null,
  runtime_endpoint text not null,
  codex_thread_id text not null,
  pid integer,
  process_started_at text,
  status text not null,
  claim_token text,
  claim_expires_at text,
  restart_attempts integer not null default 0,
  restart_window_started_at text,
  next_restart_at text,
  last_exit_at text,
  last_error text,
  created_at text not null,
  updated_at text not null
);

create table if not exists task (
  id text primary key,
  title text not null,
  project_root text not null,
  runtime_host_id text not null,
  codex_thread_id text not null,
  codex_thread_name text,
  status text not null,
  requirements_json text,
  acceptance_json text,
  token_budget integer,
  created_at text not null,
  updated_at text not null,
  unique(id, codex_thread_id)
);

create table if not exists orchestrator_session_binding (
  id text primary key,
  orchestrator_kind text not null,
  orchestrator_session_id text not null,
  task_id text not null unique,
  codex_thread_id text not null unique,
  project_key text not null,
  project_root text not null,
  status text not null,
  created_at text not null,
  last_seen_at text not null,
  closed_at text,
  unique(orchestrator_kind, orchestrator_session_id)
);

create table if not exists task_command_queue (
  id text primary key,
  task_id text not null,
  instruction text not null,
  status text not null,
  created_at text not null,
  started_at text,
  finished_at text
);

create table if not exists turn (
  id text primary key,
  task_id text not null,
  codex_thread_id text not null,
  codex_turn_id text,
  status text not null,
  instruction text,
  attention_revision integer not null default 0,
  attention_ack_revision integer not null default 0,
  attention_kind text,
  attention_payload_json text,
  result_json text,
  created_at text not null,
  updated_at text not null
);

create table if not exists event (
  seq integer primary key autoincrement,
  task_id text not null,
  runtime_host_id text not null,
  codex_thread_id text not null,
  codex_turn_id text,
  event_type text not null,
  payload_json text not null,
  claude_delivered integer default 0,
  created_at text not null
);

create table if not exists approval (
  id text primary key,
  task_id text not null,
  runtime_host_id text not null,
  codex_thread_id text not null,
  codex_turn_id text,
  codex_request_id text not null,
  kind text not null,
  command text,
  cwd text,
  reason text,
  risk_summary text,
  payload_json text,
  decision text,
  decided_by text,
  decision_reason text,
  created_at text not null,
  resolved_at text
);

create table if not exists context_usage (
  task_id text primary key,
  runtime_host_id text not null,
  codex_thread_id text not null,
  codex_turn_id text,
  total_tokens integer not null,
  input_tokens integer,
  cached_input_tokens integer,
  output_tokens integer,
  reasoning_output_tokens integer,
  last_total_tokens integer,
  model_context_window integer,
  context_percent real,
  limit_source text,
  near_limit_emitted integer default 0,
  updated_at text not null
);

create index if not exists idx_event_task_delivered on event(task_id, claude_delivered, seq);
create index if not exists idx_approval_task_decision on approval(task_id, decision, created_at);
create index if not exists idx_turn_task_created on turn(task_id, created_at);
create index if not exists idx_project_session_runtime on project_session(runtime_host_id, status);
create index if not exists idx_tui_instance_endpoint on tui_instance(runtime_endpoint, status);
create index if not exists idx_orchestrator_binding_project
  on orchestrator_session_binding(project_key, status);
