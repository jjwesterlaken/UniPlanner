/* What one AI lecture note actually costs, measured from a real backup.

   CLAUDE.md records the AI-notes storage restructure as pending, with
   "the two-hour lecture test" as its trigger and every number so far
   modelled rather than observed. This is the instrument for replacing
   the estimate with the measurement.

   Usage:
     1. In the app: Account -> Backup -> "Save a backup". That downloads
        the whole planner as JSON, which is the same serialisation the
        sync path uses, so the byte counts here are the real ones.
     2. node scripts/measure-ai-notes.mjs <that-file>.json

   Read-only. It never writes anything and never phones anywhere. */

import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/measure-ai-notes.mjs <backup.json>");
  console.error("       (Account -> Backup -> Save a backup)");
  process.exit(1);
}

const KB = (n) => `${(n / 1024).toFixed(1)} KB`;
const bytes = (v) => Buffer.byteLength(JSON.stringify(v) || "");

const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
const data = parsed && parsed.data ? parsed.data : parsed;
if (!data || !data.semesters) {
  console.error("That doesn't look like a planner backup — no `semesters` key.");
  process.exit(1);
}

console.log(`Whole planner: ${KB(bytes(data))}\n`);

let anyFound = false;

for (const [semName, sem] of Object.entries(data.semesters)) {
  const pages = (sem.pages || []).filter((p) => p && !p.deletedAt);
  const aiPages = pages.filter((p) => p && p.aiMeta);
  if (aiPages.length === 0) continue;
  anyFound = true;

  console.log(`${semName}: ${aiPages.length} AI lecture note${aiPages.length === 1 ? "" : "s"}`);

  for (const page of aiPages) {
    const meta = page.aiMeta || {};
    const langs = Object.keys(meta.translations || {});
    /* The study cards a note produced are separate `notes` items. They
       are matched on course+week rather than by a parent id, because
       nothing records one -- so this is an estimate where a student has
       hand-written cards for the same week, and is flagged as such. */
    const cards = (sem.notes || []).filter(
      (n) => n && !n.deletedAt && n.course === meta.course && String(n.week) === String(meta.week)
    );
    const cardBytes = cards.reduce((a, c) => a + bytes(c), 0);

    console.log(`  ${page.title || "(untitled)"}`);
    console.log(`    page.body          ${KB(bytes(page.body || ""))}   ${page.body ? "(pre-dedup note)" : "(empty, as expected)"}`);
    console.log(`    page.aiMeta        ${KB(bytes(meta))}   languages: ${langs.join(", ") || "none"}`);
    console.log(`    page total         ${KB(bytes(page))}`);
    console.log(`    ${String(cards.length).padStart(2)} study cards      ${KB(cardBytes)}   (matched on course+week)`);
    console.log(`    NOTE TOTAL         ${KB(bytes(page) + cardBytes)}`);
    if (meta.capped) console.log(`    capped:            ${JSON.stringify(meta.capped)}`);
    console.log("");
  }
}

if (!anyFound) {
  console.log("No AI lecture notes in this backup (looking for pages with an `aiMeta` key).");
  process.exit(0);
}

/* Projection, so the measurement immediately answers the question it was
   taken to answer rather than needing a second pass. */
const all = Object.values(data.semesters).flatMap((sem) =>
  (sem.pages || [])
    .filter((p) => p && !p.deletedAt && p.aiMeta)
    .map((page) => {
      const meta = page.aiMeta || {};
      const cards = (sem.notes || []).filter(
        (n) => n && !n.deletedAt && n.course === meta.course && String(n.week) === String(meta.week)
      );
      return bytes(page) + cards.reduce((a, c) => a + bytes(c), 0);
    })
);
const avg = all.reduce((a, b) => a + b, 0) / all.length;

console.log(`Average per note: ${KB(avg)}   (projected after de-duplication: 6.1 KB, or 8.7 KB with a translation)\n`);
console.log("At that size, across two semesters, on top of a 672 KB populated account:");
console.log("  lectures/sem   AI notes    total      % of 1 MB budget");
for (const perSem of [12, 24, 36, 48, 60]) {
  const ai = avg * perSem * 2;
  const total = 672 * 1024 + ai;
  const pct = (total / (1024 * 1024)) * 100;
  const flag = pct > 100 ? "  BREACH" : "";
  console.log(
    `  ${String(perSem).padStart(3)}            ${KB(ai).padStart(8)}   ${KB(total).padStart(9)}   ${pct.toFixed(0).padStart(3)}%${flag}`
  );
}
