/* ==================================================================
   essayPanel.jsx — essay feedback, on the assessment row

   WHERE IT LIVES IS THE DESIGN (ESSAY-FEEDBACK.md §5): on the Grades
   row for the assessment, collapsed to one line and opening inline, the
   SummariseReading shape. The mark that the comparison asks about lives
   on the same item, which is what lets the ask be a render condition.

   LAYOUT AND WORDING ARE GRACE'S. The structure is built clean and
   plain; every word comes from essayCopy.js.

   THE ESSAY NEVER LEAVES COMPONENT STATE except in the request. Not the
   draft, not localStorage, not the blob: the privacy policy says text
   supplied to the AI features is relayed and never stored, and that is
   a property of where this state can reach.
   ================================================================== */

import { useState } from "react";
import { Sparkles, X, Check, FileText } from "lucide-react";
import { AiActionFrame, useTask } from "./aiText.jsx";
import { TASK_CREDITS, ESSAY_MAX_CHARS } from "./aiTextLimits.js";
import { ESSAY_COPY } from "./essayCopy.js";
import { orderedPoints, reasonsFor, RATINGS, MAX_COMMENT_CHARS } from "./essayFeedback.js";
import { btnPrimary, btnGhost, inputCls, labelCls, uid } from "./PlannerApp.jsx";

/**
 * The opt-in, once per account, before first use. Declining is not
 * stored: it closes the panel and the next open asks again, because a
 * refusal is not a preference that then needs a control to undo.
 */
export function EssayOptIn({ onAccept, onDecline }) {
  const c = ESSAY_COPY.optIn;
  return (
    <div data-essay-opt-in className="space-y-2 rounded-lg border border-stone-200 bg-surface p-3">
      <p className="text-sm font-semibold text-stone-800">{c.title}</p>
      <ul className="list-disc space-y-1 pl-5 text-sm text-stone-600">
        {c.bullets.map((b) => (
          <li key={b}>{b}</li>
        ))}
      </ul>
      <div className="flex justify-end gap-2">
        <button className={btnGhost} onClick={onDecline}>
          {c.decline}
        </button>
        <button className={btnPrimary} onClick={onAccept}>
          <Check size={15} /> {c.accept}
        </button>
      </div>
    </div>
  );
}

/**
 * THE BAND AND THE DISCLAIMER RENDER IN THIS ONE COMPONENT, and nowhere
 * else renders a band (§4): a test mounts it and asserts the disclaimer
 * is present wherever the band is.
 */
