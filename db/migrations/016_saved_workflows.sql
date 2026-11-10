-- Persistent, versioned workflow definitions that can be re-run with new inputs or scheduled.
CREATE TABLE workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  title text NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 160),
  description text NOT NULL DEFAULT '' CHECK(length(description)<=4000),
  spec jsonb NOT NULL,
  version int NOT NULL DEFAULT 1 CHECK(version>0),
  created_by uuid NOT NULL REFERENCES identities(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX workflows_project ON workflows(tenant_id,project_id,updated_at DESC);
CREATE TABLE workflow_versions (
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version int NOT NULL,
  spec jsonb NOT NULL,
  title text NOT NULL,
  created_by uuid NOT NULL REFERENCES identities(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workflow_id,version)
);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS workflow_id uuid;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS workflow_version int;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS workflow_id uuid REFERENCES workflows(id) ON DELETE CASCADE;
REVOKE ALL ON workflows,workflow_versions FROM PUBLIC;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workflows','workflow_versions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (sie.is_system()) WITH CHECK (sie.is_system())', t||'_system_all', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (tenant_id=sie.current_tenant() AND EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id=%I.tenant_id AND m.identity_id=sie.current_identity()))', t||'_member_read', t, t);
  END LOOP;
END $$;
