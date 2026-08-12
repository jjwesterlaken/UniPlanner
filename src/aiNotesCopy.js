/* ==================================================================
   aiNotesCopy.js — user-facing wording for the AI notes failure paths

   Separated from aiNotesLogic.js for the same reason storageHealth.js
   is separate from the save path: every sentence here is a promise
   about money or about data, and Grace needs to be able to rework them
   without going near the logic that decides when they appear.

   THE RULE FOR EVERYTHING IN THIS FILE
   ------------------------------------
   Every claim must describe what the code actually does.

   Two in particular have been wrong before and must not drift back:

   - Nothing dropped by the size cap is "regenerable". The audio is
     deleted the moment transcription succeeds, and there is no
     text-only re-summarise endpoint. It is RECOVERABLE from the server
     row for the retention window, and that is a different word.

   - Transcription minutes are billed even when summarising fails. The
     Edge Function bills on the transcription duration, after the audio
     has already been deleted and regardless of what the summariser
     did. Saying "we couldn't generate a summary" without saying that is
     how a support ticket becomes a chargeback.
   ================================================================== */

import { FAILED_RESULT_RETENTION_DAYS } from "./aiNotesRetention.js";

export const AI_NOTES_COPY = {
  /* Why a two-minute recording shows as three minutes used.

     Disclosed rather than left to be discovered: a student who records a
     short tutorial segment and watches the counter jump would otherwise
     reasonably think the app was overcharging them. The honest reason is
     short and worth giving -- writing the notes up costs the same
     whatever the length, so the minutes aren't purely recording time. */
  minimumBilling: (minutes) =>
    `Recordings count in ${minutes}-minute blocks. Writing the notes up costs us about the same whether a recording is two minutes or twenty, so a very short one still uses ${minutes} minutes of your allowance.`,

  /* Shown on the review screen when transcription worked and
     summarising didn't. The user has already been charged at this
     point, so this screen says so. */
  summaryFailed: {
    title: "We transcribed your lecture, but couldn't write the summary.",
    billing:
      "Transcribing used your AI minutes — that part worked and it's what costs money, so it has been counted. Summarising is included, and you haven't been charged extra for the part that failed.",
    recoverable: (days = FAILED_RESULT_RETENTION_DAYS) =>
      `Your transcript is saved to your account for ${days} days, so you can get it back from any of your devices if you need it.`,
    action: "Save transcript as a note",
  },

  /* Shown when only part of a long transcript is kept in the note. */
  transcriptTruncated: ({ kept, total }) =>
    `Your note keeps the first ${kept.toLocaleString()} characters of ${total.toLocaleString()}, so it doesn't slow your planner down. Download the full text if you want it on this device.`,

  /* Shown when the 20KB cap trimmed a saved note. `dropped` is a
     language label, or null when only sections were trimmed. */
  noteCapped: ({ droppedLanguage, trimmed }) => {
    if (droppedLanguage && trimmed) {
      return `This lecture was unusually long, so the ${droppedLanguage} copy and some of the closing sections weren't saved into your planner. The full version is on your account — download it if you need it.`;
    }
    if (droppedLanguage) {
      return `This lecture was unusually long, so the ${droppedLanguage} copy wasn't saved into your planner. The full version is on your account — download it if you need it.`;
    }
    return "This lecture was unusually long, so a few of the closing sections weren't saved into your planner. The full version is on your account — download it if you need it.";
  },

  /* Offered when a recording was interrupted and the app still holds
     the key to the finished result on the server. */
  recovery: {
    title: "There's a recording waiting for you.",
    detail: ({ course, week }) => {
      const what = [course, week ? `week ${week}` : ""].filter(Boolean).join(", ");
      return what
        ? `We finished processing your ${what} recording, but the app closed before it was saved. You can pick it up now.`
        : "We finished processing your last recording, but the app closed before it was saved. You can pick it up now.";
    },
    action: "Get it back",
    dismiss: "Forget it",
    expired:
      "That recording is no longer on our server — results are only kept for a short time. Nothing further was charged.",
  },
};
