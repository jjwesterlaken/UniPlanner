-- ---------------------------------------------------------------------
-- essay-quality-weekly.sql — is essay feedback any good? (1.3.1)
--
-- Run weekly in Supabase -> SQL editor. Every block below is ONE
-- self-contained SELECT headed `-- @query <name>`: select a block and
-- run it, or run the whole file and read the result tabs in order.
-- Nothing here writes, nothing creates an object, and nothing needs
-- editing to run — the windows are computed from now().
--
-- WHY THERE IS NO VIEW. ESSAY-FEEDBACK.md used to suggest
-- `create or replace view essay_marks`. A view created in the SQL
-- editor lands in `public`, where the platform's default privileges
-- grant it to anon and authenticated (0008), and a view runs with its
-- OWNER's rights unless it is `security_invoker` — so it would have
-- served every student's ratings and marks to anyone holding the anon
-- key, through PostgREST, with RLS never consulted. Every query here
-- carries its own CTEs instead.
--
-- THE TABLE IS 0023's assessment_feedback. Three occasions:
--   delivered  one per successful run      the denominator
--   rated      one per run, if answered    yes / partly / no + reasons
--   on_mark    one per ASSESSMENT          rating, and mark + band only
--                                          if the student ticked
--
-- TWO THINGS THE RAW ROWS GET WRONG, and every query that joins marks
-- to runs deals with both. scripts/test-essay-quality.mjs seeds both
-- shapes and requires the counts below to come out right.
--
--  1. REDRAFTS. One assessment can have several delivered runs. Joining
--     an on_mark row to every delivered row for its assessment counts
--     one mark once PER RUN. The codes used are the LATEST run's — the
--     draft nearest to what was submitted; a problem the student fixed
--     in the redraft is not a problem the marker saw.
--
--  2. LINKED DRAFTS. A draft run from the AI tab is filed under a
--     placeholder and later linked to the real assessment; the mark
--     answer is then written ONCE PER ID it covers (markAnswerIds in
--     essayFeedback.js), so one mark can be two or three on_mark rows.
--     They are written in one loop, milliseconds apart, with identical
--     rating/reasons/mark/band. An "answer" below is a run of such rows
--     for one student within 60 seconds — and its codes come from the
--     latest run across all the ids it covers.
--
-- READ n BEFORE ANY PERCENTAGE. Every query prints its count beside
-- its rate. A gap computed from three essays is a number, not evidence
-- (ESSAY-FEEDBACK.md, "The query").
--
-- Comments are NOT printed by any query here. A comment is sent only
-- when the student ticked to send it, and it may quote their essay;
-- reading them is a deliberate act, so it is its own block at the end.
-- ---------------------------------------------------------------------


-- @query volume
-- Runs per Sydney week (Monday start), last 8 weeks, and how many of
-- that week's RUNS were ever rated — by the run's week, not the
-- rating's, so a Sunday run rated on Monday counts where it belongs.
with runs as (
  select user_id, run_id, created_at,
         date_trunc('week', created_at at time zone 'Australia/Sydney')::date as week
    from public.assessment_feedback
   where occasion = 'delivered'
     and created_at >= date_trunc('week', now() at time zone 'Australia/Sydney') at time zone 'Australia/Sydney' - interval '7 weeks'
),
rated as (
  select user_id, run_id from public.assessment_feedback where occasion = 'rated'
)
select r.week,
       count(*)                                                        as runs,
       count(distinct r.user_id)                                       as students,
       count(q.run_id)                                                 as runs_rated,
       round(100.0 * count(q.run_id) / nullif(count(*), 0), 1)         as rated_pct
  from runs r
  left join rated q on q.user_id = r.user_id and q.run_id = r.run_id
 group by r.week
 order by r.week desc;


-- @query rating_split
-- The "Was this useful?" answer on each result, per Sydney week of the
-- answer, with the all-time row first. rewrite_n is how many of those
-- ratings came after the student asked for an example rewrite.
with rated as (
  select rating, rewrite_requested,
         date_trunc('week', created_at at time zone 'Australia/Sydney')::date as week
    from public.assessment_feedback
   where occasion = 'rated'
),
windows as (
  select 'all time' as period, null::date as week, rating, rewrite_requested from rated
  union all
  select to_char(week, 'YYYY-MM-DD'), week, rating, rewrite_requested from rated
   where week >= (date_trunc('week', now() at time zone 'Australia/Sydney') - interval '7 weeks')::date
)
select period,
       count(*)                                                                     as n,
       count(*) filter (where rating = 'yes')                                       as yes,
       count(*) filter (where rating = 'partly')                                    as partly,
       count(*) filter (where rating = 'no')                                        as no,
       round(100.0 * count(*) filter (where rating = 'yes')    / nullif(count(*), 0), 1) as yes_pct,
       round(100.0 * count(*) filter (where rating = 'partly') / nullif(count(*), 0), 1) as partly_pct,
       round(100.0 * count(*) filter (where rating = 'no')     / nullif(count(*), 0), 1) as no_pct,
       count(*) filter (where rewrite_requested)                                    as rewrite_n
  from windows
 group by period, week
 order by week desc nulls first;


