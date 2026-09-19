-- Supabase "rls_disabled_in_public" — the real fix, not the checkbox.
--
-- What the warning means here. Supabase exposes every table in `public` through
-- PostgREST, and its default privileges grant `anon` and `authenticated` full
-- DML on anything created there. The `anon` key is published in the browser
-- bundle by design. So "RLS disabled on a public table" is not a theoretical
-- finding on this project: anyone who loaded the page could read, insert,
-- update and delete every row of every table — the file index, the share
-- tokens, the encrypted MTProto sessions, all of it.
--
-- Why enabling RLS cannot break TeleDrive. The app never speaks to PostgREST.
-- There is no @supabase/supabase-js anywhere in the dependency tree and no
-- import of it anywhere in the source; Supabase is used purely as a hosted
-- Postgres, reached by Prisma over the connection pooler as the `postgres`
-- role, which owns these tables. Postgres exempts a table's owner from its own
-- RLS policies unless FORCE ROW LEVEL SECURITY is set, and this script does not
-- set it. Prisma's queries are therefore completely unaffected.
--
-- That is also why no policies are created. A policy would only matter to a
-- client coming through the API, and the correct number of those is zero.
-- RLS on with no policies is a default deny, which is exactly the intent.
--
-- Idempotent. Safe to run repeatedly.

BEGIN;

-- ── 1. RLS on every table in public, whatever created it ────────────────────
-- Written as a loop rather than a list because the list is not static: Prisma
-- adds tables, and this project also carries `public.profiles` left over from a
-- Supabase starter (the cross-schema FK to auth.users that makes `prisma db
-- push` fail with P4002). A hand-maintained list would silently miss the next
-- table added, which is how this warning appears in the first place.
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')          -- ordinary and partitioned tables
      AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
    RAISE NOTICE 'RLS enabled on public.%', t.relname;
  END LOOP;
END $$;

-- ── 2. Take back the grants that made the tables reachable at all ───────────
-- RLS alone answers the warning. This answers the vulnerability: without USAGE
-- on the schema, PostgREST cannot so much as resolve a table name for these
-- roles, so a future table created without RLS is not instantly exposed the way
-- every table here was.
--
-- Reversible in one line if a Supabase-client feature is ever wanted:
--   GRANT USAGE ON SCHEMA public TO anon, authenticated;
-- and then write real per-row policies before granting anything on a table.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
REVOKE USAGE ON SCHEMA public FROM anon, authenticated;

-- ── 3. Stop the next table inheriting the same hole ─────────────────────────
-- Supabase ships ALTER DEFAULT PRIVILEGES granting everything in `public` to
-- anon and authenticated. That is what silently re-opened the door each time
-- Prisma created a table. Revoking the default privileges is the part that
-- makes this fix hold rather than needing to be re-applied after every
-- migration.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

-- postgres and supabase_admin own the tables and create them; their defaults
-- are the ones that actually apply to anything Prisma makes.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['postgres', 'supabase_admin']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated', r);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated', r);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated', r);
    END IF;
  END LOOP;
END $$;

COMMIT;
