-- VERIFY ACCOUNT DELETION AGAINST THE LIVE DATABASE.
--
-- Paste into the Supabase SQL editor and run. It returns one row per
-- property and a final VERDICT row; nothing here writes, and nothing
-- here deletes.
--
-- WHY THIS FILE EXISTS. scripts/test-migrations.mjs applies the
-- migration FILES to a throwaway local cluster and asserts against that
-- — its own header says "Nothing here touches your Supabase project".
-- So it proves a migration WOULD work, never that one WAS applied. On
-- 5 September 2026 production held delete_my_account_data and no
-- delete_my_account, the client's rpc("delete_my_account") failed, and
-- in-app deletion deleted nothing server-side — through a green suite,
-- because no check in this repository had ever asked the database a
-- question. The migration file is a claim; this is the artifact.
--
-- An empty result is impossible by construction: the CTE emits a fixed
-- set of rows whatever the catalogue holds, so "no rows returned"
-- means the query did not run, not that everything passed.

-- A NOTE ON THE ODD-LOOKING to_regprocedure(...)::oid CASTS BELOW:
-- has_function_privilege(text, text, text) RAISES when the function does
-- not exist, which is exactly the state this file is written to report.
-- The oid form is strict instead — a NULL oid yields NULL, which
-- coalesces to a clean FAIL row. Found by running this against a
-- database with the function missing, which is the only way to find it.

with props as (
  select 'delete_my_account() exists' as property,
         (to_regprocedure('public.delete_my_account()') is not null) as ok,
         'the client calls rpc("delete_my_account"); without it in-app deletion fails and nothing is deleted' as why
  union all
  select 'delete_my_account_data() exists',
         (to_regprocedure('public.delete_my_account_data()') is not null),
         'the helper that empties every app table'
  union all
  select 'delete_my_account() is SECURITY DEFINER',
         coalesce((select p.prosecdef from pg_proc p where p.oid = to_regprocedure('public.delete_my_account()')::oid), false),
         'the tables expose no client delete policy, so definer rights are how the rows go'
  union all
  select 'delete_my_account() pins search_path to empty',
         coalesce((select exists (select 1 from unnest(p.proconfig) c where c in ('search_path=', 'search_path=""'))
                     from pg_proc p where p.oid = to_regprocedure('public.delete_my_account()')::oid), false),
         'a definer-rights function without it can be hijacked by a planted schema'
  union all
  select 'delete_my_account() calls delete_my_account_data()',
         coalesce((select p.prosrc ~ 'delete_my_account_data' from pg_proc p where p.oid = to_regprocedure('public.delete_my_account()')::oid), false),
         'without it the app rows survive and only the cascade clears them'
  union all
  select 'delete_my_account() deletes from auth.users',
         coalesce((select p.prosrc ~ 'auth\.users' from pg_proc p where p.oid = to_regprocedure('public.delete_my_account()')::oid), false),
         'without it the account itself survives the deletion'
  union all
  select 'authenticated may execute delete_my_account()',
         coalesce(has_function_privilege('authenticated', to_regprocedure('public.delete_my_account()')::oid, 'execute'), false),
         'this is the role a signed-in student calls as'
  union all
  select 'anon may NOT execute delete_my_account()',
         not coalesce(has_function_privilege('anon', to_regprocedure('public.delete_my_account()')::oid, 'execute'), true),
         'nothing signed out has any business calling it'
  union all
  select 'anon may NOT execute delete_my_account_data()',
         not coalesce(has_function_privilege('anon', to_regprocedure('public.delete_my_account_data()')::oid, 'execute'), true),
         'create-or-replace preserves an ACL, so a function created without 0002 kept PostgreSQL default EXECUTE-to-PUBLIC'
  union all
  select 'authenticated may execute delete_my_account_data()',
         coalesce(has_function_privilege('authenticated', to_regprocedure('public.delete_my_account_data()')::oid, 'execute'), false),
         'the helper is called by the function above, and directly by nothing else'
  union all
  -- Every table a deletion must empty, derived from the catalogue rather
  -- than listed, so a table added later shows up here instead of being
  -- silently missed.
  select 'delete_my_account_data() names every user_id table ('
         || (select string_agg(c.table_name, ', ' order by c.table_name)
               from information_schema.columns c
              where c.table_schema = 'public' and c.column_name = 'user_id') || ')',
         coalesce((select bool_and(p.prosrc like '%'||c.table_name||'%')
                     from information_schema.columns c,
                          pg_proc p
                    where c.table_schema = 'public' and c.column_name = 'user_id'
                      and p.oid = to_regprocedure('public.delete_my_account_data()')::oid), false),
         'a table added without a line in the function survives account deletion'
)
select property,
       case when ok then 'PASS' else 'FAIL' end as result,
       why
from props
union all
select '=== VERDICT ===',
       case when bool_and(ok) then 'ALL PASS' else 'FAILED — see the FAIL rows above' end,
       count(*)::text || ' properties checked'
from props
order by result desc, property;
