import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Service-role client — deliberately bypasses RLS. Used only for the
// tier/usage checks and the writes that RLS intentionally forbids from
// the client (ai_usage, ai_notes_requests, Storage object deletes).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected into every
// Edge Function's environment by Supabase — nothing to set manually.
export const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);
