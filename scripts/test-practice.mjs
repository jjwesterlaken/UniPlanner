/* Practice attempts: what a session stores, and what it deliberately
   doesn't.

   The claims worth reading are "the questions are never stored" and
   "pruning clears its own tombstones" -- both are things the blob
   budget and the sync design have already been bitten by once.

   Run via `npm test`. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAttempt,
  pruneAttempts,
  weakTopics,
  practiceSummary,
  ATTEMPT_WINDOW_DAYS,
  MAX_ATTEMPTS,
} from "../src/practice.js";
import { COLLECTIONS, COUNTABLE_COLLECTIONS } from "../src/sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${err.message}`);
  }
}

let n = 0;
const uid = () => `a${n++}`;
const dayAgo = (d) => new Date(Date.now() - d * 86400_000).toISOString();

async function main() {
  await test("an attempt records what happened, never the questions", () => {
    /* A set of eight questions with answers is ~2.5KB and goes stale the
       moment a card is edited. The attempt is ~90 bytes and doesn't. */
    const a = buildAttempt({ cardIds: ["c1", "c2", "c3"], correctIds: ["c1", "c3"], at: dayAgo(0), uid });
    assert.deepEqual(Object.keys(a).sort(), ["at", "cardIds", "correct", "id", "missedIds", "total"]);
    assert.equal(a.correct, 2);
    assert.equal(a.total, 3);
    assert.deepEqual(a.missedIds, ["c2"]);
    const serialised = JSON.stringify(a);
    assert.ok(!/question|answer|\?/.test(serialised), `a question reached the stored attempt: ${serialised}`);
    assert.ok(serialised.length < 250, `an attempt is ${serialised.length} bytes; it must stay small enough to keep`);
  });

  await test("practiceAttempts is in COLLECTIONS, or every attempt is dropped on sync", () => {
    // mergeSemester rebuilds each semester from that whitelist alone, so
    // a collection missing from it works locally, works in demo mode,
    // and vanishes on a second device.
    assert.ok(COLLECTIONS.includes("practiceAttempts"));
  });

  await test("practice attempts do not count towards the backup panel's item total", () => {
    /* The total is meant to answer "how much of my work is in here".
       Counting a log of answered questions alongside someone's
       assignments inflates it in the direction that reassures. */
    assert.ok(COLLECTIONS.includes("practiceAttempts"), "it still has to sync");
    assert.ok(!COUNTABLE_COLLECTIONS.includes("practiceAttempts"), "but it is not the student's work");
  });

  await test("attempts outside the window are pruned, tombstones and all", () => {
    /* purgeOldTombstones runs only on sync and restore, so a collection
       that prunes on its own schedule must clear its own tombstones --
       otherwise a signed-out student accumulates them forever. */
    const kept = { id: "k", at: dayAgo(3), cardIds: [], missedIds: [], correct: 0, total: 0 };
    const old = { id: "o", at: dayAgo(ATTEMPT_WINDOW_DAYS + 5), cardIds: [], missedIds: [], correct: 0, total: 0 };
    const oldTombstone = { ...old, id: "ot", deletedAt: dayAgo(ATTEMPT_WINDOW_DAYS + 4) };

    const out = pruneAttempts([kept, old, oldTombstone], { now: new Date().toISOString() });
    assert.deepEqual(out.map((a) => a.id), ["k"]);
    assert.ok(
      !out.some((a) => a.deletedAt),
      "a tombstone for a row outside the window has nothing left to suppress and must go with it"
    );
  });

  await test("a runaway loop is bounded even inside the window", () => {
    const many = Array.from({ length: MAX_ATTEMPTS + 50 }, (_, i) => ({
      id: `x${i}`,
      at: dayAgo(1),
      cardIds: [],
      missedIds: [],
      correct: 0,
      total: 0,
    }));
    assert.equal(pruneAttempts(many, { now: new Date().toISOString() }).length, MAX_ATTEMPTS);
  });

  await test("weak topics are derived, and a card missed once is not one", () => {
    const cards = [
      { id: "c1", term: "Osmosis", content: "water across a membrane" },
      { id: "c2", term: "Tonicity", content: "relative solute concentration" },
    ];
    const attempts = [
      { id: "a1", at: dayAgo(1), missedIds: ["c1", "c2"] },
      { id: "a2", at: dayAgo(2), missedIds: ["c1"] },
    ];
    const out = weakTopics({ attempts, cards });
    assert.deepEqual(out.map((t) => t.term), ["Osmosis"], "one miss is a bad day, not a weak spot");
    assert.equal(out[0].lapses, 2);
  });

  await test("a deleted card is never resurrected as a weak spot", () => {
    /* A student who deleted a card has said they are done with it.
       Listing it would be the app arguing with them -- and it would leak
       the term of something they removed. */
    const cards = [{ id: "c1", term: "Osmosis", content: "x", deletedAt: dayAgo(1) }];
    const attempts = [
      { id: "a1", at: dayAgo(2), missedIds: ["c1"] },
      { id: "a2", at: dayAgo(3), missedIds: ["c1"] },
    ];
    assert.deepEqual(weakTopics({ attempts, cards }), []);
  });

  await test("a tombstoned attempt is not counted", () => {
    const cards = [{ id: "c1", term: "Osmosis", content: "x" }];
    const attempts = [
      { id: "a1", at: dayAgo(1), missedIds: ["c1"] },
      { id: "a2", at: dayAgo(2), missedIds: ["c1"], deletedAt: dayAgo(1) },
    ];
    assert.deepEqual(weakTopics({ attempts, cards }), [], "a deleted attempt must not still shape the digest");
  });

  await test("the summary reads as nothing at all before any practice", () => {
    // Rendering "0 of 0 right (NaN%)" from an empty semester is the exact
    // shape that has crashed demo mode before.
    assert.equal(practiceSummary([]), "");
    assert.equal(practiceSummary([{ id: "a", at: dayAgo(1), correct: 0, total: 0 }]), "");
  });

  await test("the summary counts only live attempts", () => {
    const out = practiceSummary([
      { id: "a1", at: dayAgo(1), correct: 3, total: 4 },
      { id: "a2", at: dayAgo(2), correct: 0, total: 4, deletedAt: dayAgo(1) },
    ]);
    assert.match(out, /3 of 4 right across 1 practice set \(75%\)/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

await main();
