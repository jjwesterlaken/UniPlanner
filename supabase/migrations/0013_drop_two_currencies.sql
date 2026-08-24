-- Drops the two old allowance counters and the function that wrote them.
--
-- =====================================================================
-- DO NOT APPLY THIS UNTIL THE FUNCTIONS THAT USE THEM ARE NO LONGER
-- DEPLOYED. It NARROWS, so it goes AFTER the code that stopped needing
-- it — the opposite direction from 0012, and the direction 0008 got
-- wrong at real cost.
--
-- The order is:
--
--   1. apply 0012            (widens: credits_used and add_ai_credits)
--   2. deploy both functions (they now write credits_used)
--   3. verify a real action bills credits_used
--   4. apply THIS            (narrows: the old columns go)
--
-- Applied at step 1 instead, every bill fails: the deployed function
-- calls add_ai_usage, which no longer exists, and Supabase logs
-- "function does not exist" at the billing stage without failing the
-- request. The student gets their work and we charge nothing — safe for
-- them, expensive for us, and invisible unless somebody reads the logs.
-- =====================================================================

alter table public.ai_usage drop column if exists minutes_used;
alter table public.ai_usage drop column if exists text_units_used;

drop function if exists public.add_ai_usage(uuid, text, numeric, numeric);
