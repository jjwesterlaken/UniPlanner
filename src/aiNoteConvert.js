/* ==================================================================
   aiNoteConvert.js — an AI lecture note becomes an ordinary note

   A lecture note is read-only. The model gets things wrong, a student
   knows what the lecturer actually said, and until now there was
   nowhere to put the correction: `aiMeta` routes a page to
   AiLectureNoteView, which renders and offers no editor.

   Converting rewrites the page as an ordinary note — html and body,
   the shape every other note has — so the editor takes it from there.
   Pure, with the clock injected, so the awkward cases are exercised
   from Node rather than from a browser.

   THREE THINGS THE CONVERSION MUST NOT DO, and each is a rule this
   codebase has already paid for somewhere else:

   1. IT MUST NOT CONVERT WITHOUT THE CONTENT IN HAND. `fetchNote` has
      three outcomes and only one of them is knowledge: `{content}`,
      `{missing}` and `{failed}`. Converting on anything but the first
      writes an EMPTY note over a stub whose row still holds the whole
      lecture — the content survives on the server with nothing left in
      the blob pointing a reader at it, which is the same silence a
      dropped connection produces and is indistinguishable from the
      student having lost the note. So `convertPatch` REFUSES rather
      than trusting its caller: a UI that greys out the button is one
      refactor from converting an empty note, and the refactor need not
      touch this file.

   2. IT MUST NOT REMOVE `aiMeta`. Dropping it is the tempting tidy-up
      — the note is an ordinary note now, so why keep the marker? —
      and it is the archive section's absolute rule one feature over:
      `reconcilePlan` recognises a tombstoned stub BY `aiMeta`, so a
      converted note that is later deleted would leave its `ai_notes`
      row on the server for ever, with nothing pointing at it and
      nothing able to find it. The privacy policy says a student's
      notes are theirs until they delete them; a row nobody can reach
      is the other half of that promise broken.

   3. IT MUST NOT DELETE THE ROW. The row holds EVERY language. A
      student reading the Spanish converts the Spanish; the English is
      still in the row and is not in the blob, so deleting the row to
      "clean up" discards a copy the student never asked to lose. The
      cost of keeping it is that the converted language now exists
      twice — once in the row, once in the blob — and that cost is the
      point of the feature rather than a defect in it: an edited note
      has to live in the blob, because that is the only thing that
      syncs and merges per item.

   WHICH LANGUAGE. The one being read. `activeLanguage` is what the
   viewer renders and what the student is looking at when the thought
   "that is wrong" occurs, so it is the copy the correction belongs
   to. Converting all of them would produce one note holding two
   languages end to end, which is not a thing anybody asked for.
   ================================================================== */

/**
 * Plain text made safe to render as HTML.
 *
 * It lives here rather than beside its other caller because the
 * conversion made a second copy tempting, and two escapes are two
 * chances for one of them to miss a character. PlannerApp imports it.
 */
export function escapeHtml(text) {
  return String(text || "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

/** True once a lecture note has been rewritten as an ordinary note. */
export const isConverted = (page) => !!(page && page.aiMeta && page.aiMeta.convertedAt);

/** True for a lecture note that still belongs to the read-only viewer. */
export const isLectureNote = (page) => !!(page && page.aiMeta) && !isConverted(page);

/* The three lists the viewer renders, with the heading each carries on
   screen. Derived into the note so the converted copy reads as the
   note the student had open — a conversion that silently reordered or
   renamed the sections would be a different document. `overview` is
   not in the table because it is the note's opening paragraph and
   carries no heading anywhere. */
const SECTIONS = [
  ["keyPoints", null],
  ["assessable", "Might be assessed"],
  ["openQuestions", "Open questions"],
];

const asList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : []);

/**
 * One language's summary as note content.
 *
 * Returns `{ html, body }`, and BOTH ARE DERIVED FROM THE SAME OBJECT
 * rather than one from the other. The obvious alternative is to build
 * the html and run the app's `htmlToText` over it, which needs a DOM
 * — so it could not be tested from Node, and it would make the plain
 * text a claim about the markup instead of a claim about the lecture.
 *
 * Every interpolated string is escaped. The viewer renders these as
 * React children, where a `<` is a `<`; the editor renders stored html
 * through `innerHTML`. Model output crossing from one to the other is
 * exactly the boundary the note sanitiser exists for, and escaping
 * here means the sanitiser is the second line rather than the only
 * one.
 */
export function summaryToNote(content) {
  const c = content && typeof content === "object" ? content : {};
  const htmlParts = [];
  const bodyParts = [];

  const overview = typeof c.overview === "string" ? c.overview.trim() : "";
  if (overview) {
    htmlParts.push(`<p>${escapeHtml(overview)}</p>`);
    bodyParts.push(overview);
  }

  for (const [key, heading] of SECTIONS) {
    const items = asList(c[key]);
    if (items.length === 0) continue;
    if (heading) {
      htmlParts.push(`<p><strong>${escapeHtml(heading)}</strong></p>`);
      bodyParts.push(heading);
    }
    htmlParts.push(`<ul>${items.map((t) => `<li>${escapeHtml(t.trim())}</li>`).join("")}</ul>`);
    for (const t of items) bodyParts.push(t.trim());
  }

  return { html: htmlParts.join(""), body: bodyParts.join("\n") };
}

/**
 * The patch that turns a lecture note into an ordinary one, or `null`.
 *
 * `null` means REFUSED, and there are three ways to earn it: no page,
 * no usable content, and a note that has already been converted. The
 * second is rule 1 above and is the one that matters — a caller
 * holding `{failed:true}` has no `content` to pass, so the refusal
 * happens whether or not the caller remembered to check.
 *
 * `blocks` is written rather than `html`/`body` alone because that is
 * what an edited note is stored as (step 4b), and the legacy fields
 * are EMPTIED rather than omitted for the reason `noteFields` states:
 * `patchItem` spreads the patch, so a key left out keeps its old
 * value. Here the old value is the stub's `""`, so it happens to be
 * harmless — but writing them is what keeps one shape for a saved
 * note rather than two.
 */
export function convertPatch({ page, content, language, nowISO }) {
  if (!page || !page.aiMeta) return null;
  if (isConverted(page)) return null;

  const { html, body } = summaryToNote(content);
  /* NO CONTENT, NO CONVERSION. An empty summary and a failed fetch
     arrive here identically, and both must leave the note alone. */
  if (!html) return null;

  const at = typeof nowISO === "function" ? nowISO() : new Date().toISOString();

  return {
    blocks: [{ id: `${page.id || "new"}:t0`, type: "text", html, body }],
    html: "",
    body: "",
    strokes: [],
    aiMeta: {
      ...page.aiMeta,
      convertedAt: at,
      /* Which language the student was reading when they converted.
         Recorded because the row still holds the others, so a reader
         next month can tell "this is the Spanish, edited" from "this
         is all there was". */
      convertedFrom: language || page.aiMeta.activeLanguage || "en",
    },
  };
}
