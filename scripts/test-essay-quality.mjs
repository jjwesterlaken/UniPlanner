/* test-essay-quality.mjs — the weekly essay-feedback queries give the
   right answers on the shapes that make the raw rows wrong.

   supabase/checks/essay-quality-weekly.sql is run by hand in the SQL
   editor, and a query nobody can check is a query whose numbers are
   believed because they print. So each block is run here against a
   database with every migration applied, over a fixture chosen for the
   two traps the file's header names:

     REDRAFTS      one assessment, two runs. A naive join counts its
                   mark twice and uses both runs' codes.
     LINKED DRAFTS one mark written as two on_mark rows (the placeholder
                   and the real assessment, markAnswerIds). A naive
                   count sees two answers.

   Every expected figure is worked out by hand from the fixture in the
   comment beside it, and several are chosen to DIFFER from what the
   naive query would give — n_clear for evidence-thin is 1 here and 2
   with the linked mark double-counted, so a regression to the naive
   shape goes red rather than agreeing by accident.

   WHAT IT CANNOT SEE: whether the numbers mean anything. That is the
   n-before-percentage rule in the file, and a person. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPgHarness } from "./lib/pg-harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const migrationsDir = path.join(rootDir, "supabase", "migrations");
const checkFile = path.join(rootDir, "supabase", "checks", "essay-quality-weekly.sql");

const pg = createPgHarness({ migrationsDir, label: "the essay quality query tests" });
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

/* The file, split at its markers. */
const source = fs.readFileSync(checkFile, "utf8");
const blocks = Object.fromEntries(
  source
    .split(/^-- @query /m)
    .slice(1)
    .map((chunk) => {
      const name = chunk.slice(0, chunk.indexOf("\n")).trim();
      return [name, chunk.slice(chunk.indexOf("\n") + 1)];
    })
);
const EXPECTED_QUERIES = ["volume", "rating_split", "reasons", "by_code", "mark_gap", "mark_answers", "before_after", "comments"];

const U = (n) => `00000000-0000-4000-8000-00000000e0${String(n).padStart(2, "0")}`;
/* EVERY OFFSET IS SCALED INTO THE CURRENT SYDNEY WEEK. The fixture says
   "one week" and the volume and rating_split assertions count week
   rows, but "3 days ago" is LAST week from Monday to Wednesday — so this
   file failed three days in seven, by the calendar, with nothing wrong.
   The offsets are shrunk by (time since this Sydney Monday / 4 days),
   capped at 1, which keeps their order and their relative spacing and
   puts every row inside this week whatever day it is. */
