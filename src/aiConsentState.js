/* ==================================================================
   aiConsentState.js — consent at the BOUNDARY, not only on the screen

   Every AI feature is gated in the UI, which is right and is also one
   refactor away from being wrong. This codebase has already learned
   that lesson twice — `callAiText`, `callAiNotes` and `uploadAudio` each
   refuse a signed-out caller on their own rather than trusting the
   `session &&` in the markup, because "nothing leaves your device
   without an account" is a claim in the privacy policy and a UI-only
   gate is one refactor from leaking.

   APPLE'S 5.1.1(i) MAKES THE SAME CLAIM ABOUT CONSENT, and it is the
   one a reviewer will actually test: decline, and nothing may be sent.
   So the refusal lives here, where the request is made, and the screens
   are what makes it never fire in normal use.

   THE SOURCE OF TRUTH IS STILL `data.meta.aiConsent` — there is exactly
   one record of what a student agreed to, it lives in the synced blob,
   and it is per account. This module holds a MIRROR of it for the
   benefit of code that has no React state in scope, and the mirror is
   written from one place (PlannerApp, on every change to the blob) and
   read by the three clients. The question it answers is asked of
   `needsConsent` — the same function the screens ask — so the boundary
   and the gate cannot come to different conclusions about the same
   acceptance.

   IT FAILS CLOSED. An unset mirror refuses, because the cost of the two
   mistakes is not symmetric: a refusal costs a consented student one
   error message and a reload, and a leak costs them a disclosure they
   cannot take back. That is the same "fail towards keeping" reasoning
   as `recoveryFailureKind`, pointed at a different asymmetry.
   ================================================================== */

import { needsConsent } from "./aiNotesLogic.js";

/* The mirror. A module-level box rather than a store with subscribers:
   nothing RENDERS from this — the screens read the blob directly — so
   there is nothing to notify. */
let mirrored = null;

/**
 * Mirror what the blob says this account has agreed to.
 *
 * Takes `meta` rather than the consent object so the caller cannot get
 * the shape wrong, and so this reads identically to every `needsConsent`
 * call site.
 */
export function recordConsentState(meta) {
  mirrored = (meta && meta.aiConsent) || null;
}

/* THERE IS NO `clearConsentState`, AND THAT IS A DECISION.
   Signing out deliberately LEAVES the local planner in place (see the
   privacy policy: it is the student's planner, and it is the same copy
   somebody with no account has), so `data.meta.aiConsent` survives a
   sign-out and the screens go on reading it. A mirror cleared on
   sign-out would then disagree with them — the boundary refusing while
   the screen offers the control — and two answers to one question is
   the thing this module exists to avoid. One writer, one source.
   Passing `{}` or null here is how a test represents "not accepted". */

/** What the boundary currently believes, for tests and for the guard. */
export const consentMirror = () => mirrored;

/**
 * The refusal, or null.
 *
 * Returns an Error shaped like every other client refusal in this
 * codebase — `code` set, so the existing copy lookup renders it — and
 * the caller throws it. Returning rather than throwing is what lets the
 * three clients put it in the same place as their `!token` check
 * without a try/catch.
 */
export function consentRefusal() {
  if (!needsConsent({ aiConsent: mirrored })) return null;
  const err = new Error(
    "The AI features need your agreement first, because they send your work to companies outside Australia."
  );
  err.code = "consent_required";
  err.stage = "client";
  return err;
}
