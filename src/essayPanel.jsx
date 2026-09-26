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

import { useState, useRef, useSyncExternalStore } from "react";
import { Sparkles, X, Check, FileText, Camera } from "lucide-react";
import { AiActionFrame, useTask, downscalePhoto } from "./aiText.jsx";
import { AI_TEXT_FAILURES } from "./aiTextCopy.js";
import { PHOTOS_PER_CHUNK } from "./readingChunks.js";
import { TASK_CREDITS, ESSAY_MAX_CHARS, CRITERIA_PHOTO_ENABLED, CRITERIA_PHOTO_MAX_EDGE } from "./aiTextLimits.js";
import { ESSAY_COPY } from "./essayCopy.js";
import { orderedPoints, reasonsFor, RATINGS, MAX_COMMENT_CHARS, ESSAY_REWRITE_ENABLED, aiUseText } from "./essayFeedback.js";
import { createEssayHold } from "./essayHold.js";
import { btnPrimary, btnGhost, inputCls, labelCls, uid, HelpButton, CourseSelect } from "./PlannerApp.jsx";

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
export function EssayResult({ result, rewrites = null }) {
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
              {group.map((p, i) => {
                const key = `${level}-${i}`;
                const rw = rewrites && rewrites.state[key];
                return (
                  <li key={key} data-essay-point className="rounded-lg border border-stone-200 bg-surface p-2.5 text-sm">
                    <p className="font-medium text-stone-800">{ESSAY_COPY.codeLabel(p.deficiency)}</p>
                    <p className="mt-1 border-l-2 border-stone-300 pl-2 text-stone-600">&ldquo;{p.quote}&rdquo;</p>
                    <p className="mt-1 text-stone-700">{p.note}</p>
                    {/* THE EXAMPLE REWRITE: on request, one passage, side by
                        side, never written anywhere. */}
                    {/* A CONTROL, NOT A CAPTION (Jared, 26 September 2026):
                        the app's bordered button, the cost as a second line
                        under it. Grace can restyle; it has to look
                        pressable. */}
                    {rewrites && !rw && (
                      <div className="mt-2">
                        <button
                          data-essay-rewrite
                          className={`${btnGhost} disabled:cursor-not-allowed disabled:opacity-40`}
                          disabled={rewrites.busy}
                          onClick={() => rewrites.request(p, key)}
                        >
                          <Sparkles size={14} /> {rewrites.pending === key ? ESSAY_COPY.rewrite.working : ESSAY_COPY.rewrite.button}
                        </button>
                        <p data-essay-rewrite-cost className="mt-1 text-xs text-stone-500">{ESSAY_COPY.rewrite.cost(rewrites.credits)}</p>
                      </div>
                    )}
                    {rw && rw.rewrite && (
                      <div data-essay-side-by-side className="mt-2 grid gap-2 sm:grid-cols-2">
                        <div className="rounded border border-stone-200 p-2">
                          <p className="text-xs font-medium text-stone-500">{ESSAY_COPY.rewrite.yours}</p>
                          <p className="mt-0.5 text-stone-700">{p.quote}</p>
                        </div>
                        <div className="rounded border border-stone-200 p-2">
                          <p className="text-xs font-medium text-stone-500">{ESSAY_COPY.rewrite.example}</p>
                          <p data-essay-example className="mt-0.5 text-stone-700">{rw.rewrite}</p>
                        </div>
                        <p className="text-xs text-stone-500 sm:col-span-2">
                          {ESSAY_COPY.rewrite.note} {ESSAY_COPY.rewrite.recorded}
                        </p>
                      </div>
                    )}
                  </li>
                );
              })}
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

/** The AI-use record for this assessment, to copy into a disclosure. */
export function AiUseRecord({ assessment }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!Array.isArray(assessment.aiUse) || assessment.aiUse.length === 0) return null;
  const text = aiUseText({ assessment, copy: ESSAY_COPY, formatDate: (iso) => new Date(iso).toLocaleDateString("en-AU") });
  if (!open) {
    return (
      <button data-ai-use-open className="text-xs font-medium text-stone-500 hover:u-accent-text" onClick={() => setOpen(true)}>
        {ESSAY_COPY.record}
      </button>
    );
  }
  return (
    <div data-ai-use-record className="space-y-1">
      <textarea readOnly className={inputCls} rows={Math.min(8, assessment.aiUse.length + 2)} value={text} />
      <button
        className={btnGhost}
        onClick={() => {
          try {
            navigator.clipboard.writeText(text).then(() => setCopied(true), () => {});
          } catch (e) {
            /* no clipboard: the text is selectable in the box */
          }
        }}
      >
        {copied ? ESSAY_COPY.recordCopied : ESSAY_COPY.recordCopy}
      </button>
    </div>
  );
}

