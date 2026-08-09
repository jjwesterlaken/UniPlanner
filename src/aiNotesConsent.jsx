/* ==================================================================
   aiNotesConsent.jsx — the mandatory consent gate, standalone

   Deliberately has zero dependency on PlannerApp.jsx (unlike the rest
   of aiNotes.jsx's UI) — this is the single most safety-critical piece
   of the whole feature, so it's kept in its own tiny, independently
   testable file rather than pulled into the same module as, and
   therefore only testable through, the rest of the app.
   ================================================================== */

import { Check } from "lucide-react";
import { CONSENT_TEXT } from "./aiNotesLogic.js";

const acceptButtonCls =
  "inline-flex w-full items-center justify-center gap-1.5 rounded-lg u-accent-bg px-3.5 py-2.5 text-sm font-medium text-white u-focus transition-colors";

/**
 * A blocking overlay with no dismiss control of any kind — the only
 * way past it is the single "I understand and agree" button. No
 * close/X/skip button, no click-outside-to-dismiss, no Escape-key
 * handler. That, plus the caller never constructing anything that
 * could touch getUserMedia until this has been accepted, is what
 * makes the consent gate structurally unbypassable rather than merely
 * inconvenient to bypass.
 */
export function ConsentGate({ onAccept }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/60 p-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-stone-200 bg-white p-5 shadow-lg">
        <h2 className="font-serif text-lg font-semibold text-stone-800">{CONSENT_TEXT.title}</h2>
        <ul className="mt-3 space-y-2.5 text-sm text-stone-600">
          {CONSENT_TEXT.bullets.map((b, i) => (
            <li key={i} className="flex gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full u-accent-bg" />
              <span>{b}</span>
            </li>
          ))}
        </ul>
        <button className={`${acceptButtonCls} mt-5`} onClick={onAccept}>
          <Check size={16} /> {CONSENT_TEXT.acceptLabel}
        </button>
      </div>
    </div>
  );
}
