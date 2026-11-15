-- SIE-036/SCC-015: workspace policies (run budget cap, allowed providers, seats) and an administrative audit log.
CREATE TABLE tenant_policies (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  max_run_budget_micro bigint CHECK (max_run_budget_micro IS NULL OR max_run_budget_micro >= 0),
  allowed_providers text[],
  seat_limit integer CHECK (seat_limit IS NULL OR seat_limit >= 1),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tenant_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_id uuid,
  action text NOT NULL CHECK (length(action) <= 80),
  target text CHECK (length(target) <= 200),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_audit_tenant ON tenant_audit(tenant_id, id DESC);
REVOKE ALL ON tenant_policies, tenant_audit FROM PUBLIC;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_policies','tenant_audit'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (sie.is_system()) WITH CHECK (sie.is_system())', t||'_system_all', t);
  END LOOP;
END $$;
