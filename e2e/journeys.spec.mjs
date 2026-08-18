/* Three journeys, in one real browser, against the real backend.

   Every production bug this project has had passed the full jsdom
   suite: the missing import that crashed signed-in renders, the uuid
   column rejecting every ai_notes insert for eleven days, the archive
   list reading empty over a real archive. None could have survived
   what this file does — a real Chromium, the built bundle, the live
   Supabase project, a dedicated test account.

   THE DESIGN RULE: assert through a DIFFERENT door than the one that
   wrote. Journey 1 types in one browser context and reads in a fresh
   one, so the text must have made the round trip through the server —
   localStorage alone cannot pass it. Journey 2 lets the app's own
   sync migrate a seeded pre-move AI note (the exact path that was
   broken for eleven days: a base36 id crossing into ai_notes.id),
   then opens it from a context with no cache, so the content must
   come back from the row. Journey 3 archives through the UI, checks
   the ROW exists by querying the table directly, then restores and
   checks both the screen and the blob.

   Serial, one worker: the journeys share one account and an ordering
   (3 archives what 1 and 2 created). */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import {
  EMAIL,
  PASSWORD,
  NOTE_TEXT,
  NOTE_TITLE,
  TODO_TEXT,
  AI_NOTE_TITLE,
  AI_OVERVIEW,
  signedInClient,
  pollDb,
} from "./helpers.mjs";

const state = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), ".state.json"), "utf8")
);

test.describe.configure({ mode: "serial" });
test.skip(!!state.skip, state.skip || "");

const aiNoteId = state.seed && state.seed.aiNoteId;

/** Sign in through the app's real form and wait until the pulled
    planner is on screen — journeys must not start before sync has
    delivered the seed. */
async function signIn(page) {
  await test.step("sign in through the app", async () => {
    await page.goto("/");
    await page.getByRole("button", { name: "Settings" }).click();
    await page.locator('input[type="email"]').fill(EMAIL);
    await page.locator('input[type="password"]').fill(PASSWORD);
    // Two buttons say "Sign in": the mode toggle and the submit. The
    // submit is the last in DOM order.
    await page.getByRole("button", { name: "Sign in" }).last().click();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
  });
  await test.step("the pulled planner is on screen", async () => {
    await page.getByRole("button", { name: "Notes" }).click();
    await expect(page.getByText(AI_NOTE_TITLE)).toBeVisible({ timeout: 20_000 });
  });
}

test("journey 1: create a note, and it survives a completely fresh device", async ({ page, browser }) => {
  await signIn(page);

  await test.step("create and type a note", async () => {
    await page.getByRole("button", { name: "New note" }).click();
    // The chooser is two steps: page style, then Create note ("Note"
    // is the default kind).
    await page.getByRole("button", { name: "Lined page" }).click();
    await page.getByRole("button", { name: "Create note" }).click();
    await page.getByPlaceholder("Note title").fill(NOTE_TITLE);
    const editor = page.locator('[data-placeholder="Start writing..."]').first();
    await editor.click();
    await editor.pressSequentially(NOTE_TEXT.slice(0, 40));
    await editor.pressSequentially(NOTE_TEXT.slice(40));
    await page.getByRole("button", { name: "Save note" }).click();
  });

  await test.step("the note reaches the server (past the 4s push debounce)", async () => {
    const { client, userId } = await signedInClient();
    try {
      await pollDb("the typed note to appear in planner_data", async () => {
        const { data, error } = await client.from("planner_data").select("data").eq("user_id", userId).maybeSingle();
        if (error) throw new Error(error.message);
        return data && JSON.stringify(data.data).includes(NOTE_TEXT);
      });
    } finally {
      await client.auth.signOut();
    }
  });

  await test.step("a fresh device (new context, empty storage) sees the note", async () => {
    const context = await browser.newContext();
    const fresh = await context.newPage();
    await signIn(fresh);
    await expect(fresh.getByText(NOTE_TITLE)).toBeVisible();
    await expect(fresh.getByText(NOTE_TEXT.slice(0, 40), { exact: false })).toBeVisible();
    await context.close();
  });
});