const SCALE = `least(1.0, extract(epoch from (now() - (date_trunc('week', now() at time zone 'Australia/Sydney') at time zone 'Australia/Sydney'))) / (4 * 86400.0))`;
const row = (o) => {
  const lit = (v) => (v === null || v === undefined ? "null" : Array.isArray(v) ? `'{${v.join(",")}}'` : typeof v === "boolean" || typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
  const cols = Object.keys(o);
  return `insert into public.assessment_feedback (${cols.join(", ")}) values (${cols.map((c) => (c === "created_at" ? `now() - interval '${o[c]}' * ${SCALE}` : lit(o[c]))).join(", ")});`;
};

/* THE FIXTURE, all within the last week so every window sees it.
   u1  A1 redrafted: r1 {thesis-unclear, evidence-thin} rated no
       (too-vague), r2 {evidence-thin} rated yes; mark 55, shared, yes.
   u2  placeholder P1 run r3 {thesis-unclear} rated partly
       (missed-things, not-my-rubric) after a rewrite; real R1 run r4
       {structure-weak}, LATER, unrated; one mark answer 60 shared,
       partly (missed-things), written as TWO rows 10 ms apart.
   u3  A3 run r5 {thesis-unclear} rated yes, with a sent comment; mark
       answered yes, NOT shared.
   u4  A4 run r6 {structure-weak}, never rated, never marked. */
const FIXTURE = [
  ...[1, 2, 3, 4].map((n) => `insert into auth.users (id) values ('${U(n)}');`),
  row({ id: "f-d1", user_id: U(1), assessment_id: "A1", run_id: "r1", occasion: "delivered", deficiency_codes: ["thesis-unclear", "evidence-thin"], created_at: "3 days" }),
  row({ id: "f-q1", user_id: U(1), assessment_id: "A1", run_id: "r1", occasion: "rated", rating: "no", reasons: ["too-vague"], deficiency_codes: ["thesis-unclear", "evidence-thin"], created_at: "3 days" }),
  row({ id: "f-d2", user_id: U(1), assessment_id: "A1", run_id: "r2", occasion: "delivered", deficiency_codes: ["evidence-thin"], created_at: "2 days" }),
  row({ id: "f-q2", user_id: U(1), assessment_id: "A1", run_id: "r2", occasion: "rated", rating: "yes", deficiency_codes: ["evidence-thin"], created_at: "2 days" }),
  row({ id: "f-m1", user_id: U(1), assessment_id: "A1", occasion: "on_mark", rating: "yes", mark: 55, band: "Pass", created_at: "1 day" }),

  row({ id: "f-d3", user_id: U(2), assessment_id: "P1", run_id: "r3", occasion: "delivered", deficiency_codes: ["thesis-unclear"], created_at: "3 days" }),
  row({ id: "f-q3", user_id: U(2), assessment_id: "P1", run_id: "r3", occasion: "rated", rating: "partly", reasons: ["missed-things", "not-my-rubric"], rewrite_requested: true, deficiency_codes: ["thesis-unclear"], created_at: "3 days" }),
  row({ id: "f-d4", user_id: U(2), assessment_id: "R1", run_id: "r4", occasion: "delivered", deficiency_codes: ["structure-weak"], created_at: "2 days" }),
  row({ id: "f-m2", user_id: U(2), assessment_id: "R1", occasion: "on_mark", rating: "partly", reasons: ["missed-things"], mark: 60, band: "Credit", created_at: "1 day" }),
  row({ id: "f-m3", user_id: U(2), assessment_id: "P1", occasion: "on_mark", rating: "partly", reasons: ["missed-things"], mark: 60, band: "Credit", created_at: "1 day - 10 milliseconds" }),

  row({ id: "f-d5", user_id: U(3), assessment_id: "A3", run_id: "r5", occasion: "delivered", deficiency_codes: ["thesis-unclear"], created_at: "3 days" }),
  row({ id: "f-q5", user_id: U(3), assessment_id: "A3", run_id: "r5", occasion: "rated", rating: "yes", comment: "helpful on the intro", deficiency_codes: ["thesis-unclear"], created_at: "3 days" }),
  row({ id: "f-m5", user_id: U(3), assessment_id: "A3", occasion: "on_mark", rating: "yes", created_at: "1 day" }),

  row({ id: "f-d6", user_id: U(4), assessment_id: "A4", run_id: "r6", occasion: "delivered", deficiency_codes: ["structure-weak"], created_at: "2 days" }),
].join("\n");

async function run() {
  pg.start();
  const db = pg.freshDb();
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) pg.applyMigration(db, file);
  pg.psqlOrThrow(db, FIXTURE);

  /* Rows as arrays of strings, one per output line; psql -A -t, pipe-separated. */
  const q = (name) => {
    assert.ok(blocks[name], `no "-- @query ${name}" block in essay-quality-weekly.sql`);
    const out = pg.psqlOrThrow(db, blocks[name]).out;
    return out ? out.split("\n").map((l) => l.split("|")) : [];
  };
  const by = (rows, key) => Object.fromEntries(rows.map((r) => [r[key], r]));

  await test("the file holds exactly the named queries, and runs whole without writing anything", () => {
    assert.deepEqual(Object.keys(blocks), EXPECTED_QUERIES);
    assert.doesNotMatch(source.replace(/--.*$/gm, ""), /\b(insert|update|delete|create|alter|drop|grant|truncate)\b/i, "a read-only check file contains a write");
    const before = pg.psqlOrThrow(db, "select count(*) from public.assessment_feedback").out;
    pg.psqlOrThrow(db, source);
    assert.equal(pg.psqlOrThrow(db, "select count(*) from public.assessment_feedback").out, before);
    assert.equal(before, "14", "the fixture did not land whole");
  });

  await test("VOLUME: six runs by four students, four of them rated — by the run, not the rating", () => {
    const rows = q("volume");
    assert.equal(rows.length, 1, `the fixture is one week, got ${rows.length} week rows`);
    const [, runs, students, rated, pct] = rows[0];
    assert.deepEqual([runs, students, rated, pct], ["6", "4", "4", "66.7"]);
  });

  await test("RATING SPLIT: 2 yes, 1 partly, 1 no, and the one partly came after a rewrite", () => {
    const rows = q("rating_split");
    assert.equal(rows[0][0], "all time", "the all-time row is not first");
    assert.deepEqual(rows[0].slice(1), ["4", "2", "1", "1", "50.0", "25.0", "25.0", "1"]);
    assert.equal(rows.length, 2, "one all-time row and one week row");
    assert.deepEqual(rows[1].slice(1), rows[0].slice(1), "the week row disagrees with all time over a one-week fixture");
  });

  await test("REASONS: denominated by the two unhappy ratings, so each reason is 50%", () => {
    const r = by(q("reasons"), 0);
    assert.deepEqual(Object.keys(r).sort(), ["missed-things", "not-my-rubric", "too-vague"]);
    assert.deepEqual(r["too-vague"].slice(1), ["1", "0", "1", "50.0", "1", "50.0", "2"]);
    assert.deepEqual(r["missed-things"].slice(1, 4), ["1", "1", "0"]);
    /* The on_mark row's missed-things is NOT a rating of a result and is not counted here. */
  });

  await test("BY CODE: thesis-unclear is raised on 3 of 6 runs; its results rated 1/3 yes against 1/1 without", () => {
    const r = by(q("by_code"), 0);
    assert.deepEqual(r["thesis-unclear"].slice(1), ["3", "50.0", "3", "33.3", "33.3", "1", "100.0"]);
    assert.deepEqual(r["evidence-thin"].slice(1), ["2", "33.3", "2", "50.0", "50.0", "2", "50.0"]);
    assert.deepEqual(r["structure-weak"].slice(1, 4), ["2", "33.3", "0"], "an unrated code must show zero rated, not vanish");
  });

  await test("MARK GAP: the redraft's LATEST codes, the linked mark ONCE — evidence-thin 55 vs 60, gap 5", () => {
    const r = by(q("mark_gap"), 0);
    assert.deepEqual(Object.keys(r).sort(), ["evidence-thin", "structure-weak"], "thesis-unclear was only on superseded runs and must not appear");
    /* n_clear is 1: with the linked mark counted twice it would be 2. */
    assert.deepEqual(r["evidence-thin"].slice(1), ["1", "55.0", "1", "60.0", "5.0", "55", "55"]);
    assert.deepEqual(r["structure-weak"].slice(1, 6), ["1", "60.0", "1", "55.0", "-5.0"]);
  });

  await test("MARK ANSWERS: four rows are three answers, two of them sharing the mark", () => {
    assert.deepEqual(q("mark_answers")[0], ["4", "3", "2", "2", "1", "0"]);
  });

  await test("BEFORE/AFTER: pairs each answer with the rating of the LATEST run it covers", () => {
    const rows = q("before_after").map((r) => r.join("|"));
    /* u1: r2 yes -> yes. u2: r4 is later than r3 and unrated -> partly. u3: r5 yes -> yes. */
    assert.deepEqual(rows, ["not rated|partly|1", "yes|yes|2"]);
  });

  await test("COMMENTS: only what was sent, and nothing else in the file prints one", () => {
    const rows = q("comments");
    assert.equal(rows.length, 1);
    assert.equal(rows[0][4], "helpful on the intro");
    for (const name of EXPECTED_QUERIES.filter((n) => n !== "comments")) {
      assert.doesNotMatch(blocks[name].replace(/--.*$/gm, ""), /\bcomment\b/, `${name} reads the comment column`);
    }
  });

  await test("THE TRAPS ARE REAL: the naive join the old doc used gets both wrong on this fixture", () => {
    /* ESSAY-FEEDBACK.md's original essay_marks view, as a CTE. If it
       gave the same answers the fixture would not be testing anything. */
    const naive = pg.psqlOrThrow(
      db,
      `select count(*) from public.assessment_feedback a
         join public.assessment_feedback d on d.user_id = a.user_id and d.assessment_id = a.assessment_id and d.occasion = 'delivered'
        where a.occasion = 'on_mark' and a.mark is not null;`
    ).out;
    assert.equal(naive, "4", "the naive join no longer over-counts this fixture, so it proves nothing");
    assert.equal(q("mark_answers")[0][2], "2");
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