-- @query reasons
-- Why a result was only partly useful, or not. The denominator is the
-- number of partly/no ratings, so pct is "of the students who were not
-- satisfied, how many said this" — a rating can carry several reasons,
-- so the column does not sum to 100. Last 28 days beside all time.
with unhappy as (
  select rating, reasons, created_at
    from public.assessment_feedback
   where occasion = 'rated' and rating in ('partly', 'no')
),
totals as (
  select count(*) as all_n,
         count(*) filter (where created_at >= now() - interval '28 days') as recent_n
    from unhappy
)
select reason,
       count(*)                                                          as n,
       count(*) filter (where u.rating = 'partly')                       as from_partly,
       count(*) filter (where u.rating = 'no')                           as from_no,
       round(100.0 * count(*) / nullif(t.all_n, 0), 1)                   as pct_of_unhappy,
       count(*) filter (where u.created_at >= now() - interval '28 days') as n_28d,
       round(100.0 * count(*) filter (where u.created_at >= now() - interval '28 days') / nullif(t.recent_n, 0), 1)
                                                                         as pct_28d,
       t.all_n                                                           as unhappy_total
  from unhappy u
 cross join totals t
 cross join lateral unnest(u.reasons) as reason
 group by reason, t.all_n, t.recent_n
 order by n desc, reason;


-- @query by_code
-- Per deficiency code: how often we raise it, and how students rated
-- the results that raised it — beside the SAME rate for rated results
-- that did not (the control). A code whose yes_pct sits well below
-- yes_pct_without, on a real n, is a code students think we get wrong.
with delivered as (
  select deficiency_codes from public.assessment_feedback where occasion = 'delivered'
),
rated as (
  select rating, deficiency_codes from public.assessment_feedback where occasion = 'rated'
),
codes as (
  select distinct unnest(deficiency_codes) as code from delivered
)
select c.code,
       (select count(*) from delivered d where c.code = any(d.deficiency_codes))          as runs_raising,
       round(100.0 * (select count(*) from delivered d where c.code = any(d.deficiency_codes))
             / nullif((select count(*) from delivered), 0), 1)                            as pct_of_runs,
       count(*) filter (where c.code = any(r.deficiency_codes))                          as rated_with,
       round(100.0 * count(*) filter (where c.code = any(r.deficiency_codes) and r.rating = 'yes')
             / nullif(count(*) filter (where c.code = any(r.deficiency_codes)), 0), 1)    as yes_pct_with,
       round(100.0 * count(*) filter (where c.code = any(r.deficiency_codes) and r.rating = 'no')
             / nullif(count(*) filter (where c.code = any(r.deficiency_codes)), 0), 1)    as no_pct_with,
       count(*) filter (where not (c.code = any(r.deficiency_codes)))                    as rated_without,
       round(100.0 * count(*) filter (where not (c.code = any(r.deficiency_codes)) and r.rating = 'yes')
             / nullif(count(*) filter (where not (c.code = any(r.deficiency_codes))), 0), 1) as yes_pct_without
  from codes c
  left join rated r on true
 group by c.code
 order by runs_raising desc, c.code;


