/* What Storage will ACTUALLY take, measured by uploading it.

   THE FAILURE THIS EXISTS FOR. Supabase enforces the LOWER of two
   per-file limits: a project-global setting and the bucket's own, which
   cannot exceed the global. Raise the bucket alone and the number in
   the dashboard changes, the page looks right, and nothing else does —
   the global still binds. A document cannot prevent that, because the
   person reading it has already seen a number change and believes they
   are finished.

   So this does not read either setting. It uploads an object of exactly
   MAX_BODY_BYTES and one byte over, and reports what happened — the
   effective limit, which is the only thing a lecture actually meets.

   Run it after changing the dashboard, and after changing
   LECTURE_AUDIO_FILE_LIMIT_BYTES:

     SUPABASE_URL=... SUPABASE_KEY=<service role or a signed-in user's> \
       node scripts/check-storage-limit.mjs

   It uploads to the caller's own folder and deletes both objects
   afterwards. Deliberately NOT part of npm test: it is a check on
   deployment state rather than on code, it costs a real upload of tens
   of megabytes, and a suite that burns that on every push gets
   disabled. */

import process from "node:process";
import { MAX_BODY_BYTES, LECTURE_AUDIO_FILE_LIMIT_BYTES, LECTURE_AUDIO_BUCKET } from "../supabase/functions/ai-notes/config.ts";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_KEY;
if (!url || !key) {
  console.log("skip — set SUPABASE_URL and SUPABASE_KEY (service role, or a signed-in user's access token)");
  process.exit(0);
}

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

/* A folder the check owns, so nothing here can collide with a real
   recording or be mistaken for one by the orphan sweep. */
const folder = "storage-limit-check";

async function attempt(bytes, label) {
  const body = new Uint8Array(bytes);
  const name = `${folder}/${label}-${Date.now()}.webm`;
  const res = await fetch(`${url}/storage/v1/object/${LECTURE_AUDIO_BUCKET}/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "audio/webm", "x-upsert": "true" },
    body,
  });
  const text = await res.text().catch(() => "");
  if (res.ok) {
    await fetch(`${url}/storage/v1/object/${LECTURE_AUDIO_BUCKET}/${name}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${key}` },
    }).catch(() => {});
  }
  return { ok: res.ok, status: res.status, text: text.slice(0, 200) };
}

console.log(`bucket constant   ${mb(LECTURE_AUDIO_FILE_LIMIT_BYTES)}  (what config.ts believes the dashboard says)`);
console.log(`upload ceiling    ${mb(MAX_BODY_BYTES)}  (what the app enforces)\n`);

const atLimit = await attempt(MAX_BODY_BYTES, "at-ceiling");
console.log(`${mb(MAX_BODY_BYTES)} upload  → ${atLimit.ok ? "ACCEPTED" : `REJECTED ${atLimit.status} ${atLimit.text}`}`);

let over = null;
if (atLimit.ok) {
  over = await attempt(LECTURE_AUDIO_FILE_LIMIT_BYTES + 1_000_000, "over-bucket");
  console.log(
    `${mb(LECTURE_AUDIO_FILE_LIMIT_BYTES + 1_000_000)} upload  → ${over.ok ? "ACCEPTED" : `REJECTED ${over.status}`}` +
      "   (this one SHOULD be rejected)"
  );
}

console.log("");
if (!atLimit.ok) {
  console.log("FAIL — a lecture at the app's own ceiling cannot be uploaded.");
  console.log("       Raise BOTH: Settings → Storage → global upload limit, AND the lecture-audio bucket's own.");
  console.log("       The bucket cannot exceed the global, so raising only the bucket changes nothing.");
  process.exit(1);
}
if (over && over.ok) {
  console.log("WARNING — Storage accepted more than LECTURE_AUDIO_FILE_LIMIT_BYTES claims it allows.");
  console.log("          The constant is now UNDERSTATED, so the app is refusing uploads Storage would take.");
  console.log("          Raise it in supabase/functions/ai-notes/config.ts to match the dashboard.");
  process.exit(1);
}
console.log("OK — the effective limit clears the app's ceiling, and the constant is not overstated.");
