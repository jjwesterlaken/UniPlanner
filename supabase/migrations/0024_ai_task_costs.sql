-- ---------------------------------------------------------------------
-- 0024: ai_task_costs — what a text AI request REALLY cost us.
--
-- Every ai-text task is priced from its CEILINGS: full input at the
-- character cap, full output at the token cap (TASK_CREDITS =
-- creditsFor(usdForTask(task)), config.ts). That is a bound, and
-- nothing recorded where under it real requests land, because
-- openai.ts read `choices[0]` and discarded the provider's `usage`.
-- A price set from an unmeasured number is a guess however carefully
-- it was derived (TYPICAL_SUMMARY_OUTPUT_TOKENS: modelled at 2,800,
-- measured at 475). RELEASE-1.3.1.md §2; ruled go by Jared, 27
-- September 2026.
--
-- ONE ROW PER PROVIDER CALL: the task, the medium, the model, the
-- provider's own token counts, the ceiling that applied, what that cost
-- us at the model's published rates, what one credit is worth, what the
-- student was charged, and how the request ended. Refusals that are
-- free still spent money, which is exactly what this is for, so every
-- outcome after the provider call is recorded — not only successes.
--
-- NO user_id AND NO CONTENT, and that is the decision to read. This is
-- a question about the product's arithmetic, not about any student:
-- nothing here needs to know whose request it was, so nothing here can
-- say. No text, no prompt, no result, no ids. The day stands in for a
-- timestamp, so a row cannot be matched to an ai_usage increment by
-- time either. With no account identifier there is nothing for account
-- deletion to cover — the function_errors arrangement (0022), and both
-- published documents say so in their not-covered sections.
--
-- WRITTEN THROUGH AN RPC, NOT .from(). ai-text carries a source-level
-- invariant that no `.from(...)` names a table other than `profiles`
-- and `ai_usage` — which is what lets that endpoint skip the whole
-- "exists but isn't yours" class. An RPC keeps that invariant literally
-- true. Execute is granted to service_role ONLY, and revoked from anon
-- by name as well as from public, because revoking from public does
-- not remove a role-specific default grant (0016).
--
-- BOUNDED: the error-digest function purges rows older than
-- AI_TASK_COST_RETENTION_DAYS (90) on every daily run, beside its own
-- function_errors purge. CLAUDE.md's rule — anything that grows on a
-- schedule of its own needs something that clears it.
--
-- IT WIDENS, so it is applied BEFORE the ai-text deploy that calls it.
-- A function deployed first gets "function does not exist" on every
-- record, which is swallowed by design (a diagnostic must never cost a
-- student a result they paid for), so nothing would look wrong and
-- nothing would be recorded.
-- ---------------------------------------------------------------------

create table if not exists public.ai_task_costs (
  id bigint generated always as identity primary key,
  -- A day, not a timestamp: enough for a weekly query, too coarse to
  -- line a row up with anyone's usage increment.
  day date not null default ((now() at time zone 'utc')::date),
  fn text not null check (fn in ('ai-text')),
  task text not null check (char_length(task) between 1 and 32),
  medium text not null check (medium in ('text', 'photos')),
  model text not null check (char_length(model) between 1 and 64),
  -- The provider's own counts. Null when the call failed before a
  -- usage block came back, which is a real outcome and worth a row.
  prompt_tokens integer check (prompt_tokens between 0 and 10000000),
  completion_tokens integer check (completion_tokens between 0 and 10000000),
  -- Reasoning models bill reasoning as output; it is INSIDE
  -- completion_tokens, and kept separately to see how much of it there is.
  reasoning_tokens integer check (reasoning_tokens between 0 and 10000000),
  -- The output ceiling this request ran under.
  max_tokens integer not null check (max_tokens between 1 and 1000000),
  -- What the tokens cost at the model's published rates, and what one
  -- credit is worth, both at write time — so the weekly query needs no
  -- constants and a later price change does not rewrite history.
  usd numeric check (usd >= 0 and usd < 100),
  usd_per_credit numeric not null check (usd_per_credit > 0 and usd_per_credit < 1),
  -- What the student was charged for this request: 0 for every free
  -- outcome, the task's price otherwise.
  credits_charged integer not null check (credits_charged between 0 and 1000),
  -- How the request ended: 'delivered', or the response code.
  outcome text not null check (char_length(outcome) between 1 and 40),
  finish_reason text check (char_length(finish_reason) <= 32)
);

alter table public.ai_task_costs enable row level security;

-- No policies for either client role, and no grants: the service role
-- writes (through the function below) and the SQL editor reads.
revoke all on public.ai_task_costs from anon, authenticated;

create index if not exists ai_task_costs_day_idx on public.ai_task_costs (day desc);

comment on table public.ai_task_costs is
  'One row per ai-text provider call: task, medium, model, the provider''s token counts, the ceiling, the cost at published rates, the value of a credit, the credits charged and the outcome. No account identifier and no content — see 0024''s header. Written by record_ai_task_cost() from the service role; purged after 90 days by the error-digest function.';

