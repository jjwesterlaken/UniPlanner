-- ---------------------------------------------------------------------
-- notes-quality-weekly.sql — are AI lecture notes any good? (1.3.1)
--
-- Run weekly in Supabase -> SQL editor. Every block below is ONE
-- self-contained SELECT headed `-- @query <name>`: select a block and
-- run it, or run the whole file and read the result tabs in order.
-- Nothing here writes, nothing creates an object, and nothing needs
-- editing to run — the windows are computed from now(). No view, for
-- the reason essay-quality-weekly.sql gives: a view in `public` is
-- granted to anon by the platform and runs as its owner.
--
-- THE TABLE IS 0026's lecture_notes_feedback. Two occasions:
--   delivered  one per set of notes that came back   the denominator
--   rated      one per result, if answered           yes / partly / no
--                                                    + reasons
--
-- Simpler than the essay file on purpose: a lecture result has no
-- redrafts and no marks, so a run is a run and nothing joins twice.
--
-- READ n BEFORE ANY PERCENTAGE. A split computed from three lectures
-- is a number, not evidence. by_course in particular will be mostly
-- rows of 1 or 2 for a long time; it is for spotting a course where
-- "too long" keeps coming back, not for ranking courses.
--
-- `course` is the label the student filed the recording under, typed
-- by them. The same unit can appear as "PSYC1001" and "psych". The
-- query lowercases and trims and does nothing cleverer, deliberately.
--
-- Comments are NOT printed by any query here except the last one. A
-- comment is sent only when the student ticked to send it, and it may
-- quote the lecture; reading them is a deliberate act.
--
-- scripts/test-notes-quality.mjs runs every block against a fixture.
-- ---------------------------------------------------------------------


-- @query volume
-- Results per Sydney week (Monday start), last 8 weeks, and how many of
-- that week's RESULTS were ever rated — by the result's week, not the
-- rating's.
with runs as (
  select user_id, run_id,
         date_trunc('week', created_at at time zone 'Australia/Sydney')::date as week
    from public.lecture_notes_feedback
   where occasion = 'delivered'
     and created_at >= date_trunc('week', now() at time zone 'Australia/Sydney') at time zone 'Australia/Sydney' - interval '7 weeks'
),
rated as (
  select user_id, run_id from public.lecture_notes_feedback where occasion = 'rated'
)
select r.week,
       count(*)                                                as results,
       count(distinct r.user_id)                               as students,
       count(q.run_id)                                         as results_rated,
       round(100.0 * count(q.run_id) / nullif(count(*), 0), 1) as rated_pct
  from runs r
  left join rated q on q.user_id = r.user_id and q.run_id = r.run_id
 group by r.week
 order by r.week desc;


-- @query rating_split
-- "Were these notes useful?", all time first, then per Sydney week of
-- the answer for the last 8 weeks.
with rated as (
  select rating, date_trunc('week', created_at at time zone 'Australia/Sydney')::date as week
    from public.lecture_notes_feedback
   where occasion = 'rated'
),
windows as (
  select 'all time' as period, null::date as week, rating from rated
  union all
  select to_char(week, 'YYYY-MM-DD'), week, rating from rated
   where week >= (date_trunc('week', now() at time zone 'Australia/Sydney') - interval '7 weeks')::date
)
select period,
       count(*)                                                                     as n,
       count(*) filter (where rating = 'yes')                                       as yes,
       count(*) filter (where rating = 'partly')                                    as partly,
       count(*) filter (where rating = 'no')                                        as no,
       round(100.0 * count(*) filter (where rating = 'yes')    / nullif(count(*), 0), 1) as yes_pct,
       round(100.0 * count(*) filter (where rating = 'partly') / nullif(count(*), 0), 1) as partly_pct,
       round(100.0 * count(*) filter (where rating = 'no')     / nullif(count(*), 0), 1) as no_pct
  from windows
 group by period, week
 order by week desc nulls first;


-- @query reasons
-- Why a result was only partly useful, or not. Denominated by the
-- partly/no ratings; a rating can carry several reasons, so pct does
-- not sum to 100. Every reason in 0026's closed set is listed, at zero
-- if nobody chose it, so an absent row never reads as "not measured".
with unhappy as (
  select rating, reasons, created_at
    from public.lecture_notes_feedback
   where occasion = 'rated' and rating in ('partly', 'no')
),
totals as (
  select count(*) as all_n,
         count(*) filter (where created_at >= now() - interval '28 days') as recent_n
    from unhappy
),
reason_set(reason) as (
  values ('too-long'), ('too-short'), ('missed-assessable'), ('wrong-terms'), ('wrong-structure'), ('other')
)
select s.reason,
       count(u.rating)                                                       as n,
       count(u.rating) filter (where u.rating = 'partly')                    as from_partly,
       count(u.rating) filter (where u.rating = 'no')                        as from_no,
       round(100.0 * count(u.rating) / nullif(t.all_n, 0), 1)                as pct_of_unhappy,
       count(u.rating) filter (where u.created_at >= now() - interval '28 days') as n_28d,
       t.all_n                                                               as unhappy_total
  from reason_set s
 cross join totals t
  left join unhappy u on s.reason = any (u.reasons)
 group by s.reason, t.all_n
 order by n desc, s.reason;


-- @query by_course
-- Per course label (lowercased, trimmed; blank is "(no course)"): how
-- many results, how many rated, the split, and each reason's count.
-- The number of rows IS the course count. All time, because per-week
-- per-course is too thin to read for a long while yet.
with d as (
  select user_id, run_id, coalesce(nullif(lower(trim(course)), ''), '(no course)') as course
    from public.lecture_notes_feedback where occasion = 'delivered'
),
r as (
  select user_id, run_id, rating, reasons, coalesce(nullif(lower(trim(course)), ''), '(no course)') as course
    from public.lecture_notes_feedback where occasion = 'rated'
),
courses as (select course from d union select course from r)
select c.course,
       (select count(*) from d where d.course = c.course)                                    as results,
       (select count(distinct user_id) from d where d.course = c.course)                     as students,
       count(r.rating)                                                                       as rated,
       count(*) filter (where r.rating = 'yes')                                              as yes,
       count(*) filter (where r.rating = 'partly')                                           as partly,
       count(*) filter (where r.rating = 'no')                                               as no,
       count(*) filter (where 'too-long' = any (r.reasons))                                  as too_long,
       count(*) filter (where 'too-short' = any (r.reasons))                                 as too_short,
       count(*) filter (where 'missed-assessable' = any (r.reasons))                         as missed_assessable,
       count(*) filter (where 'wrong-terms' = any (r.reasons))                               as wrong_terms,
       count(*) filter (where 'wrong-structure' = any (r.reasons))                           as wrong_structure,
       count(*) filter (where 'other' = any (r.reasons))                                     as other
  from courses c
  left join r on r.course = c.course
 group by c.course
 order by results desc, c.course;


-- @query comments
-- What students chose to send, newest first. May quote a lecture.
select created_at at time zone 'Australia/Sydney' as sent_at,
       coalesce(nullif(trim(course), ''), '(no course)') as course,
       rating,
       array_to_string(reasons, ', ') as reasons,
       comment
  from public.lecture_notes_feedback
 where occasion = 'rated' and comment is not null
 order by created_at desc
 limit 100;
