-- Supabase "rls_disabled_in_public" — the real fix, scoped to what is actually broken.
--
-- ── What the warning means on this project ──────────────────────────────────
--
-- Supabase exposes `public` through PostgREST, and its default privileges grant
-- `anon` and `authenticated` full DML on anything created there. The `anon` key
-- is published in the browser bundle by design. Verified live on 2026-09-19:
-- both roles held SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and
-- TRIGGER on all 16 tables in `public`, and 13 of those had RLS off.
--
-- So this was not a theoretical finding. Anyone who loaded the page could read
-- and delete the entire file index (9,298 rows mapping to 67 GB in Telegram),
-- the share tokens, and — worst — `StorageConfig`, which holds users' encrypted
-- MTProto session strings.
--
-- ── Why this cannot break TeleDrive ─────────────────────────────────────────
--
-- Three independent facts, each checked against the live database rather than
-- assumed:
--
--  1. The app never speaks to PostgREST. There is no `@supabase/supabase-js` in
--     the dependency tree and no import of it anywhere in the source. Supabase
--     is used purely as hosted Postgres, reached by Prisma over the pooler.
--  2. Prisma connects as `postgres`, which has `rolbypassrls = true`. RLS does
--     not apply to that role at all, whatever any policy says.
--  3. `postgres` also owns all 16 tables, and none has FORCE ROW LEVEL
--     SECURITY. An owner is exempt from its own table's RLS without FORCE, so
--     even if (2) changed, the app would still be unaffected.
--
-- That is why no policies are created for the TeleDrive tables. A policy only
-- matters to a caller arriving through the API, and the correct number of those
-- is zero. RLS on with no policies is a default deny, which is the intent.
--
-- ── What this deliberately does NOT touch ───────────────────────────────────
--
-- `public.profiles` and `public.user_state` are left exactly as they are. They
-- are not TeleDrive tables — they are a Supabase starter's, with the
-- `handle_new_user` trigger and a foreign key into `auth.users`. They already
-- have RLS enabled and per-user policies keyed on `auth.uid()`, which is the
-- correct configuration and was never part of the warning. They may also be
-- serving some other client of this project; revoking their grants, or removing
-- `USAGE ON SCHEMA public`, would silently break that. Least privilege means
-- fixing what is exposed, not locking doors that are already correctly locked.
--
-- For the same reason `USAGE ON SCHEMA public` stays granted: withdrawing it
-- would reach past the TeleDrive tables and take those two with it.
--
-- Idempotent. Safe to run repeatedly.

BEGIN;

-- ── 1. RLS on every TeleDrive table ─────────────────────────────────────────
--
-- Driven by a catalogue query with a two-name exclusion list, rather than a
-- hand-written list of the 14 tables to include. The inclusion side is the one
-- that grows: Prisma adds a table on the next migration and it would be missed,
-- which is exactly how this warning arose in the first place. The exclusion
-- side is two rows that pre-date the app and will not grow.
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')              -- ordinary and partitioned tables
      AND c.relname NOT IN ('profiles', 'user_state')
      AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
    RAISE NOTICE 'RLS enabled on public.%', t.relname;
  END LOOP;
END $$;

-- ── 2. Take back the grants ─────────────────────────────────────────────────
--
-- RLS alone answers the advisor. This answers the vulnerability. The two are
-- worth separating: RLS is a row filter that a future `FORCE`-less owner change
-- or a mistakenly permissive policy could undo, whereas a role with no
-- privilege on the table cannot reach it at all.
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relname NOT IN ('profiles', 'user_state')
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t.relname);
  END LOOP;
END $$;

-- Prisma uses no sequences (every id is a cuid generated in the app), so this
-- is belt and braces rather than a fix — but a future `@default(autoincrement())`
-- would create one, and it would be granted by the same defaults.
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- `handle_new_user` is a trigger function. A trigger runs as its owner whatever
-- the caller holds, so removing the direct EXECUTE grant does not stop the
-- signup trigger firing — it only stops anon calling a SECURITY DEFINER
-- function by hand through the API.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated, PUBLIC;

-- ── 3. Stop the next table inheriting the same hole ─────────────────────────
--
-- Supabase ships ALTER DEFAULT PRIVILEGES granting everything in `public` to
-- anon and authenticated. That is what silently re-opened the door each time
-- Prisma created a table, and it is the part that makes this fix hold rather
-- than need re-applying after every migration.
--
-- Scoped to the roles that actually create tables here, and skipped for any this
-- connection cannot speak for. A bare ALTER DEFAULT PRIVILEGES only affects
-- objects created by the role running it, which is why `postgres` is named
-- explicitly: it is the role Prisma migrates as, so it is the one whose defaults
-- decide what the next TeleDrive table inherits.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['postgres', 'supabase_admin']
  LOOP
    -- Membership, not just existence: ALTER DEFAULT PRIVILEGES FOR ROLE only
    -- works for a role you are a member of, and `postgres` is not a member of
    -- `supabase_admin` on a managed project. Without this guard the whole
    -- transaction aborts with "permission denied to change default privileges"
    -- and none of the revokes above land either.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)
       AND pg_has_role(current_user, r, 'MEMBER') THEN
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
