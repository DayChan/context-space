import type Database from "better-sqlite3";

export interface MachineMigration {
  version: number;
  name: string;
  sql: string;
}

export const MACHINE_MIGRATIONS: readonly MachineMigration[] = [
  {
    version: 1,
    name: "initial-machine-context-schema",
    sql: `
      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        body_hash TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        analyzed_at TEXT,
        body_purged_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider, external_id)
      );

      CREATE INDEX sources_kind_occurred_idx
        ON sources(kind, occurred_at);

      CREATE TABLE source_participants (
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT,
        position INTEGER NOT NULL,
        PRIMARY KEY(source_id, provider_id, position)
      );

      CREATE TABLE upstream_tasks (
        source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        due_at TEXT,
        assignee_ids_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE upstream_people (
        person_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        display_name TEXT,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider, external_id)
      );

      CREATE TABLE sync_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'partial', 'failed')),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT
      );

      CREATE TABLE sync_source_runs (
        sync_run_id TEXT NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed')),
        received INTEGER NOT NULL DEFAULT 0,
        persisted INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        issue_json TEXT,
        completed_at TEXT,
        PRIMARY KEY(sync_run_id, source)
      );

      CREATE TABLE sync_cursors (
        source TEXT PRIMARY KEY,
        cursor_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE analysis_jobs (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        source_ids_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(
          status IN ('queued', 'leased', 'succeeded', 'failed_retryable', 'failed_terminal')
        ),
        available_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        config_json TEXT NOT NULL,
        last_error_code TEXT,
        last_error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX analysis_jobs_claim_idx
        ON analysis_jobs(status, available_at, lease_expires_at);

      CREATE TABLE analysis_runs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed')),
        provider TEXT NOT NULL,
        model TEXT,
        prompt_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        config_hash TEXT NOT NULL,
        event_types_json TEXT NOT NULL,
        usage_json TEXT,
        error_code TEXT,
        error_message TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX analysis_runs_job_idx ON analysis_runs(job_id, started_at);

      CREATE TABLE analysis_candidates (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
        stable_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('todo', 'knowledge', 'person_insight')),
        status TEXT NOT NULL CHECK(status IN ('proposed', 'rejected', 'pending', 'accepted')),
        title TEXT NOT NULL,
        data_json TEXT NOT NULL,
        source_refs_json TEXT NOT NULL,
        confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reviewed_at TEXT,
        UNIQUE(run_id, stable_key)
      );

      CREATE INDEX analysis_candidates_status_idx
        ON analysis_candidates(status, created_at);

      CREATE TABLE candidate_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id TEXT NOT NULL REFERENCES analysis_candidates(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES sources(id),
        quote TEXT NOT NULL,
        position INTEGER NOT NULL,
        UNIQUE(candidate_id, source_id, position)
      );

      CREATE TABLE acceptance_operations (
        candidate_id TEXT PRIMARY KEY REFERENCES analysis_candidates(id),
        state TEXT NOT NULL CHECK(state IN ('pending', 'materialized', 'accepted', 'conflict')),
        document_id TEXT NOT NULL,
        document_path TEXT NOT NULL,
        document_etag TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE markdown_generations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL CHECK(status IN ('building', 'active', 'retired')),
        created_at TEXT NOT NULL,
        activated_at TEXT
      );

      CREATE UNIQUE INDEX markdown_single_active_generation_idx
        ON markdown_generations(status)
        WHERE status = 'active';

      CREATE TABLE markdown_documents (
        generation_id INTEGER NOT NULL REFERENCES markdown_generations(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        document_id TEXT NOT NULL,
        schema_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT,
        body TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        etag TEXT NOT NULL,
        modified_ms REAL NOT NULL,
        size_bytes INTEGER NOT NULL,
        indexed_at TEXT NOT NULL,
        PRIMARY KEY(generation_id, path),
        UNIQUE(generation_id, document_id)
      );

      CREATE INDEX markdown_documents_search_idx
        ON markdown_documents(generation_id, type, title);

      CREATE TABLE markdown_backlinks (
        generation_id INTEGER NOT NULL,
        document_id TEXT NOT NULL,
        reference TEXT NOT NULL,
        PRIMARY KEY(generation_id, document_id, reference),
        FOREIGN KEY(generation_id, document_id)
          REFERENCES markdown_documents(generation_id, document_id)
          ON DELETE CASCADE
      );

      CREATE INDEX markdown_backlinks_reference_idx
        ON markdown_backlinks(generation_id, reference);

      CREATE TABLE markdown_diagnostics (
        path TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        message TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );

      CREATE TABLE legacy_imports (
        source_path TEXT PRIMARY KEY,
        source_etag TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('imported', 'skipped', 'conflict', 'failed')),
        error TEXT,
        imported_at TEXT NOT NULL
      );
    `
  },
  {
    version: 2,
    name: "analysis-run-duration",
    sql: `
      ALTER TABLE analysis_runs ADD COLUMN duration_ms INTEGER;
    `
  },
  {
    version: 3,
    name: "repair-upstream-person-display-names",
    sql: `
      CREATE INDEX source_participants_provider_idx
        ON source_participants(provider_id);

      UPDATE upstream_people AS person
      SET display_name = (
        SELECT participant.name
        FROM source_participants participant
        JOIN sources source ON source.id = participant.source_id
        WHERE participant.provider_id = person.external_id
          AND participant.name <> participant.provider_id
          AND participant.name NOT IN (
            'Unknown',
            'Lark user',
            'Direct message partner'
          )
        ORDER BY source.occurred_at DESC
        LIMIT 1
      )
      WHERE (
        person.display_name IS NULL
        OR person.display_name = person.external_id
        OR person.display_name IN (
          'Unknown',
          'Lark user',
          'Direct message partner'
        )
      )
      AND EXISTS (
        SELECT 1
        FROM source_participants participant
        WHERE participant.provider_id = person.external_id
          AND participant.name <> participant.provider_id
          AND participant.name NOT IN (
            'Unknown',
            'Lark user',
            'Direct message partner'
          )
      );

      UPDATE upstream_people
      SET display_name = NULL
      WHERE display_name = external_id
         OR display_name IN (
           'Unknown',
           'Lark user',
           'Direct message partner'
         );

      UPDATE source_participants
      SET name = provider_id
      WHERE name IN (
        'Unknown',
        'Lark user',
        'Direct message partner'
      );
    `
  },
  {
    version: 4,
    name: "manual-agent-loop",
    sql: `
      CREATE TABLE agent_repositories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        head_commit TEXT NOT NULL,
        branch TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('todo', 'meego')),
        source_id TEXT NOT NULL,
        repository_id TEXT NOT NULL REFERENCES agent_repositories(id),
        mode TEXT NOT NULL CHECK(mode IN ('read_only', 'isolated_worktree')),
        workspace_path TEXT NOT NULL,
        branch TEXT,
        base_commit TEXT NOT NULL,
        thread_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'cancelled', 'failed')),
        attention TEXT NOT NULL CHECK(attention IN ('none', 'confirmation_required', 'reply_required', 'review_required')),
        workspace_lifecycle TEXT NOT NULL CHECK(workspace_lifecycle IN ('ready', 'retained', 'removed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ended_at TEXT
      );

      CREATE INDEX agent_sessions_status_idx
        ON agent_sessions(status, attention, updated_at);
      CREATE INDEX agent_sessions_source_idx
        ON agent_sessions(source_kind, source_id, updated_at);

      CREATE TABLE agent_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        turn_id TEXT,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX agent_messages_session_idx
        ON agent_messages(session_id, created_at);

      CREATE TABLE agent_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        input_message_id TEXT NOT NULL REFERENCES agent_messages(id),
        status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
        outcome TEXT CHECK(outcome IN ('completed', 'needs_confirmation', 'awaiting_reply', 'blocked')),
        usage_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE INDEX agent_turns_claim_idx
        ON agent_turns(session_id, status, created_at);

      CREATE TABLE agent_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        turn_id TEXT REFERENCES agent_turns(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX agent_events_session_idx
        ON agent_events(session_id, sequence);

      CREATE TABLE agent_confirmations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        turn_id TEXT REFERENCES agent_turns(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('decision', 'action_approval', 'completion_review', 'workspace_upgrade', 'workspace_cleanup')),
        question TEXT NOT NULL,
        options_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'answered', 'approved', 'rejected', 'expired')),
        answer_json TEXT,
        created_at TEXT NOT NULL,
        answered_at TEXT
      );

      CREATE INDEX agent_confirmations_pending_idx
        ON agent_confirmations(session_id, status, created_at);
    `
  },
  {
    version: 5,
    name: "agent-plain-directories",
    sql: `
      ALTER TABLE agent_repositories
        ADD COLUMN kind TEXT NOT NULL DEFAULT 'git'
      CHECK(kind IN ('git', 'directory'));
    `
  },
  {
    version: 6,
    name: "agent-openspec-workflow-kind",
    sql: `
      ALTER TABLE agent_sessions
        ADD COLUMN workflow_kind TEXT NOT NULL DEFAULT 'direct'
        CHECK(workflow_kind IN ('direct', 'openspec'));
    `
  }
];

export function applyMachineMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => (row as { version: number }).version)
  );
  const insert = database.prepare(
    "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)"
  );

  for (const migration of MACHINE_MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    database.transaction(() => {
      database.exec(migration.sql);
      insert.run(migration.version, migration.name, new Date().toISOString());
    })();
  }
}
