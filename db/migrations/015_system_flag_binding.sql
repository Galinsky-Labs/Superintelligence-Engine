-- Members of sie_tenant_role (the API's RLS-enforced application role) can never be "system",
-- even if a session sets sie.system=on.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sie_tenant_role') THEN
    BEGIN CREATE ROLE sie_tenant_role NOLOGIN; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'cannot create sie_tenant_role'; END;
  END IF;
END $$;
CREATE OR REPLACE FUNCTION sie.is_system() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('sie.system',true),'')='on'
    AND NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname='sie_tenant_role' AND pg_has_role(current_user,r.oid,'MEMBER'))
$$;
