/* MOVED to `supabase/functions/_shared/noWriting.js`, so the essay
   endpoint (Deno) runs the same check the harness measured, and
   re-exported here so every existing import keeps working. The
   essaySchema.js arrangement: one module, three readers. */
export * from "../supabase/functions/_shared/noWriting.js";
