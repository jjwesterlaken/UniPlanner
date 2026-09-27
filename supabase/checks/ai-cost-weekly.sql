-- ---------------------------------------------------------------------
-- ai-cost-weekly.sql — does what we charge match what AI requests cost?
-- (1.3.1, migration 0024)
--
-- Run weekly in Supabase -> SQL editor, like essay-quality-weekly.sql:
-- each block is ONE self-contained SELECT headed `-- @query <name>`,
-- nothing writes, nothing is created, nothing needs editing.
--
-- WHAT IT COMPARES. Every task's price is derived from its CEILINGS —
-- full input at the character cap, full output at the token cap — so a
-- price is a bound on cost. This reads the provider's REAL token counts
-- (recorded per request since 0024) and asks where under the bound real
-- requests land.
--
--   usd            what one request cost us, at the called model's rates
--   credit value   credits charged x what one credit is worth (the value
--                  of a lecture minute, USD_PER_CREDIT) — the SAME unit,
--                  so cover = credit value / usd needs no constants here
--
-- cover BELOW 1 on a real n means a task costs us more than it charges
-- in credit value. That is not "loss-making" by itself — revenue per
-- credit depends on the tier, and each tier's margin is asserted in
-- test-readings.mjs — but it is the number the price was supposed to
-- keep at or above 1, measured rather than modelled.
--
-- near_ceiling is the share of requests whose OUTPUT reached 80% of the
-- task's cap: the ones closest to being truncated (a truncated reply is
-- a hard failure the student sees).
--
-- A null usd is a request whose provider call failed before a usage
-- block came back: an UNKNOWN cost, not a free one, counted separately
-- as unknown_cost and left out of every average rather than read as 0.
-- ---------------------------------------------------------------------


-- @query by_task
-- Per task and medium, the last 28 days: how many requests, how they
-- ended, what they really cost, and how the charge compares.
with rows as (
  select * from public.ai_task_costs where day >= (now() at time zone 'utc')::date - 27
)
select task,
       medium,
       count(*)                                                                    as requests,
       count(*) filter (where outcome = 'delivered')                               as delivered,
       count(*) filter (where credits_charged = 0)                                 as free,
       count(*) filter (where usd is null)                                         as unknown_cost,
       round((percentile_cont(0.5) within group (order by usd))::numeric, 6)       as median_usd,
       round((percentile_cont(0.95) within group (order by usd))::numeric, 6)      as p95_usd,
       round(max(usd)::numeric, 6)                                                 as max_usd,
       max(credits_charged) filter (where outcome = 'delivered')                   as price_credits,
       round((percentile_cont(0.5) within group (order by credits_charged * usd_per_credit / nullif(usd, 0))
               filter (where outcome = 'delivered'))::numeric, 2)                  as median_cover,
       round((min(credits_charged * usd_per_credit / nullif(usd, 0))
               filter (where outcome = 'delivered'))::numeric, 2)                  as worst_cover,
       round(100.0 * count(*) filter (where completion_tokens >= 0.8 * max_tokens)
             / nullif(count(*) filter (where completion_tokens is not null), 0), 1) as near_ceiling_pct
  from rows
 group by task, medium
 order by task, medium;


-- @query totals
-- The whole of the last 28 days, and the last 7: what we spent, what
-- we charged in credit value, and what we absorbed on free outcomes.
with rows as (
  select *, day >= (now() at time zone 'utc')::date - 6 as recent
    from public.ai_task_costs
   where day >= (now() at time zone 'utc')::date - 27
),
periods as (
  select 'last 28 days' as period, * from rows
  union all
  select 'last 7 days', * from rows where recent
)
select period,
       count(*)                                                              as requests,
       round(sum(usd)::numeric, 4)                                           as spent_usd,
       round(sum(credits_charged * usd_per_credit)::numeric, 4)             as charged_credit_value,
       round((sum(credits_charged * usd_per_credit) / nullif(sum(usd), 0))::numeric, 2) as cover,
       round(sum(usd) filter (where credits_charged = 0)::numeric, 4)        as absorbed_usd,
       count(*) filter (where usd is null)                                   as unknown_cost
  from periods
 group by period
 order by period desc;


-- @query free_outcomes
-- Where the free refusals spent money: per task and outcome, over the
-- last 28 days. These are costs we chose to absorb (a refusal caused by
-- our own model or checks is not charged); this says how much.
select task,
       outcome,
       count(*)                                    as requests,
       round(sum(usd)::numeric, 5)                 as absorbed_usd,
       count(*) filter (where usd is null)         as unknown_cost
  from public.ai_task_costs
 where credits_charged = 0
   and day >= (now() at time zone 'utc')::date - 27
 group by task, outcome
 order by absorbed_usd desc nulls last, task, outcome;
