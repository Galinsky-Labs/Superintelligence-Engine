-- Integrated engine runtime: system principal, API tokens, credentials, usage,
-- durable multi-agent runs, approvals, schedules, code workspaces and connections.

-- A trusted server pool sets sie.system='on' on its own connections (API/worker
-- system services). Tenant request paths use a separate pool that never sets it,
-- so row-level security remains a second barrier behind application checks.
CREATE OR REPLACE FUNCTION sie.is_system() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('sie.system',true),'')='on'
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenants','identities','memberships','projects','asset_metadata','budget_accounts',
    'budget_reservations','budget_events','project_artifacts','artifact_revisions','workflow_runs','workflow_jobs',
    'workflow_outbox','mcp_tool_grants','mcp_tool_audit','text_generation_dispatches']
  LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (sie.is_system()) WITH CHECK (sie.is_system())', t||'_system_all', t);
  END LOOP;
END $$;

ALTER TABLE project_artifacts ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'document' CHECK(length(kind) BETWEEN 1 AND 64);
ALTER TABLE project_artifacts ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE project_artifacts ADD COLUMN IF NOT EXISTS run_id uuid;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '' CHECK(length(description)<=4000);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE TABLE api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  product text NOT NULL CHECK(product IN ('academy','command','engine')),
  label text NOT NULL DEFAULT '' CHECK(length(label)<=120),
  scopes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX api_tokens_identity ON api_tokens(identity_id);
ALTER TABLE identities ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT '' CHECK(length(display_name)<=160);
ALTER TABLE identities ADD COLUMN IF NOT EXISTS email text CHECK(email IS NULL OR length(email)<=320);

-- Tenant-scoped provider credentials. Ciphertext only (AES-256-GCM, server key).
CREATE TABLE provider_credentials (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK(provider ~ '^[a-z][a-z0-9-]{1,40}$'),
  ciphertext bytea NOT NULL,
  base_url text CHECK(base_url IS NULL OR length(base_url)<=300),
  fingerprint text NOT NULL CHECK(length(fingerprint) BETWEEN 4 AND 16),
  created_by uuid NOT NULL REFERENCES identities(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,provider)
);

-- Per-tenant model price overrides (microunits per million tokens / per unit).
CREATE TABLE model_prices (
  provider text NOT NULL,
  model text NOT NULL,
  input_micro_per_mtok bigint NOT NULL DEFAULT 0 CHECK(input_micro_per_mtok>=0),
  output_micro_per_mtok bigint NOT NULL DEFAULT 0 CHECK(output_micro_per_mtok>=0),
  unit_micro bigint NOT NULL DEFAULT 0 CHECK(unit_micro>=0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,model)
);

CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES identities(id),
  kind text NOT NULL CHECK(kind IN ('generation','workflow','operation','schedule')),
  title text NOT NULL DEFAULT '' CHECK(length(title)<=256),
  spec jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','awaiting_approval','succeeded','failed','cancelled')),
  budget_ceiling_micro bigint NOT NULL DEFAULT 0 CHECK(budget_ceiling_micro>=0),
  spent_micro bigint NOT NULL DEFAULT 0 CHECK(spent_micro>=0),
  idempotency_key text CHECK(idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 128),
  schedule_id uuid,
  output jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX runs_idempotency ON runs(tenant_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX runs_project_recent ON runs(tenant_id,project_id,created_at DESC);
CREATE INDEX runs_active ON runs(status) WHERE status IN ('queued','running','awaiting_approval');

CREATE TABLE run_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  node_key text NOT NULL CHECK(node_key ~ '^[A-Za-z0-9_.-]{1,64}$'),
  type text NOT NULL CHECK(type IN ('agent','planner','tool','approval','code','media','external_agent')),
  config jsonb NOT NULL,
  depends_on text[] NOT NULL DEFAULT '{}',
  parent_key text,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','running','awaiting_approval','succeeded','failed','skipped','cancelled')),
  attempt int NOT NULL DEFAULT 0 CHECK(attempt>=0),
  max_attempts int NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 20),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  checkpoint jsonb,
  output jsonb,
  artifact_id uuid,
  error text,
  cost_micro bigint NOT NULL DEFAULT 0 CHECK(cost_micro>=0),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id,node_key),
  FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX run_nodes_ready ON run_nodes(next_attempt_at,id) WHERE state='ready';
CREATE INDEX run_nodes_leased ON run_nodes(lease_expires_at) WHERE state='running';
CREATE INDEX run_nodes_run ON run_nodes(run_id,state);

CREATE TABLE run_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  node_key text,
  type text NOT NULL CHECK(type ~ '^[a-z][a-z0-9_.]{1,63}$'),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX run_events_run ON run_events(run_id,id);

