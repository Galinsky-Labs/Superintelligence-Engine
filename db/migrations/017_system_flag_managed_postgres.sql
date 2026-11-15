-- On managed PostgreSQL 16+ (e.g. Neon) the migrating owner is a non-superuser with CREATEROLE.
-- Creating sie_tenant_role implicitly grants that owner ADMIN OPTION on it (INHERIT FALSE, SET FALSE),
-- which pg_has_role(...,'MEMBER') reports as membership, so sie.is_system() was never true for the
-- privileged system pool. Only memberships that actually confer the role's privileges (USAGE) or let
-- the session become it (SET) disqualify a session from being "system".
DO $do$ BEGIN
  IF current_setting('server_version_num')::int >= 160000 THEN
    EXECUTE $f$CREATE OR REPLACE FUNCTION sie.is_system() RETURNS boolean LANGUAGE sql STABLE AS $b$
      SELECT coalesce(current_setting('sie.system',true),'')='on'
        AND NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname='sie_tenant_role'
          AND (pg_has_role(current_user,r.oid,'USAGE') OR pg_has_role(current_user,r.oid,'SET')))
    $b$ $f$;
  END IF;
END $do$;