test("journey 2: the AI note migrates to its row, and a fresh device renders its content", async ({ browser }) => {
  test.skip(!aiNoteId, "no seed");

  await test.step("the app's own sync moved the note into ai_notes (the eleven-day path)", async () => {
    const { client, userId } = await signedInClient();
    try {
      await pollDb("the ai_notes row to exist", async () => {
        const { data, error } = await client.from("ai_notes").select("id").eq("id", aiNoteId).maybeSingle();
        if (error) throw new Error(error.message);
        return !!data;
      });
      await pollDb("the blob stub to say remote:true", async () => {
        const { data, error } = await client.from("planner_data").select("data").eq("user_id", userId).maybeSingle();
        if (error) throw new Error(error.message);
        const pages = (((data || {}).data || {}).semesters || {})["Semester 1"]?.pages || [];
        const stub = pages.find((p) => p && p.id === aiNoteId);
        return stub && stub.aiMeta && stub.aiMeta.remote === true;
      });
    } finally {
      await client.auth.signOut();
    }
  });

  await test.step("a fresh device opens the note and the CONTENT renders (no cache, real fetch)", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page);
    await page.locator(`[data-note-row="${aiNoteId}"]`).getByRole("button", { name: "Expand note" }).click();
    /* NOT the overview: the row's PREVIEW carries the overview's first
       characters from the stub, fetch or no fetch — the first CI run
       proved it, matching twice. The KEY POINTS exist only in the
       fetched content, so they are the thing whose visibility proves
       the row came back. */
    await expect(page.getByText("succinate to fumarate", { exact: false })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("releases two carbons", { exact: false })).toBeVisible();
    await context.close();
  });
});

test("journey 3: archive the semester, see the row, restore, and the planner is whole", async ({ page }) => {
  await signIn(page);

  let label = "";
  await test.step("archive through the UI", async () => {
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Archive this semester…" }).click();
    const nameInput = page.locator("label", { hasText: "Archive name" }).locator("xpath=following-sibling::input[1]");
    label = await nameInput.inputValue();
    expect(label.trim().length).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(page.getByText(/Archived as/)).toBeVisible({ timeout: 30_000 });
  });

  await test.step("the row really exists, queried directly", async () => {
    const { client, userId } = await signedInClient();
    try {
      await pollDb("the semester_archives row", async () => {
        const { data, error } = await client.from("semester_archives").select("id,label").eq("user_id", userId);
        if (error) throw new Error(error.message);
        return data && data.length === 1 && data[0].label === label.trim() ? data[0] : false;
      });
    } finally {
      await client.auth.signOut();
    }
  });

  await test.step("restore through the UI", async () => {
    await page.getByRole("button", { name: "Restore this semester" }).click();
    await expect(page.getByText("Semester restored.")).toBeVisible({ timeout: 30_000 });
  });

  await test.step("the planner is whole again on screen", async () => {
    await page.getByRole("button", { name: "Notes" }).click();
    await expect(page.getByText(AI_NOTE_TITLE)).toBeVisible();
    await expect(page.getByText(NOTE_TITLE)).toBeVisible();
  });

  await test.step("and whole in the blob: the restore reached the server", async () => {
    const { client, userId } = await signedInClient();
    try {
      await pollDb("the restored todo to be live in planner_data", async () => {
        const { data, error } = await client.from("planner_data").select("data").eq("user_id", userId).maybeSingle();
        if (error) throw new Error(error.message);
        const todos = (((data || {}).data || {}).semesters || {})["Semester 1"]?.todos || [];
        return todos.some((t) => t && t.text === TODO_TEXT && !t.deletedAt);
      });
    } finally {
      await client.auth.signOut();
    }
  });
});
