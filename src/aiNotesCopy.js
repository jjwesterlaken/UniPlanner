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

  /* ---------- choosing what to record from ---------- */
  audioSource: {
    label: "Record from",
    options: {
      microphone: "Microphone",
      system: "This computer's audio",
      both: "Both",
    },
    hint: {
      microphone: "For a lecture in a room.",
      system: "For a lecture played on this computer — a recorded video or an online class.",
      both: "The online class and your own microphone together.",
    },

    /* Why an option is greyed out rather than missing. A student in
       Firefox who sees only "Microphone" learns nothing; one who sees
       "This computer's audio — needs Chrome or Edge" knows what to do. */
    unavailable: {
      "unsupported-browser": "Needs Chrome or Edge — Firefox and Safari can't record this computer's audio.",
      "mobile-platform": "Phones and tablets can only record through the microphone.",
    },

    /* Said BEFORE the share dialog opens on a Mac, not after it goes
       wrong. The failure below is recoverable but wastes a click and a
       moment of confidence; this costs one line and usually prevents
       it. */
    tabOnlyHint: "On a Mac, choose a browser tab in the box that appears — a window or the whole screen won't include sound.",

    /* THE billed-silence message. Reached when the capture came back
       with no audio track, which is the normal outcome of picking the
       wrong thing in the browser's share dialog. Nothing was recorded
       and nothing was charged, and it names what to pick instead --
       "no audio was captured" on its own is a dead end for exactly the
       student who needed the instruction. */
    noAudioCaptured: (platform) => {
      const nothing = " Nothing was recorded and none of your allowance was used.";
      if (platform === "macos") {
        return (
          "That share didn't include any sound. On a Mac, only a browser tab can be recorded — " +
          "start again and choose the Chrome Tab option, not a window or the whole screen." +
          nothing
        );
      }
      if (platform === "windows" || platform === "linux") {
        return (
          "That share didn't include any sound. Start again and tick \"Also share system audio\" " +
          "(or \"Share tab audio\") in the box the browser shows." + nothing
        );
      }
      return "That share didn't include any sound. Start again and make sure audio is included in what you share." + nothing;
    },

    /* The share ending mid-recording. Without this the recorder happily
       carries on producing silence and the billed duration keeps
       climbing, which is the same failure as above arriving late. */
    shareEnded: "Sharing stopped, so the recording ended there. Everything up to that point was kept.",

    /* Only reachable for "Both", where mixing two inputs is the whole
       point and there is no useful half of it to fall back to. */
    mixFailed: "This browser couldn't combine the two sources. Record from one of them instead.",
  },

  /* ---------- the indicator, visible from every tab ----------

     Short by necessity: it sits over the app on a phone, so every word
     competes with the screen the student is actually using. Grace can
     rework all of it here without touching the state machine that
     decides when it appears. */
  indicator: {
    recording: "Recording your lecture",
    paused: "Paused",
    processing: "Writing up your notes…",
    waitingToSave: "Your notes are ready to save",
    stop: "Stop",

    /* Said inside the panel, not on the indicator. The old behaviour
       was to LOSE the recording on a tab change, so a student who has
       used this before has every reason to believe leaving is unsafe.
       Telling them it isn't costs one line. */
    keepsRunning: "You can use the rest of the planner — recording carries on, and the timer stays on screen.",
  },

  /* The microphone went muted mid-recording. On Android that is what
     backgrounding the app does: the track does not end, it mutes, and
     everything downstream keeps happily recording silence that is still
     billed by duration.

     A warning rather than a stop, deliberately: a mute can be momentary
     -- an incoming call, a permission toast -- and killing an hour of
     lecture over three seconds of it is the worse failure. */
  micMuted:
    "Your microphone has gone quiet — something else may have taken it, or the app may have been in the background. The recording is still going, but this part may be silent.",

  /* The app was backgrounded during a recording on a phone. Said when
     they come back, because there is nothing useful to do about it at
     the moment it happens. */
  wentToBackground:
    "UniPlanner was in the background for part of that. Phones stop apps recording when they aren't on screen, so some of it may be silent — keep the app open and the screen on while recording.",

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

    /* NOT the same as expired, and the difference is the whole point.
       We could not reach the server, so we do not know whether the
       result is still there -- and it very likely is. The key is KEPT,
       so this is a "try again", not a goodbye. Saying "expired" here
       would be telling a student their paid notes are gone while they
       sit on our server for another week. */
    unreachable:
      "We couldn't reach the server just then, so your notes are still waiting — nothing has been lost. Try again when you have a connection.",
  },
};