export function EssayResult({ result }) {
  const points = orderedPoints(result);
  return (
    <div data-essay-result className="space-y-3">
      {result.band ? (
        <div data-essay-band className="rounded-lg u-accent-soft p-3">
          <p className="text-sm font-semibold u-accent-deeptext">{ESSAY_COPY.bandLine(result.band)}</p>
          <p data-essay-disclaimer className="mt-1 text-xs text-stone-600">
            {ESSAY_COPY.disclaimer}
          </p>
        </div>
      ) : (
        <p className="text-xs text-stone-500">{ESSAY_COPY.noBand}</p>
      )}
      {result.sentence && <p className="text-sm text-stone-700">{result.sentence}</p>}
      {points.length === 0 && <p className="text-sm text-stone-500">{ESSAY_COPY.noPoints}</p>}
      {["fundamental", "minor", "outside"].map((level) => {
        const group = points.filter((p) => p.severity === level);
        if (!group.length) return null;
        return (
          <div key={level} data-essay-severity={level}>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">{ESSAY_COPY.severityHeading[level]}</p>
            <ul className="space-y-2">
              {group.map((p, i) => (
                <li key={`${level}-${i}`} data-essay-point className="rounded-lg border border-stone-200 bg-surface p-2.5 text-sm">
                  <p className="font-medium text-stone-800">{ESSAY_COPY.codeLabel(p.deficiency)}</p>
                  <p className="mt-1 border-l-2 border-stone-300 pl-2 text-stone-600">&ldquo;{p.quote}&rdquo;</p>
                  <p className="mt-1 text-stone-700">{p.note}</p>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/** Yes / partly / no, reasons, and a comment only when ticked. Shared by the result and the mark ask. */
export function RatingFields({ state, set, rewriteRequested = false, allowComment = true }) {
  const c = ESSAY_COPY.capture;
  const toggle = (r) =>
    set((s) => ({ ...s, reasons: s.reasons.includes(r) ? s.reasons.filter((x) => x !== r) : [...s.reasons, r] }));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5" role="radiogroup">
        {RATINGS.map((r) => (
          <button
            key={r}
            role="radio"
            aria-checked={state.rating === r}
            data-essay-rating={r}
            className={`rounded-full px-3 py-1 text-xs font-medium u-focus ${state.rating === r ? "u-accent-bg text-white" : "bg-stone-100 text-stone-700"}`}
            onClick={() => set((s) => ({ ...s, rating: r }))}
          >
            {c.ratings[r]}
          </button>
        ))}
      </div>
      {state.rating && state.rating !== "yes" && (
        <fieldset className="space-y-1">
          <legend className="text-xs text-stone-500">{c.reasonsLabel}</legend>
          {reasonsFor({ rewriteRequested }).map((r) => (
            <label key={r} className="flex items-center gap-2 text-sm text-stone-700">
              <input type="checkbox" checked={state.reasons.includes(r)} onChange={() => toggle(r)} />
              {c.reasons[r]}
            </label>
          ))}
        </fieldset>
      )}
      {allowComment && state.rating && (
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm text-stone-700">
            <input
              type="checkbox"
              data-essay-comment-tick
              checked={state.sendComment}
              onChange={(e) => set((s) => ({ ...s, sendComment: e.target.checked }))}
            />
            {c.commentTick}
          </label>
          {state.sendComment && (
            <>
              <textarea
                className={inputCls}
                rows={3}
                maxLength={MAX_COMMENT_CHARS}
                value={state.comment}
                onChange={(e) => set((s) => ({ ...s, comment: e.target.value }))}
              />
              <p className="text-xs text-stone-500">{c.commentNote(MAX_COMMENT_CHARS)}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const blankRating = () => ({ rating: null, reasons: [], sendComment: false, comment: "" });

function FeedbackCapture({ onSend }) {
  const c = ESSAY_COPY.capture;
  const [state, setState] = useState(blankRating());
  const [status, setStatus] = useState(null); // null | "sent" | "failed"
  if (status === "sent") return <p className="text-xs text-stone-500">{c.thanks}</p>;
  return (
    <div data-essay-capture className="space-y-2 border-t border-stone-200 pt-2">
      <p className="text-sm font-medium text-stone-700">{c.question}</p>
      <RatingFields state={state} set={setState} />
      {state.rating && (
        <button
          className={btnGhost}
          onClick={async () => setStatus((await onSend(state)) ? "sent" : "failed")}
        >
          {c.send}
        </button>
      )}
      {status === "failed" && <p className="text-xs text-stone-500">{c.failed}</p>}
    </div>
  );
}

/**
 * The panel. Callbacks, not clients: PlannerApp owns the data and the
 * Supabase client, so nothing here is relayed through a component that
 * only passes it on (the `folders` ReferenceError).
 */
export function EssayFeedbackPanel({ session, assessment, allowanceApi, optIn, onDelivered, onRate, onSave }) {
  const { applyFraction } = allowanceApi;
  const { run, busy, error } = useTask(session, applyFraction);
  const [open, setOpen] = useState(false);
  const [essay, setEssay] = useState("");
  const [criteria, setCriteria] = useState("");
  const [result, setResult] = useState(null);
  const [runId, setRunId] = useState(null);
  const [saved, setSaved] = useState(false);
  const [local, setLocal] = useState(null);

  if (!open) {
    return (
      <button data-essay-open className="mt-1 text-xs font-medium text-stone-500 hover:u-accent-text" onClick={() => setOpen(true)}>
        <Sparkles size={12} className="mr-0.5 inline" />
        {ESSAY_COPY.rowAction}
      </button>
    );
  }

  const close = () => {
    setOpen(false);
    setEssay("");
    setCriteria("");
    setResult(null);
    setRunId(null);
    setSaved(false);
    setLocal(null);
  };

  const header = (
    <div className="flex items-center justify-between">
      <span className="text-sm font-semibold text-stone-700">{ESSAY_COPY.panelTitle}</span>
      <button className={btnGhost} onClick={close} aria-label={ESSAY_COPY.close}>
        <X size={14} />
      </button>
    </div>
  );

  if (optIn.needed) {
    return (
      <div className="mt-2 space-y-2 rounded-lg border border-stone-200 bg-stone-50 p-2.5">
        {header}
        <EssayOptIn onAccept={optIn.accept} onDecline={close} />
      </div>
    );
  }

  const total = essay.length + criteria.length;
  const go = async () => {
    setLocal(null);
    if (!essay.trim() || !criteria.trim()) return setLocal(ESSAY_COPY.needBoth);
    if (total > ESSAY_MAX_CHARS) return setLocal(ESSAY_COPY.tooLong(total, ESSAY_MAX_CHARS));
    const out = await run("essay", { text: essay, criteria });
    if (!out) return;
    const id = uid();
    setRunId(id);
    setResult(out);
    setSaved(false);
    onDelivered({ result: out, runId: id });
  };

  return (
    <div data-essay-panel className="mt-2 space-y-2 rounded-lg border border-stone-200 bg-stone-50 p-2.5">
      {header}
      <AiActionFrame title={ESSAY_COPY.panelTitle} task="essay" api={allowanceApi} error={error} busy={busy}>
        {!result && (
          <div className="space-y-2">
            <div>
              <label className={labelCls}>{ESSAY_COPY.essayLabel}</label>
              <textarea data-essay-text className={inputCls} rows={8} spellCheck={false} value={essay} onChange={(e) => setEssay(e.target.value)} />
              <p className="mt-0.5 text-xs text-stone-500">{ESSAY_COPY.essayHint}</p>
            </div>
            <div>
              <label className={labelCls}>{ESSAY_COPY.criteriaLabel}</label>
              <textarea data-essay-criteria className={inputCls} rows={4} spellCheck={false} value={criteria} onChange={(e) => setCriteria(e.target.value)} />
              <p className="mt-0.5 text-xs text-stone-500">{ESSAY_COPY.criteriaHint}</p>
            </div>
            <p className="text-xs text-stone-500">{ESSAY_COPY.cost(TASK_CREDITS.essay)}</p>
            {local && <p className="text-xs text-amber-800">{local}</p>}
            <button data-essay-go className={btnPrimary} disabled={busy} onClick={go}>
              <Sparkles size={15} /> {ESSAY_COPY.go}
            </button>
          </div>
        )}
      </AiActionFrame>
      {result && (
        <div className="space-y-3">
          <EssayResult result={result} />
          <div className="flex justify-end">
            {saved ? (
              <span className="text-xs text-stone-500">
                <Check size={12} className="mr-0.5 inline" />
                {ESSAY_COPY.saved}
              </span>
            ) : (
              <button
                className={btnGhost}
                onClick={() => {
                  onSave({ result });
                  setSaved(true);
                }}
              >
                <FileText size={14} /> {ESSAY_COPY.save}
              </button>
            )}
          </div>
          <FeedbackCapture key={runId} onSend={(state) => onRate({ result, runId, ...state })} />
        </div>
      )}
    </div>
  );
}

/**
 * The mark comparison: once per assessment, dismissible, rendered only
 * when showMarkCompare says so. The mark is shared only with the tick.
 */
export function MarkCompareAsk({ onAnswer, onDismiss }) {
  const c = ESSAY_COPY.markAsk;
  const [state, setState] = useState(blankRating());
  const [share, setShare] = useState(false);
  const [done, setDone] = useState(false);
  if (done) return <p className="px-3 pb-2 text-xs text-stone-500">{c.thanks}</p>;
  return (
    <div data-mark-compare className="mx-3 mb-2 space-y-2 rounded-lg u-accent-soft p-2.5">
      <p className="text-sm font-medium text-stone-800">{c.question}</p>
      <RatingFields state={state} set={setState} allowComment={false} />
      <label className="flex items-start gap-2 text-sm text-stone-700">
        <input type="checkbox" data-mark-share checked={share} onChange={(e) => setShare(e.target.checked)} className="mt-1" />
        <span>
          {c.shareTick}
          <span className="block text-xs text-stone-500">{c.shareNote}</span>
        </span>
      </label>
      <div className="flex justify-end gap-2">
        <button data-mark-dismiss className={btnGhost} onClick={onDismiss}>
          {c.dismiss}
        </button>
        <button
          data-mark-send
          className={btnPrimary}
          disabled={!state.rating}
          onClick={() => {
            onAnswer({ rating: state.rating, reasons: state.reasons, shareMark: share });
            setDone(true);
          }}
        >
          {c.send}
        </button>
      </div>
    </div>
  );
}