const blankRating = () => ({ rating: null, reasons: [], sendComment: false, comment: "" });

function FeedbackCapture({ onSend, rewriteRequested = false, sent = false }) {
  const c = ESSAY_COPY.capture;
  const [state, setState] = useState(blankRating());
  const [status, setStatus] = useState(null); // null | "sent" | "failed"
  if (sent || status === "sent") return <p className="text-xs text-stone-500">{c.thanks}</p>;
  return (
    <div data-essay-capture className="space-y-2 border-t border-stone-200 pt-2">
      <p className="text-sm font-medium text-stone-700">{c.question}</p>
      <RatingFields state={state} set={setState} rewriteRequested={rewriteRequested} />
      {state.rating && (
        <button
          className={btnGhost}
          onClick={async () => setStatus((await onSend({ ...state, rewriteRequested })) ? "sent" : "failed")}
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
export function EssayFeedbackPanel({ session, assessment, allowanceApi, optIn, onDelivered, onRate, onSave, onRewrite = null, hold: heldBy = null, alwaysOpen = false, onClose = null }) {
  const { applyFraction } = allowanceApi;
  const { run, busy: runBusy, error } = useTask(session, applyFraction);
  /* One passage at a time: a second request waits for the first. The
     examples live beside the essay and nowhere else. */
  const rewriteTask = useTask(session, applyFraction);
  /* THE RUN OUTLIVES THE PANEL (essayHold.js). PlannerApp passes a hold
     that sits above the tab switch; a panel mounted without one (a
     component test) gets its own, which is the old behaviour. */
  const ownHold = useRef(null);
  if (!heldBy && !ownHold.current) ownHold.current = createEssayHold();
  const hold = heldBy || ownHold.current;
  const id = assessment.id;
  const held = useSyncExternalStore(hold.subscribe, () => hold.get(id), () => hold.get(id));
  const put = (patch) => hold.set(id, patch);
  const { essay, criteria, result, runId, saved, rated } = held;
  /* On the AI tab the panel IS the card, so it is never collapsed to
     its one-line button. */
  const open = alwaysOpen || held.open;
  const rewriteState = held.rewrites;
  const busy = runBusy || held.pending;
  const setOpen = (v) => put({ open: v });
  const setEssay = (v) => put({ essay: v });
  const setCriteria = (v) => put({ criteria: v });
  const [local, setLocal] = useState(null);
  const [helpOpen, setHelpOpen] = useState(false);
  if (!open) {
    return (
      <button data-essay-open className="mt-1 text-xs font-medium text-stone-500 hover:u-accent-text" onClick={() => setOpen(true)}>
        <Sparkles size={12} className="mr-0.5 inline" />
        {ESSAY_COPY.rowAction}
      </button>
    );
  }

  /* Closing is the student dismissing it: the entry, drafts and all,
     goes. */
  const close = () => {
    hold.clear(id);
    setLocal(null);
    if (onClose) onClose();
  };

  const header = (
    <>
    <div className="flex items-center justify-between gap-2">
      <span className="flex-1 text-sm font-semibold text-stone-700">{ESSAY_COPY.panelTitle}</span>
      {/* The app's ? control; the three steps live in essayCopy.js
          beside the rest of the panel's wording. */}
      <HelpButton title={ESSAY_COPY.help.title} open={helpOpen} onToggle={() => setHelpOpen((v) => !v)} />
      <button className={btnGhost} onClick={close} aria-label={ESSAY_COPY.close}>
        <X size={14} />
      </button>
    </div>
    {helpOpen && <EssayHelp />}
    </>
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
    /* Written to the hold, not to this component: if the student has
       switched tab by the time it lands, the result is waiting when
       they come back instead of lost after being charged. */
    put({ pending: true });
    const out = await run("essay", { text: essay, criteria });
    if (!out) return put({ pending: false });
    const runIdNew = uid();
    put({ pending: false, result: out, runId: runIdNew, saved: false, rated: false, rewrites: {} });
    onDelivered({ result: out, runId: runIdNew });
  };

  return (
    <div data-essay-panel className="mt-2 space-y-2 rounded-lg border border-stone-200 bg-stone-50 p-2.5">
      {header}
      <AiUseRecord assessment={assessment} />
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
              {CRITERIA_PHOTO_ENABLED && (
                <CriteriaPhoto
                  session={session}
                  allowanceApi={allowanceApi}
                  pending={held.criteriaPending}
                  setPending={(v) => put({ criteriaPending: v })}
                  onText={(text, missed = null) =>
                    put((cur) => ({
                      criteria: !text ? cur.criteria : cur.criteria.trim() ? `${cur.criteria.trimEnd()}\n\n${text}` : text,
                      criteriaFromPhoto: true,
                      criteriaPartial: missed,
                    }))
                  }
                  filled={held.criteriaFromPhoto}
                  partial={held.criteriaPartial}
                />
              )}
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
          <EssayResult
            result={result}
            rewrites={
              ESSAY_REWRITE_ENABLED && onRewrite
                ? {
                    credits: TASK_CREDITS.rewrite,
                    busy: rewriteTask.busy || !!held.rewritePending,
                    pending: held.rewritePending,
                    state: rewriteState,
                    request: async (p, key) => {
                      put({ rewritePending: key });
                      const out = await rewriteTask.run("rewrite", { text: essay, span: p.quote, note: p.note, deficiency: p.deficiency });
                      if (!out) return put({ rewritePending: null });
                      put((cur) => ({ rewritePending: null, rewrites: { ...cur.rewrites, [key]: { rewrite: out.rewrite } } }));
                      onRewrite({ point: p, runId });
                    },
                  }
                : null
            }
          />
          {rewriteTask.error && (
            <AiActionFrame title={ESSAY_COPY.rewrite.button} task="rewrite" api={allowanceApi} error={rewriteTask.error} busy={false}>
              {null}
            </AiActionFrame>
          )}
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
                  put({ saved: true });
                }}
              >
                <FileText size={14} /> {ESSAY_COPY.save}
              </button>
            )}
          </div>
          <FeedbackCapture
            key={runId}
            sent={rated}
            rewriteRequested={Object.keys(rewriteState).length > 0}
            onSend={async (state) => {
              const ok = await onRate({ result, runId, ...state });
              if (ok) put({ rated: true });
              return ok;
            }}
          />
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

/* The panel's ? — the same look as HelpPanel, with its three steps
   read from essayCopy.js. */
export function EssayHelp() {
  return (
    <div className="rounded-xl border border-stone-200 bg-surface p-3 text-sm text-stone-700" data-help-panel="essay">
      <ol className="list-decimal space-y-1 pl-5">
        {ESSAY_COPY.help.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p data-essay-help-note className="mt-2 text-xs text-stone-500">{ESSAY_COPY.help.note}</p>
    </div>
  );
}

/**
 * Marking criteria from a photo. Up to PHOTOS_PER_CHUNK images, sent as
 * one `criteria` batch, and the transcription lands in the criteria box
 * as ordinary editable text. The essay stays paste-only.
 *
 * The pending flag and the result go through the hold, like a read: a
 * batch that lands while the student is on another tab still fills the
 * box, and a remounted panel does not offer the button a second time.
 */
function CriteriaPhoto({ session, allowanceApi, pending, setPending, onText, filled, partial = null }) {
  const c = ESSAY_COPY.criteriaPhoto;
  const { run, busy, error, errorDetailRef } = useTask(session, allowanceApi.applyFraction);
  const [local, setLocal] = useState(null);
  const [unreadable, setUnreadable] = useState(null);
  const working = busy || pending;

  const send = async (fileList) => {
    setLocal(null);
    setUnreadable(null);
    const files = [...fileList].filter((f) => f && /^image\//.test(f.type || "image/"));
    if (files.length === 0) return;
    if (files.length > PHOTOS_PER_CHUNK) return setLocal(c.tooMany(PHOTOS_PER_CHUNK));
    setPending(true);
    try {
      const images = [];
      for (const f of files) images.push(await downscalePhoto(f, { maxEdge: CRITERIA_PHOTO_MAX_EDGE }));
      const out = await run("criteria", { images });
      if (out && out.criteria) onText(out.criteria, null);
      else {
        const detail = errorDetailRef.current;
        if (detail && Array.isArray(detail.pages)) setUnreadable(detail.pages);
        /* PARTIAL: what was read goes in the box, marked incomplete. */
        if (detail && detail.code === "criteria_partial") onText(typeof detail.criteria === "string" ? detail.criteria : "", Array.isArray(detail.missed) ? detail.missed : []);
      }
    } catch (e) {
      setLocal(AI_TEXT_FAILURES.server_error ? AI_TEXT_FAILURES.server_error.title : null);
    } finally {
      setPending(false);
    }
  };

  const failure = error && error !== "pages_unreadable" && error !== "criteria_partial" ? AI_TEXT_FAILURES[error] : null;
  return (
    <div data-criteria-photo className="mt-2 space-y-1">
      <label className={`${btnGhost} cursor-pointer ${working ? "pointer-events-none opacity-40" : ""}`}>
        <Camera size={14} /> {working ? c.working : c.button}
        {/* No `capture`: it would hide the photo library and files (see
            the readings picker). Images only; the essay is never a photo. */}
        <input
          data-criteria-photo-input
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          disabled={working}
          onChange={(e) => {
            send(e.target.files || []);
            e.target.value = "";
          }}
        />
      </label>
      <p data-criteria-photo-cost className="text-xs text-stone-500">{c.cost(TASK_CREDITS.criteria, PHOTOS_PER_CHUNK)}</p>
      {partial && !working && <p data-criteria-photo-partial className="text-xs text-amber-800">{c.partial(partial)}</p>}
      {filled && !partial && !working && <p data-criteria-photo-done className="text-xs text-stone-600">{c.done}</p>}
      {unreadable && <p data-criteria-photo-error className="text-xs text-amber-800">{c.unreadable(unreadable)}</p>}
      {failure && (
        <p data-criteria-photo-error className="text-xs text-amber-800">
          {failure.title} {typeof failure.detail === "string" ? failure.detail : ""}
        </p>
      )}
      {local && <p className="text-xs text-amber-800">{local}</p>}
    </div>
  );
}

/**
 * "Feedback on a draft", on the AI tab: one optional course, then the
 * same panel as the Grades row, open and on this tab. The run is filed
 * under a placeholder assessment PlannerApp creates on delivery
 * (essayFeedback.js), so the mark loop works from the Grades row later.
 */
export function EssayDraftCard({ courses, course, onCourse, children }) {
  const c = ESSAY_COPY.entry;
  return (
    <div data-essay-draft-card className="space-y-2 rounded-xl border border-stone-200 bg-surface p-3">
      <div>
        <label className={labelCls}>{c.courseLabel}</label>
        <div data-essay-draft-course>
          <CourseSelect courses={courses} value={course} onChange={onCourse} />
        </div>
        <p className="mt-1 text-xs text-stone-500">{c.where}</p>
      </div>
      {children}
    </div>
  );
}

/**
 * On a draft filed from the AI tab: link it to the real assessment, so
 * the mark entered there is joined to this feedback. A plain control;
 * Grace restyles. The rules are linkPlaceholder in essayFeedback.js.
 */
export function PlaceholderLink({ placeholder, targets, onLink }) {
  const c = ESSAY_COPY.link;
  const [choice, setChoice] = useState("");
  /* Linking tombstones this row, so the confirmation lives on the real
     assessment's row (LinkedNote), which is where the student looks next. */
  if (!targets.length) return <p data-placeholder-link-none className="px-3 pb-2 text-xs text-stone-500">{c.none}</p>;
  return (
    <div data-placeholder-link className="flex flex-wrap items-center gap-2 px-3 pb-2 text-xs text-stone-600">
      <label htmlFor={`link-${placeholder.id}`}>{c.label}</label>
      <select
        id={`link-${placeholder.id}`}
        data-placeholder-link-target
        className="rounded border border-stone-200 bg-surface px-2 py-1 text-sm u-field"
        value={choice}
        onChange={(e) => setChoice(e.target.value)}
      >
        <option value="">{c.choose}</option>
        {targets.map((t) => (
          <option key={t.id} value={t.id}>
            {t.title}
          </option>
        ))}
      </select>
      <button
        data-placeholder-link-go
        className={`${btnGhost} disabled:cursor-not-allowed disabled:opacity-40`}
        disabled={!choice}
        onClick={() => {
          if (targets.some((x) => x.id === choice)) onLink(choice);
        }}
      >
        {c.go}
      </button>
    </div>
  );
}

/** On a real assessment with drafts linked to it: says so, lastingly. */
export function LinkedNote({ assessment }) {
  const n = Array.isArray(assessment && assessment.linkedFrom) ? assessment.linkedFrom.length : 0;
  if (!n) return null;
  return <p data-linked-note className="px-3 pb-2 text-xs text-stone-600">{ESSAY_COPY.link.linkedNote(n)}</p>;
}