-- @query mark_gap
-- THE MARK COMPARISON. Answers where the student shared the mark, with
-- the codes on the latest run they cover. For each code: the marks of
-- essays we flagged against the marks of essays we did not. A positive
-- gap is the claim the feature makes — flagged essays scored lower.
-- Read n_flagged and n_clear before gap.
with marks as (
  select user_id, assessment_id, rating, reasons, mark, band, created_at
    from public.assessment_feedback
   where occasion = 'on_mark'
),
edges as (
  select m.*,
         case when lag(created_at) over w is null
                or created_at - lag(created_at) over w > interval '60 seconds'
                or (rating, reasons, mark, band) is distinct from lag((rating, reasons, mark, band)) over w
              then 1 else 0 end as starts
    from marks m
  window w as (partition by user_id order by created_at)
),
grouped as (
  select *, sum(starts) over (partition by user_id order by created_at rows unbounded preceding) as grp from edges
),
answers as (
  select user_id, grp, min(rating) as rating, min(mark) as mark, array_agg(assessment_id) as ids
    from grouped
   group by user_id, grp
),
shared as (
  select a.user_id, a.mark,
         (select d.deficiency_codes
            from public.assessment_feedback d
           where d.occasion = 'delivered' and d.user_id = a.user_id and d.assessment_id = any(a.ids)
           order by d.created_at desc
           limit 1) as codes
    from answers a
   where a.mark is not null
),
codes as (
  select distinct unnest(codes) as code from shared
)
select c.code,
       count(*) filter (where c.code = any(s.codes))                                   as n_flagged,
       round(avg(s.mark) filter (where c.code = any(s.codes)), 1)                      as avg_flagged,
       count(*) filter (where not (c.code = any(s.codes)))                             as n_clear,
       round(avg(s.mark) filter (where not (c.code = any(s.codes))), 1)                as avg_clear,
       round(avg(s.mark) filter (where not (c.code = any(s.codes)))
           - avg(s.mark) filter (where c.code = any(s.codes)), 1)                      as gap,
       min(s.mark) filter (where c.code = any(s.codes))                                as lo_flagged,
       max(s.mark) filter (where c.code = any(s.codes))                                as hi_flagged
  from codes c
 cross join shared s
 group by c.code
 order by gap desc nulls last, c.code;


-- @query mark_answers
-- How many mark answers there are, deduplicated, and how many shared
-- the mark. rows is the raw on_mark count; answers is what it means.
-- If rows runs well ahead of answers, students are linking drafts.
with marks as (
  select user_id, rating, reasons, mark, band, created_at
    from public.assessment_feedback
   where occasion = 'on_mark'
),
edges as (
  select m.*,
         case when lag(created_at) over w is null
                or created_at - lag(created_at) over w > interval '60 seconds'
                or (rating, reasons, mark, band) is distinct from lag((rating, reasons, mark, band)) over w
              then 1 else 0 end as starts
    from marks m
  window w as (partition by user_id order by created_at)
),
answers as (
  select user_id, sum(starts) over (partition by user_id order by created_at rows unbounded preceding) as grp, rating, mark
    from edges
)
select (select count(*) from marks)                                        as rows,
       count(distinct (user_id, grp))                                      as answers,
       count(distinct (user_id, grp)) filter (where mark is not null)      as shared_mark,
       count(distinct (user_id, grp)) filter (where rating = 'yes')        as yes,
       count(distinct (user_id, grp)) filter (where rating = 'partly')     as partly,
       count(distinct (user_id, grp)) filter (where rating = 'no')         as no
  from answers;


-- @query before_after
-- Did the mark change the student's mind? For each mark answer: how
-- they rated the latest run it covers when they first read it, against
-- how they rated the feedback once the mark was back. 'not rated' is a
-- run they never answered "Was this useful?" on.
with marks as (
  select user_id, assessment_id, rating, reasons, mark, band, created_at
    from public.assessment_feedback
   where occasion = 'on_mark'
),
edges as (
  select m.*,
         case when lag(created_at) over w is null
                or created_at - lag(created_at) over w > interval '60 seconds'
                or (rating, reasons, mark, band) is distinct from lag((rating, reasons, mark, band)) over w
              then 1 else 0 end as starts
    from marks m
  window w as (partition by user_id order by created_at)
),
grouped as (
  select *, sum(starts) over (partition by user_id order by created_at rows unbounded preceding) as grp from edges
),
answers as (
  select user_id, grp, min(rating) as after_mark, array_agg(assessment_id) as ids
    from grouped
   group by user_id, grp
),
paired as (
  select a.after_mark,
         coalesce((select q.rating
                     from public.assessment_feedback q
                    where q.occasion = 'rated' and q.user_id = a.user_id
                      and q.run_id = (select d.run_id
                                        from public.assessment_feedback d
                                       where d.occasion = 'delivered' and d.user_id = a.user_id and d.assessment_id = any(a.ids)
                                       order by d.created_at desc
                                       limit 1)), 'not rated') as on_reading
    from answers a
)
select on_reading, after_mark, count(*) as n
  from paired
 group by on_reading, after_mark
 order by on_reading, after_mark;


-- @query comments
-- DELIBERATE: the comments students chose to send, newest first. They
-- may quote the student's own essay — read them here, do not export or
-- paste them anywhere else.
select created_at at time zone 'Australia/Sydney' as sydney_time, occasion, rating, reasons, comment
  from public.assessment_feedback
 where comment is not null
 order by created_at desc
 limit 50;
