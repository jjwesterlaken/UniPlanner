/* Which prompt the no-writing measurement runs under.

   IT FOLLOWS `buildMessages`, NOT A PROMPT STRING. The first version
   of this read `prompts.SYSTEM.essay` — and SYSTEM is a MODULE LOCAL
   in ai-text/prompts.js, not an export — so the follow could never
   have fired, and the harness would have used its own candidate for
   ever while printing a line saying it would not.

   It lives here, taking the prompts module as an ARGUMENT, so the
   choice is a function a test can drive with a fake rather than a
   line a test can only grep for. A source grep asserting "the call is
   present" passes on a script that makes the call and ignores it —
   which is exactly what the mutation check found. */

export function resolveEssayMessages({ prompts, essay, criteria, candidate }) {
  const fallback = {
    build: () => candidate({ essay, criteria }),
    source: "the CANDIDATE in this script (ai-text/prompts.js has no essay task yet)",
  };
  if (!prompts || typeof prompts.buildMessages !== "function") return fallback;
  try {
    /* buildMessages THROWS for an unknown task, which is what makes
       this exact rather than a guess about shape. */
    const probe = prompts.buildMessages("essay", { text: essay, criteria });
    if (!Array.isArray(probe) || probe.length === 0) return fallback;
    return {
      build: () => prompts.buildMessages("essay", { text: essay, criteria }),
      source: 'buildMessages("essay") in supabase/functions/ai-text/prompts.js',
    };
  } catch (e) {
    return fallback;
  }
}
