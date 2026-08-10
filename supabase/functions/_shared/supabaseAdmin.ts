import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

/* Service-role client — deliberately bypasses RLS. Used only for the
   tier/usage checks and the writes that RLS intentionally forbids from
   the client (ai_usage, ai_notes_requests, Storage object deletes).
   SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected into every
   Edge Function's environment by Supabase — nothing to set manually.

   WHY THIS IS BUILT LAZILY
   ------------------------
   It used to be constructed at module scope:

     export const supabaseAdmin = createClient(
       Deno.env.get("SUPABASE_URL")!,
       Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
     );

   The `!` is a TypeScript assertion and does nothing at runtime, so if
   either variable is missing, createClient throws "supabaseKey is
   required." while the module is still being evaluated — before
   Deno.serve has registered a handler. That failure happens outside the
   handler's try/catch, so nothing the function logs ever runs: every
   request 500s and the logs show only boot and shutdown. It is invisible
   in exactly the way that costs the most time.

   Deferring construction to first use means the handler's env_check runs
   first and can name the missing variable. The Proxy keeps every existing
   call site (`supabaseAdmin.from(...)`, `.storage`, `.auth`) unchanged. */

let client: SupabaseClient | null = null;

/** Builds the client on demand. Throws only once the caller actually uses it. */
export function getSupabaseAdmin(): SupabaseClient {
  if (client) return client;
  const url = Deno.env.get("SUPABASE_URL") || "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  // Named, not valued — this message reaches logs and must stay safe.
  if (!url) throw new Error("SUPABASE_URL is not set in this function's environment");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set in this function's environment");
  client = createClient(url, key);
  return client;
}

export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const real = getSupabaseAdmin();
    // deno-lint-ignore no-explicit-any
    const value = (real as any)[prop];
    return typeof value === "function" ? value.bind(real) : value;
  },
});
