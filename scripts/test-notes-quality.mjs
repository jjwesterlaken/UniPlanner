/* test-notes-quality.mjs — the weekly lecture-notes queries give the
   right answers, and the closed reason set agrees on all three sides.

   supabase/checks/notes-quality-weekly.sql is run by hand in the SQL
   editor, so each block is run here against a database with every
   migration applied (essay-quality's arrangement), over a fixture whose
   expected figures are worked out by hand beside it.

   It also holds the 0026 <-> client agreements: the reason ids in the
   migration's CHECK, in notesFeedback.js, in the copy, and in the
   query's reason_set are one list, and the row builders never carry a
   field 0026 does not have.

   WHAT IT CANNOT SEE: whether a rating means anything, and whether a
   course label is the same course as another. That is a person. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPgHarness } from "./lib/pg-harness.mjs";
import { NOTES_REASONS, notesDeliveredRow, notesRatedRow, ratable, MAX_COURSE_CHARS } from "../src/notesFeedback.js";
import { AI_NOTES_COPY } from "../src/aiNotesCopy.js";
import { RATINGS, MAX_COMMENT_CHARS } from "../src/essayFeedback.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const migrationsDir = path.join(rootDir, "supabase", "migrations");
/* Comments stripped: 0026's header quotes `reasons <@ array[...]`
   while explaining it, and a match on the comment reads nothing. */
const migration = fs.readFileSync(path.join(migrationsDir, "0026_lecture_notes_feedback.sql"), "utf8").replace(/--.*$/gm, "");
const checkFile = path.join(rootDir, "supabase", "checks", "notes-quality-weekly.sql");
const source = fs.readFileSync(checkFile, "utf8");

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

const quoted = (s) => [...s.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);

/* ---------------- pure: no database needed ---------------- */

await test("the reason set is ONE list: migration CHECK, client, copy and the query's reason_set agree", () => {
  const inCheck = quoted(migration.match(/reasons <@ array\[([^\]]+)\]/)[1]);
  const inQuery = quoted(source.match(/reason_set\(reason\) as \(([\s\S]*?)\n\)/)[1]);
  assert.ok(NOTES_REASONS.length === 6, "the order named six reasons");
  assert.deepEqual(inCheck, [...NOTES_REASONS]);
  assert.deepEqual(inQuery, [...NOTES_REASONS]);
  assert.deepEqual(Object.keys(AI_NOTES_COPY.rating.reasons), [...NOTES_REASONS]);
});

await test("the ratings and the comment bound are the essay capture's, and 0026's", () => {
  assert.deepEqual(Object.keys(AI_NOTES_COPY.rating.ratings), [...RATINGS]);
  assert.match(migration, new RegExp(`char_length\\(comment\\) <= ${MAX_COMMENT_CHARS}\\)`));
  assert.match(migration, new RegExp(`char_length\\(course\\) <= ${MAX_COURSE_CHARS}\\)`));
});

await test("a row carries only 0026's columns — nothing from the lecture, no idempotency key", () => {
  const table = migration.match(/create table if not exists public\.lecture_notes_feedback \(([\s\S]*?)\n\);/)[1];
  const columns = [...table.matchAll(/^\s{2}([a-z_]+) (?:text|uuid|timestamptz)/gm)].map((m) => m[1]);
  assert.ok(columns.length >= 8, `found only ${columns.length} columns, so the parse is wrong`);
  const d = notesDeliveredRow({ id: "a", userId: "u", runId: "r", course: " PSYC1001 " });
  const q = notesRatedRow({ id: "b", userId: "u", runId: "r", course: "", rating: "no", reasons: ["too-long", "bogus", "too-long"], comment: "x", sendComment: false });
  for (const row of [d, q]) for (const k of Object.keys(row)) assert.ok(columns.includes(k), `${k} is not a 0026 column`);
  assert.equal(d.course, "PSYC1001");
  assert.equal(q.course, null, "a blank course is null, not an empty label");
  assert.deepEqual(q.reasons, ["too-long"], "an unknown reason or a duplicate reached a row");
  assert.equal(q.comment, null, "an unticked comment travelled");
  assert.ok(!/idempotency|transcript|summary|title/i.test(table.replace(/--.*$/gm, "")), "0026 grew a column that can carry the lecture");
});

