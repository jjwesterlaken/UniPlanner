/* ==================================================================
   aiNotesConsent.jsx — the mandatory consent gate, standalone

   Deliberately has zero dependency on PlannerApp.jsx (unlike the rest
   of aiNotes.jsx's UI) — this is the single most safety-critical piece
   of the whole feature, so it's kept in its own tiny, independently
   testable file rather than pulled into the same module as, and
   therefore only testable through, the rest of the app.
   ================================================================== */

import { useState } from "react";
import { Check, ShieldQuestion } from "lucide-react";
import { CONSENT_TEXT } from "./aiNotesLogic.js";

const acceptButtonCls =
  "inline-flex w-full items-center justify-center gap-1.5 rounded-lg u-accent-bg px-3.5 py-2.5 text-sm font-medium text-white u-focus transition-colors";

const declineButtonCls =
  "inline-flex w-full items-center justify-center rounded-lg border border-stone-300 px-3.5 py-2.5 text-sm font-medium text-stone-600 u-focus transition-colors";

/**
 * The consent screen, shown before the first AI action and never after
 * it has been accepted for the current wording and provider set.
 *
 * STILL UNBYPASSABLE BY ACCIDENT: no close control, no
 * click-outside-to-dismiss, no Escape handler, and the caller
 * constructs nothing that could reach a microphone or a provider until
 * `onAccept` has fired. What has changed is that there is now a
 * DELIBERATE way out.
 *
 * WHY A DECLINE BUTTON IS PART OF THE FIX RATHER THAN A SOFTENING OF
 * IT. The old gate had exactly one control, so a student who did not
 * want to agree met a full-screen overlay with no exit — on a tab they
 * may have opened by accident. A choice with one button is not consent,
 * and Apple's 5.1.1(i) is about informed agreement, which presupposes
 * the option to refuse. `declineNote` says what refusing costs, which
 * is nothing except the AI features, and that sentence is true: every
 * other part of the planner works without an account at all.
 *
 * `onDecline` is optional so the two existing call sites keep working
 * while they are wired; where it is absent the gate behaves as before.
 */
export function ConsentGate({ onAccept, onDecline }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/60 p-4" data-consent-gate>
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-stone-200 bg-surface p-5 shadow-lg">
        <h2 className="font-serif text-lg font-semibold text-stone-800">{CONSENT_TEXT.title}</h2>
        <p className="mt-2 text-sm text-stone-600">{CONSENT_TEXT.intro}</p>

        {/* WHO RECEIVES WHAT, first and by name. This block is the
            reason the build was rejected: the previous screen described
            the recipients by role only. Rendered from
            src/aiProviders.js so it cannot name a service the code does
            not use, or omit one it can.

            NO HEADING OVER IT, per Grace's pass: the sentences follow
            "here's exactly what goes where" directly, which reads as the
            answer to it rather than as a new section. `data-consent-providers`
            is what the browser test reads the names off, so the landmark
            is the list and never the heading. */}
        <ul className="mt-4 space-y-2 text-sm text-stone-600" data-consent-providers>
          {CONSENT_TEXT.providers.map((b, i) => (
            <li key={i} className="flex gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full u-accent-bg" />
              <span>{b}</span>
            </li>
          ))}
        </ul>

        <ul className="mt-4 space-y-2.5 text-sm text-stone-600">
          {CONSENT_TEXT.bullets.map((b, i) => (
            <li key={i} className="flex gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-stone-300" />
              <span>{b}</span>
            </li>
          ))}
        </ul>

        <p className="mt-4 rounded-lg bg-stone-50 p-3 text-sm text-stone-600" data-consent-decline-note>
          {CONSENT_TEXT.declineNote}
        </p>

        <p className="mt-3 text-xs text-stone-500">
          <a className="underline" href={CONSENT_TEXT.privacyUrl} target="_blank" rel="noreferrer">
            {CONSENT_TEXT.privacyLabel}
          </a>
        </p>

        <button className={`${acceptButtonCls} mt-4`} onClick={onAccept} data-consent-accept>
          <Check size={16} /> {CONSENT_TEXT.acceptLabel}
        </button>
        {onDecline && (
          <button className={`${declineButtonCls} mt-2`} onClick={onDecline} data-consent-decline>
            {CONSENT_TEXT.declineLabel}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * What stands where an AI control would, until consent is given.
 *
 * THE FOUR TEXT FEATURES LIVE ON TABS A STUDENT OPENS FOR OTHER
 * REASONS — Study, Notes, the reading planner — so the full-screen gate
 * cannot be thrown over them on arrival. This is the compact form: one
 * sentence saying why, and a control that opens the SAME gate. Nothing
 * here can reach a provider, because the controls it replaces are not
 * rendered at all.
 *
 * IT OWNS THE OVERLAY ITSELF rather than reporting upwards, so a caller
 * cannot wire the notice and forget the screen — the two halves of a
 * consent gate travelling separately is the prop-relay failure this
 * codebase has already paid for once.
 */
export function ConsentNeededNotice({ onAccept, onDecline }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg bg-stone-100 px-3 py-2.5 text-sm" data-consent-needed>
      <p className="text-stone-600">{CONSENT_TEXT.stubLine}</p>
      <button
        className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium u-accent-text hover:underline"
        onClick={() => setOpen(true)}
        data-consent-open
      >
        <ShieldQuestion size={15} /> {CONSENT_TEXT.stubAction}
      </button>
      {open && (
        <ConsentGate
          onAccept={() => {
            setOpen(false);
            onAccept();
          }}
          onDecline={() => {
            setOpen(false);
            if (onDecline) onDecline();
          }}
        />
      )}
    </div>
  );
}
