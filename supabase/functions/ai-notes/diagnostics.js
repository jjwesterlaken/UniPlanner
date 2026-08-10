/* Failure diagnostics for the ai-notes function.

   Plain JS with no Deno globals so scripts/test-ai-notes.mjs can exercise
   it directly — anything reading the environment takes a getter.

   The problem this exists for: a failure used to leave no server-side
   trace at all. One catch at the bottom of the handler returned
   `server_error` and logged an object, and every intermediate catch
   returned a message without logging anything, so "it returns 500" was
   the entire available evidence.

   SECRETS RULE: names and presence booleans only. Never a value, never a
   JWT, never transcript text. `redact` below is the backstop for the one
   realistic leak — a provider error quoting the signed audio URL, which
   carries an access token in its query string. */

/** Ordered stages a request passes through. The label travels into the logs and the error response. */
export const STAGES = [
  "env_check",
  "client_init",
  "auth_user",
  "tier_lookup",
  "idempotency_insert",
  "size_guard",
  "signed_url",
  "transcribe",
  "summarise",
  "billing",
];

/* Environment the function cannot run without.

   SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the platform
   rather than set by hand, which is exactly why a missing one is so
   confusing when it happens: nobody remembers configuring them. A project
   migrated to the newer `sb_secret_*` API keys can end up without the
   legacy service-role variable populated. */
export const CORE_ENV = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];

/** Env var holding each transcription provider's key. Mirrors config.ts. */
export const PROVIDER_KEY_ENV = { groq: "GROQ_API_KEY", deepgram: "DEEPGRAM_API_KEY" };

/**
 * Which variables this request actually needs.
 *
 * Only the *resolved* provider's key is required: demanding
 * DEEPGRAM_API_KEY on a Groq deployment would fail a perfectly working
 * install, and the setup docs say Deepgram's key is optional.
 */
export function requiredEnvNames(provider) {
  const providerKey = PROVIDER_KEY_ENV[provider] || PROVIDER_KEY_ENV.groq;
  return [...CORE_ENV, providerKey, "OPENAI_API_KEY"];
}

/** Names of the required variables that are missing or blank. Never values. */
export function missingEnv(names, getEnv) {
  return (names || []).filter((name) => {
    const value = getEnv(name);
    return typeof value !== "string" || value.trim() === "";
  });
}

/** Presence map for logging — booleans only, so it is always safe to print. */
export function envPresence(names, getEnv) {
  const out = {};
  for (const name of names || []) {
    const value = getEnv(name);
    out[name] = typeof value === "string" && value.trim() !== "";
  }
  return out;
}

/* Strips anything that could carry a credential out of text destined for
   the logs. Query strings go because the signed audio URL puts its access
   token there; long unbroken tokens go because that is the shape of a key
   or a JWT. */
export function redact(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]*/gi, "$1?[redacted]")
    .replace(/\b(eyJ[A-Za-z0-9_-]{10,})\b/g, "[redacted-jwt]")
    .replace(/\b(sb_secret_|sb_publishable_|sk-|gsk_)[A-Za-z0-9_-]{6,}/g, "$1[redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted-token]");
}

/** Error reduced to the three fields worth having, redacted. */
export function describeError(err) {
  if (err === null || err === undefined) return { name: "None", message: "", stack: "" };
  if (typeof err !== "object") return { name: typeof err, message: redact(String(err)), stack: "" };
  return {
    name: redact(String(err.name || err.code || "Error")),
    message: redact(String(err.message || err.error_description || err.error || "")),
    stack: redact(String(err.stack || "")),
  };
}

/**
 * The single structured line written whenever a request fails.
 *
 * One line rather than several so a failure can't be half-reported when
 * the runtime tears down mid-request, and prefixed so it's greppable in
 * the Supabase log viewer.
 */
export function failureLine(stage, err, extra = {}) {
  const { name, message, stack } = describeError(err);
  return `ai-notes FAILURE ${JSON.stringify({ stage, name, message, stack, ...extra })}`;
}

/** Entry marker for a stage, so the logs show how far a request got. */
export function stageLine(stage, extra = {}) {
  return `ai-notes stage ${JSON.stringify({ stage, ...extra })}`;
}