await test("a yes carries no reasons, a ticked comment is trimmed and bounded, a non-rating throws", () => {
  const y = notesRatedRow({ id: "b", userId: "u", runId: "r", rating: "yes", reasons: ["too-long"], comment: "  hi  ", sendComment: true });
  assert.deepEqual(y.reasons, []);
  assert.equal(y.comment, "hi");
  const long = notesRatedRow({ id: "b", userId: "u", runId: "r", rating: "no", comment: "z".repeat(900), sendComment: true });
  assert.equal(long.comment.length, MAX_COMMENT_CHARS);
  assert.throws(() => notesRatedRow({ id: "b", userId: "u", runId: "r", rating: "meh" }));
});

await test("a failed summary is not ratable; notes are", () => {
  assert.equal(ratable({ summaryFailed: true, original: null }), false);
  assert.equal(ratable(null), false);
  assert.equal(ratable({ original: { overview: "x" } }), true);
});

/* ---------------- the queries, against postgres ---------------- */

const blocks = Object.fromEntries(
  source
    .split(/^-- @query /m)
    .slice(1)
    .map((chunk) => [chunk.slice(0, chunk.indexOf("\n")).trim(), chunk.slice(chunk.indexOf("\n") + 1)])
);
const EXPECTED_QUERIES = ["volume", "rating_split", "reasons", "by_course", "comments"];

const U = (n) => `00000000-0000-4000-8000-00000000f0${String(n).padStart(2, "0")}`;
const row = (o) => {
  const lit = (v) => (v === null || v === undefined ? "null" : Array.isArray(v) ? `'{${v.join(",")}}'` : `'${String(v).replace(/'/g, "''")}'`);
  const cols = Object.keys(o);
  return `insert into public.lecture_notes_feedback (${cols.join(", ")}) values (${cols.map((c) => (c === "created_at" ? `now() - interval '${o[c]}'` : lit(o[c]))).join(", ")});`;
};

/* THE FIXTURE, all within the last two days.
   u1 PSYC1001  r1 rated partly (too-long, wrong-terms), comment sent
                r2 rated no (too-long)
   u2 psyc1001  r3 rated yes                   — same course, other case
   u2 (none)    r4 unrated
   u3 HIST2002  r5 rated partly (missed-assessable)
   Five results, four rated: 1 yes, 2 partly, 1 no. Unhappy = 3. */
const FIXTURE = [
  `insert into auth.users (id) values ('${U(1)}'), ('${U(2)}'), ('${U(3)}');`,
  row({ id: "n-d1", user_id: U(1), run_id: "r1", course: "PSYC1001", occasion: "delivered", created_at: "2 days" }),
  row({ id: "n-q1", user_id: U(1), run_id: "r1", course: "PSYC1001", occasion: "rated", rating: "partly", reasons: ["too-long", "wrong-terms"], comment: "the definitions were off", created_at: "2 days" }),
  row({ id: "n-d2", user_id: U(1), run_id: "r2", course: "PSYC1001", occasion: "delivered", created_at: "1 day" }),
  row({ id: "n-q2", user_id: U(1), run_id: "r2", course: "PSYC1001", occasion: "rated", rating: "no", reasons: ["too-long"], created_at: "1 day" }),
  row({ id: "n-d3", user_id: U(2), run_id: "r3", course: "psyc1001 ", occasion: "delivered", created_at: "1 day" }),
  row({ id: "n-q3", user_id: U(2), run_id: "r3", course: "psyc1001 ", occasion: "rated", rating: "yes", created_at: "1 day" }),
  row({ id: "n-d4", user_id: U(2), run_id: "r4", occasion: "delivered", created_at: "1 day" }),
  row({ id: "n-d5", user_id: U(3), run_id: "r5", course: "HIST2002", occasion: "delivered", created_at: "1 day" }),
  row({ id: "n-q5", user_id: U(3), run_id: "r5", course: "HIST2002", occasion: "rated", rating: "partly", reasons: ["missed-assessable"], created_at: "1 day" }),
].join("\n");