create or replace function public.record_ai_task_cost(
  p_fn text,
  p_task text,
  p_medium text,
  p_model text,
  p_prompt_tokens integer,
  p_completion_tokens integer,
  p_reasoning_tokens integer,
  p_max_tokens integer,
  p_usd numeric,
  p_usd_per_credit numeric,
  p_credits_charged integer,
  p_outcome text,
  p_finish_reason text
)
returns void
language sql
set search_path = ''
as $$
  insert into public.ai_task_costs (
    fn, task, medium, model, prompt_tokens, completion_tokens, reasoning_tokens,
    max_tokens, usd, usd_per_credit, credits_charged, outcome, finish_reason
  ) values (
    p_fn, p_task, p_medium, p_model, p_prompt_tokens, p_completion_tokens, p_reasoning_tokens,
    p_max_tokens, p_usd, p_usd_per_credit, p_credits_charged, p_outcome, p_finish_reason
  );
$$;

revoke all on function public.record_ai_task_cost(text, text, text, text, integer, integer, integer, integer, numeric, numeric, integer, text, text) from public;
revoke all on function public.record_ai_task_cost(text, text, text, text, integer, integer, integer, integer, numeric, numeric, integer, text, text) from anon, authenticated;
grant execute on function public.record_ai_task_cost(text, text, text, text, integer, integer, integer, integer, numeric, numeric, integer, text, text) to service_role;

comment on function public.record_ai_task_cost(text, text, text, text, integer, integer, integer, integer, numeric, numeric, integer, text, text) is
  'Records one ai-text provider call''s cost (0024). Service role only.';

-- ---------------------------------------------------------------------
-- The self-check (0016): an apply cannot report success while the end
-- state is wrong. One DO block, so a failure rolls the probes back too.
-- ---------------------------------------------------------------------
do $$
declare
  checked int := 0;
  n int;
  sig constant text := 'public.record_ai_task_cost(text, text, text, text, integer, integer, integer, integer, numeric, numeric, integer, text, text)';
begin
  if pg_catalog.to_regclass('public.ai_task_costs') is null then
    raise exception '0024 FAILED: public.ai_task_costs does not exist.';
  end if;
  checked := checked + 1;

  if not exists (select 1 from pg_catalog.pg_class where oid = 'public.ai_task_costs'::regclass and relrowsecurity) then
    raise exception '0024 FAILED: row level security is not enabled on ai_task_costs.';
  end if;
  checked := checked + 1;

  if has_table_privilege('anon', 'public.ai_task_costs', 'select')
     or has_table_privilege('authenticated', 'public.ai_task_costs', 'select')
     or has_table_privilege('anon', 'public.ai_task_costs', 'insert')
     or has_table_privilege('authenticated', 'public.ai_task_costs', 'insert') then
    raise exception '0024 FAILED: anon or authenticated can read or write ai_task_costs.';
  end if;
  checked := checked + 1;

  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'ai_task_costs') then
    raise exception '0024 FAILED: ai_task_costs has a policy, so some client role is expected to reach it.';
  end if;
  checked := checked + 1;

  -- NO ACCOUNT COLUMN AND NO CONTENT COLUMN, asserted rather than left
  -- to the header: the day either appears, account deletion and both
  -- published documents have to change, and this is where that is found.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_task_costs'
       and column_name in ('user_id', 'app_user_id', 'text', 'prompt', 'result', 'content', 'body')
  ) then
    raise exception '0024 FAILED: ai_task_costs has an account or content column — see this migration''s header.';
  end if;
  checked := checked + 1;

  -- The function is reachable by the writer and by nobody else. The oid
  -- form, because the text form RAISES on an absent function (0016).
  if to_regprocedure(sig) is null then
    raise exception '0024 FAILED: record_ai_task_cost() does not exist.';
  end if;
  if not has_function_privilege('service_role', to_regprocedure(sig), 'execute') then
    raise exception '0024 FAILED: service_role cannot execute record_ai_task_cost().';
  end if;
  if has_function_privilege('anon', to_regprocedure(sig), 'execute')
     or has_function_privilege('authenticated', to_regprocedure(sig), 'execute') then
    raise exception '0024 FAILED: a client role can execute record_ai_task_cost(), so anyone could fill the table.';
  end if;
  checked := checked + 1;

  -- BEHAVIOURAL: a row really lands through the function, and the
  -- bounds really refuse a nonsense one.
  perform public.record_ai_task_cost('ai-text', 'explain', 'text', 'probe-model', 10, 20, null, 400, 0.0001, 0.0007, 1, 'delivered', 'stop');
  select count(*) into n from public.ai_task_costs where model = 'probe-model';
  if n <> 1 then
    raise exception '0024 FAILED: record_ai_task_cost() did not write a row.';
  end if;
  checked := checked + 1;

  begin
    perform public.record_ai_task_cost('ai-text', 'explain', 'audio', 'probe-model', 10, 20, null, 400, 0.0001, 0.0007, 1, 'delivered', 'stop');
    raise exception '0024 FAILED: an unknown medium was accepted, so the column bounds are not enforced.';
  exception when check_violation then null;
  end;
  checked := checked + 1;

  delete from public.ai_task_costs where model = 'probe-model';

  if checked <> 8 then
    raise exception '0024 FAILED: only % of 8 properties were checked.', checked;
  end if;

  raise notice '0024 applied and verified: % properties checked.', checked;
end;
$$;
