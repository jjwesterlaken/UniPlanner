/* ==================================================================
   config.js — your server settings

   The Project URL below is already filled in for your Supabase project.
   You only need to paste your key.

   Supabase now calls this the "Publishable key" (it used to be called
   the anon key — same thing, just renamed). Find it at:
     Supabase dashboard -> Settings -> API Keys -> Publishable key
   It starts with  sb_publishable_

   ⚠️  Never paste the "Secret key" here. That one bypasses all your
   database security rules and must only ever live on a server.
   ================================================================== */

export const SUPABASE_URL = "https://kuhtogvewcooigudmgwj.supabase.co";
export const SUPABASE_ANON_KEY = "PASTE_YOUR_PUBLISHABLE_KEY_HERE";

/* --------------------------------------------------------------
   Is it safe to have these in the app?

   Yes. The publishable key is designed to be public and ships inside
   every Supabase app. On its own it grants no access to anything.

   What actually protects the data is Row Level Security, which you
   switched on with the setup SQL. The database itself refuses to hand
   back any row that doesn't belong to the signed-in user.
   -------------------------------------------------------------- */

/** True once a real key has been pasted in above. */
export const isConfigured =
  !SUPABASE_URL.startsWith("PASTE_") && !SUPABASE_ANON_KEY.startsWith("PASTE_");