const pg = createPgHarness({ migrationsDir, label: "the lecture-notes quality query tests" });

async function run() {
  if (!pg.available) {
    pg.skipOrFail();
    return;
  }
  pg.start();
  const db = pg.freshDb();
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) pg.applyMigration(db, file);
  pg.psqlOrThrow(db, FIXTURE);

  const q = (name) => {
    assert.ok(blocks[name], `no "-- @query ${name}" block in notes-quality-weekly.sql`);
    const out = pg.psqlOrThrow(db, blocks[name]).out;
    return out ? out.split("\n").map((l) => l.split("|")) : [];
  };
  const by = (rows) => Object.fromEntries(rows.map((r) => [r[0], r]));

  await test("the file holds exactly the named queries, and runs whole without writing anything", () => {
    assert.deepEqual(Object.keys(blocks), EXPECTED_QUERIES);
    assert.doesNotMatch(source.replace(/--.*$/gm, ""), /\b(insert|update|delete|create|alter|drop|grant|truncate)\b/i);
    const before = pg.psqlOrThrow(db, "select count(*) from public.lecture_notes_feedback").out;
    pg.psqlOrThrow(db, source);
    assert.equal(pg.psqlOrThrow(db, "select count(*) from public.lecture_notes_feedback").out, before);
    assert.equal(before, "9", "the fixture did not land whole");
  });

  await test("VOLUME: five results by three students, four rated", () => {
    const rows = q("volume");
    const sum = (i) => rows.reduce((t, r) => t + Number(r[i]), 0);
    assert.ok(rows.length >= 1);
    assert.deepEqual([sum(1), sum(3)], [5, 4]);
  });

  await test("RATING SPLIT: all time is 1 yes, 2 partly, 1 no", () => {
    const rows = q("rating_split");
    assert.equal(rows[0][0], "all time");
    assert.deepEqual(rows[0].slice(1), ["4", "1", "2", "1", "25.0", "50.0", "25.0"]);
  });

  await test("REASONS: every reason listed, too-long on 2 of 3 unhappy, unchosen ones at zero", () => {
    const r = by(q("reasons"));
    assert.deepEqual(Object.keys(r).sort(), [...NOTES_REASONS].sort(), "a reason nobody chose vanished instead of reading zero");
    assert.deepEqual(r["too-long"].slice(1), ["2", "1", "1", "66.7", "2", "3"]);
    assert.deepEqual(r["too-short"].slice(1, 2), ["0"]);
  });

  await test("BY COURSE: PSYC1001 and psyc1001 are one course; the unlabelled result is its own row", () => {
    const r = by(q("by_course"));
    assert.deepEqual(Object.keys(r).sort(), ["(no course)", "hist2002", "psyc1001"]);
    /* course, results, students, rated, yes, partly, no, too_long, too_short, missed, wrong_terms, structure, other */
    assert.deepEqual(r.psyc1001.slice(1), ["3", "2", "3", "1", "1", "1", "2", "0", "0", "1", "0", "0"]);
    assert.deepEqual(r["(no course)"].slice(1, 4), ["1", "1", "0"], "an unrated course must show zero rated, not vanish");
  });

  await test("COMMENTS: only what was sent, and nothing else in the file prints one", () => {
    const rows = q("comments");
    assert.equal(rows.length, 1);
    assert.equal(rows[0][4], "the definitions were off");
    for (const name of EXPECTED_QUERIES.filter((n) => n !== "comments")) {
      assert.doesNotMatch(blocks[name].replace(/--.*$/gm, ""), /\bcomment\b/, `${name} reads the comment column`);
    }
  });
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    if (pg.stop) pg.stop();
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  });
