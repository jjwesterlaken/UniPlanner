-- END-TO-END DELETION CHECK, against a throwaway account on the live
-- database. Three steps, in order. Do NOT run this on the reviewer
-- account or on any account you want to keep — step 2 is a real
-- deletion performed from inside the app.
--
-- THE VACUITY TRAP THIS IS BUILT AROUND, and it is the whole reason
-- step 1 exists. After a successful deletion the auth.users row is
-- gone, so any "after" query that finds the user BY EMAIL returns no
-- rows — and no rows looks identical to "everything was deleted". It
-- would report success against a database where the account had never
-- existed, or where you mistyped the address. So step 1 captures the
-- uid and PROVES there is something to delete; step 3 asserts against
-- that literal uid, and returns one row per table whether or not the
-- account is gone.

-- ---------------------------------------------------------------------
-- STEP 1 — BEFORE. Sign up a throwaway account in the app, confirm it,
-- then create data: a course, an assignment, a note, a study card.
-- Run this and KEEP THE OUTPUT. It must show a uid and non-zero rows.
-- ---------------------------------------------------------------------
select u.id as user_id,
       u.email,
       c.table_name,
       (xpath('/row/cnt/text()',
              query_to_xml(format('select count(*) as cnt from public.%I where user_id = %L', c.table_name, u.id),
                           false, true, '')))[1]::text::int as rows_before
  from auth.users u
  cross join information_schema.columns c
 where u.email = 'REPLACE-WITH-THROWAWAY@EXAMPLE.COM'
   and c.table_schema = 'public'
   and c.column_name = 'user_id'
 order by c.table_name;

-- If that returned NO ROWS, stop: the address is wrong or the account
-- does not exist, and nothing below would mean anything.
-- If every rows_before is 0, stop: create some data first, or step 3
-- proves only that zero rows stayed zero.

-- Also note the staged audio, if any (a recording that never finished):
--   Storage → lecture-audio → the folder named with the uid above.

-- ---------------------------------------------------------------------
-- STEP 2 — DELETE FROM INSIDE THE APP. Not from this editor, and not
-- from Authentication → Users: the point is to exercise the path a
-- student actually takes, which is the path that was broken.
--
--   Account tab → Delete account → type DELETE → Delete everything
--
-- It should finish while you wait and return you to a signed-out,
-- empty planner. If it shows an error, capture it — that error IS the
-- result, and the repair has not worked.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- STEP 3 — AFTER. Paste the uid from step 1 in BOTH places below.
-- Every rows_after must be 0, and auth_user_rows must be 0.
-- ---------------------------------------------------------------------
select c.table_name,
       (xpath('/row/cnt/text()',
              query_to_xml(format('select count(*) as cnt from public.%I where user_id = %L',
                                  c.table_name, 'REPLACE-WITH-UID-FROM-STEP-1'::uuid),
                           false, true, '')))[1]::text::int as rows_after
  from information_schema.columns c
 where c.table_schema = 'public'
   and c.column_name = 'user_id'
union all
select 'auth.users (the account itself)',
       (select count(*)::int from auth.users where id = 'REPLACE-WITH-UID-FROM-STEP-1'::uuid)
 order by 1;

-- A row per table appears whether or not the account survived, so an
-- empty result here means the query did not run — never that the
-- deletion succeeded.
--
-- Finally, confirm the audio folder from step 1 is gone from the
-- lecture-audio bucket. src/accountDeletion.js removes it through the
-- Storage API before calling the RPC; if the folder is still there,
-- the storage delete policy from migration 0004 is missing.
