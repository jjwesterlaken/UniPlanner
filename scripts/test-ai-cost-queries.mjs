/* test-ai-cost-queries.mjs — the weekly cost queries give the right
   answers, on a database with every migration applied.

   supabase/checks/ai-cost-weekly.sql is run by hand, and a number that
   is only ever printed is a number that is believed because it prints.
   So every block runs here over a fixture worked out by hand, chosen for
   the three things that make a naive version wrong:

     UNKNOWN IS NOT FREE  a failed call has usd null; averaging it as 0
                          would drag every median down
     THE WINDOW           a 40-day-old row must be outside every figure,
                          and a 10-day-old one inside 28 days but not 7
     COVER ON DELIVERED   free refusals charge 0 by design, so a cover
                          computed over them would read as a loss

   WHAT IT CANNOT SEE: whether the provider's usage block is right, and
   whether our rates are the provider's. Those are the adapter tests and
   COST-MODEL.md. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPgHarness } from "./lib/pg-harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const migrationsDir = path.join(rootDir, "supabase", "migrations");
const checkFile = path.join(rootDir, "supabase", "checks", "ai-cost-weekly.sql");

const pg = createPgHarness({ migrationsDir, label: "the AI cost query tests" });
if (!pg.available) pg.skipOrFail();

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") throw new Error("this runner is synchronous; an async test would pass before it asserted");
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${err.message}`);
  }
}

const source = fs.readFileSync(checkFile, "utf8");
const blocks = Object.fromEntries(
  source
    .split(/^-- @query /m)
    .slice(1)
    .map((chunk) => [chunk.slice(0, chunk.indexOf("\n")).trim(), chunk.slice(chunk.indexOf("\n") + 1)])
);

/* One credit is worth 0.0007 throughout, so every cover is checkable by eye. */
const row = ({ ago = 0, task, medium = "text", completion, max, usd, credits, outcome }) =>
  `insert into public.ai_task_costs (day, fn, task, medium, model, prompt_tokens, completion_tokens, max_tokens, usd, usd_per_credit, credits_charged, outcome)
   values ((now() at time zone 'utc')::date - ${ago}, 'ai-text', '${task}', '${medium}', 'm', ${completion === null ? "null" : 100}, ${completion === null ? "null" : completion}, ${max}, ${usd === null ? "null" : usd}, 0.0007, ${credits}, '${outcome}');`;

const FIXTURE = [
  row({ task: "explain", completion: 100, max: 400, usd: 0.0002, credits: 1, outcome: "delivered" }), // cover 3.5
  row({ task: "explain", completion: 350, max: 400, usd: 0.0007, credits: 1, outcome: "delivered" }), // cover 1.0, near ceiling
  row({ task: "explain", completion: null, max: 400, usd: null, credits: 0, outcome: "provider_failed" }), // unknown, not free
  row({ task: "explain", completion: 50, max: 400, usd: 0.0003, credits: 0, outcome: "ai_failed" }), // absorbed
  row({ task: "merge", completion: 900, max: 1000, usd: 0.002, credits: 2, outcome: "delivered" }), // cover 0.7, near ceiling
  row({ ago: 10, task: "merge", completion: 400, max: 1000, usd: 0.001, credits: 2, outcome: "delivered" }), // cover 1.4, 28d only
  row({ task: "summarise", medium: "photos", completion: 1500, max: 2000, usd: 0.01, credits: 18, outcome: "pages_unreadable" }),
  row({ ago: 40, task: "explain", completion: 399, max: 400, usd: 1.0, credits: 1, outcome: "delivered" }), // outside every window
].join("\n");

/* RECORDINGS (recording_lengths). minutes_billed is the credits charged,
   max(minutes, 3). Two at the floor, two between 3 and 50, two at 50 or
   more — and three rows the block must NOT count: one still processing,
   one with no charge recorded, one from ten days ago. */
const REC_USER = "00000000-0000-4000-8000-0000000c0571";
const rec = (n, credits, { status = "done", ago = "1 day" } = {}) =>
  `insert into public.ai_notes_requests (idempotency_key, user_id, status, result, minutes_billed, created_at)
   values ('00000000-0000-4000-8000-${String(n).padStart(12, "0")}', '${REC_USER}', '${status}', '{"transcript":"never read"}', ${credits === null ? "null" : credits}, now() - interval '${ago}');`;
const RECORDINGS = [
  `insert into auth.users (id) values ('${REC_USER}');`,
  rec(1, 3),
  rec(2, 3),
  rec(3, 10),
  rec(4, 49.9),
  rec(5, 50),
  rec(6, 120),
  rec(7, 30, { status: "processing" }),
  rec(8, null),
  rec(9, 30, { ago: "10 days" }),
].join("\n");