CREATE TABLE usage_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid,
  run_id uuid,
  node_key text,
  identity_id uuid,
  provider text NOT NULL,
  model text NOT NULL,
  operation text NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0 CHECK(input_tokens>=0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK(output_tokens>=0),
  units numeric NOT NULL DEFAULT 0,
  cost_micro bigint NOT NULL DEFAULT 0 CHECK(cost_micro>=0),
  estimated boolean NOT NULL DEFAULT false,
  simulated boolean NOT NULL DEFAULT false,
  provider_response_id text,
  reservation_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_records_tenant ON usage_records(tenant_id,recorded_at DESC);
CREATE INDEX usage_records_run ON usage_records(run_id);

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  node_key text NOT NULL,
  action text NOT NULL CHECK(length(action) BETWEEN 1 AND 120),
  effect text NOT NULL CHECK(effect IN ('external','deploy','financial','publish','delete','write','review')),
  summary text NOT NULL DEFAULT '' CHECK(length(summary)<=4000),
  request jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied','expired','consumed')),
  requested_by uuid REFERENCES identities(id),
  decided_by uuid REFERENCES identities(id),
  decision_note text CHECK(decision_note IS NULL OR length(decision_note)<=2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
  FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX approvals_pending ON approvals(tenant_id,status,created_at DESC);
CREATE UNIQUE INDEX approvals_unique_request ON approvals(run_id,node_key,request_sha256);

CREATE TABLE schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES identities(id),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
  cron text NOT NULL CHECK(length(cron) BETWEEN 9 AND 120),
  timezone text NOT NULL DEFAULT 'UTC',
  spec jsonb NOT NULL,
  condition jsonb,
  enabled boolean NOT NULL DEFAULT true,
  next_run_at timestamptz NOT NULL,
  last_run_at timestamptz,
  last_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX schedules_due ON schedules(next_run_at) WHERE enabled;

CREATE TABLE workspace_files (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  path text NOT NULL CHECK(path ~ '^[A-Za-z0-9_.@+-][A-Za-z0-9_./@+-]{0,255}$' AND path !~ '(^|/)\.\.(/|$)' AND path !~ '//' AND path !~ '/$'),
  content text NOT NULL CHECK(octet_length(content)<=1048576),
  revision int NOT NULL DEFAULT 1 CHECK(revision>0),
  sha256 text NOT NULL,
  updated_by uuid NOT NULL REFERENCES identities(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,project_id,path),
  FOREIGN KEY(tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE workspace_file_versions (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  path text NOT NULL,
  revision int NOT NULL,
  content text,
  deleted boolean NOT NULL DEFAULT false,
  sha256 text,
  updated_by uuid NOT NULL REFERENCES identities(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,project_id,path,revision),
  FOREIGN KEY(tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE CASCADE
);

-- MCP servers, external agents and HTTP integrations registered per tenant.
CREATE TABLE connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('mcp','external_agent','http')),
  name text NOT NULL CHECK(name ~ '^[a-z][a-z0-9_-]{1,40}$'),
  endpoint text NOT NULL CHECK(length(endpoint) BETWEEN 8 AND 500),
  secret_ciphertext bytea,
  tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES identities(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,name)
);
CREATE TABLE tool_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id uuid,
  node_key text,
  identity_id uuid,
  tool text NOT NULL,
  effect text NOT NULL,
  decision text NOT NULL CHECK(decision IN ('allowed','denied','failed','approval_required')),
  input_sha256 text NOT NULL,
  detail text,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tool_audit_tenant ON tool_audit(tenant_id,id DESC);

REVOKE ALL ON api_tokens,provider_credentials,model_prices,runs,run_nodes,run_events,usage_records,approvals,schedules,
  workspace_files,workspace_file_versions,connections,tool_audit FROM PUBLIC;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['api_tokens','provider_credentials','runs','run_nodes','run_events','usage_records','approvals',
    'schedules','workspace_files','workspace_file_versions','connections','tool_audit']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (sie.is_system()) WITH CHECK (sie.is_system())', t||'_system_all', t);
  END LOOP;
  -- Tenant members may read tenant-scoped operational records.
  FOREACH t IN ARRAY ARRAY['runs','run_nodes','run_events','usage_records','approvals','schedules','workspace_files','workspace_file_versions','tool_audit']
  LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (tenant_id=sie.current_tenant() AND EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id=%I.tenant_id AND m.identity_id=sie.current_identity()))', t||'_member_read', t, t);
  END LOOP;
  -- Writers may change their workspace files directly through the tenant pool.
  FOREACH t IN ARRAY ARRAY['workspace_files','workspace_file_versions']
  LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (tenant_id=sie.current_tenant() AND updated_by=sie.current_identity() AND EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id=%I.tenant_id AND m.identity_id=sie.current_identity() AND m.role IN (''owner'',''admin'',''member'')))', t||'_member_insert', t, t);
  END LOOP;
END $$;
CREATE POLICY workspace_files_member_update ON workspace_files FOR UPDATE
  USING (tenant_id=sie.current_tenant() AND EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id=workspace_files.tenant_id AND m.identity_id=sie.current_identity() AND m.role IN ('owner','admin','member')))
  WITH CHECK (tenant_id=sie.current_tenant() AND updated_by=sie.current_identity());
CREATE POLICY workspace_files_member_delete ON workspace_files FOR DELETE
  USING (tenant_id=sie.current_tenant() AND EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id=workspace_files.tenant_id AND m.identity_id=sie.current_identity() AND m.role IN ('owner','admin','member')));
CREATE POLICY project_artifacts_member_delete ON project_artifacts FOR DELETE
  USING (tenant_id=sie.current_tenant() AND EXISTS(SELECT 1 FROM memberships m WHERE m.tenant_id=project_artifacts.tenant_id AND m.identity_id=sie.current_identity() AND m.role IN ('owner','admin','member')));