async function run() {
  pg.start();
  const db = pg.freshDb();
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) pg.applyMigration(db, file);
  pg.psqlOrThrow(db, FIXTURE);
  pg.psqlOrThrow(db, RECORDINGS);

  const q = (name) => {
    assert.ok(blocks[name], `no "-- @query ${name}" block in ai-cost-weekly.sql`);
    const out = pg.psqlOrThrow(db, blocks[name]).out;
    return out ? out.split("\n").map((l) => l.split("|")) : [];
  };

  await test("the file holds exactly the named queries and writes nothing", () => {
    assert.deepEqual(Object.keys(blocks), ["by_task", "totals", "free_outcomes", "recording_lengths"]);
    assert.doesNotMatch(source.replace(/--.*$/gm, ""), /\b(insert|update|delete|create|alter|drop|grant|truncate)\b/i);
    pg.psqlOrThrow(db, source);
    assert.equal(pg.psqlOrThrow(db, "select count(*) from public.ai_task_costs").out, "8", "the fixture did not land whole");
  });

  await test("BY TASK: an unknown cost is left out of the averages, and cover is read on delivered requests only", () => {
    const r = Object.fromEntries(q("by_task").map((x) => [`${x[0]}/${x[1]}`, x.slice(2)]));
    assert.deepEqual(Object.keys(r), ["explain/text", "merge/text", "summarise/photos"]);
    /* explain: 4 requests (the 40-day row is outside), median over the three KNOWN costs. */
    assert.deepEqual(r["explain/text"], ["4", "2", "2", "1", "0.000300", "0.000660", "0.000700", "1", "2.25", "1.00", "33.3"]);
    /* merge: the one below 1, and it shows as worst_cover. */
    assert.deepEqual(r["merge/text"], ["2", "2", "0", "0", "0.001500", "0.001950", "0.002000", "2", "1.05", "0.70", "50.0"]);
    /* A billed refusal is not delivered, so it gives no price and no cover. */
    assert.deepEqual(r["summarise/photos"], ["1", "0", "0", "0", "0.010000", "0.010000", "0.010000", "", "", "", "0.0"]);
  });

  await test("TOTALS: 7 and 28 days differ by exactly the 10-day row; what was absorbed is the known free spend", () => {
    const rows = q("totals");
    assert.deepEqual(rows.map((x) => x[0]), ["last 7 days", "last 28 days"]);
    assert.deepEqual(rows[0].slice(1), ["6", "0.0132", "0.0154", "1.17", "0.0003", "1"]);
    assert.deepEqual(rows[1].slice(1), ["7", "0.0142", "0.0168", "1.18", "0.0003", "1"]);
  });

  await test("FREE OUTCOMES: the absorbed spend by outcome, with the unknown one counted rather than read as zero", () => {
    assert.deepEqual(q("free_outcomes").map((x) => x.join("|")), ["explain|ai_failed|1|0.00030|0", "explain|provider_failed|1||1"]);
  });

  await test("RECORDING LENGTHS: done, charged, last 7 days, in three buckets — and the processing, uncharged and old rows left out", () => {
    const rows = q("recording_lengths");
    assert.deepEqual(
      rows.map((x) => x.join("|")),
      [
        "1. floor (3 credits, up to 3 min)|2|33.3|6",
        "2. over 3, under 50 min (below cost)|2|33.3|60",
        "3. 50 min or more (at or above cost)|2|33.3|170",
      ]
    );
  });

  await test("RECORDING LENGTHS reads minutes_billed and nothing else off a row that holds a whole lecture", () => {
    const sql = blocks.recording_lengths.replace(/--.*$/gm, "");
    const fromRequests = sql.slice(sql.indexOf("select"), sql.indexOf("from public.ai_notes_requests"));
    assert.match(fromRequests, /minutes_billed/);
    assert.doesNotMatch(sql, /\bresult\b|transcript|select\s+\*|\w\.\*/, "the recording block selects a column that can hold lecture content");
  });

  await test("THE TRAPS ARE REAL: reading null as 0, or cover over every outcome, gives different answers on this fixture", () => {
    const naiveMedian = pg.psqlOrThrow(
      db,
      "select round((percentile_cont(0.5) within group (order by coalesce(usd, 0)))::numeric, 6) from public.ai_task_costs where task = 'explain' and day > (now() at time zone 'utc')::date - 28;"
    ).out;
    assert.notEqual(naiveMedian, "0.000300", "treating unknown as free gives the same median, so the fixture proves nothing");
    const naiveWorst = pg.psqlOrThrow(
      db,
      "select round(min(credits_charged * usd_per_credit / nullif(usd, 0))::numeric, 2) from public.ai_task_costs where task = 'explain' and day > (now() at time zone 'utc')::date - 28;"
    ).out;
    assert.equal(naiveWorst, "0.00", "cover over free outcomes should read as a total loss here — the control");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  if (passed === 0) {
    console.error("no results at all — treating that as a failure");
    process.exit(1);
  }
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pg.stop && pg.stop());
