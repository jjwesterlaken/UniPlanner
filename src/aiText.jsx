/* ==================================================================
   aiText.jsx — the text AI features

   All of them share one frame, and the frame is the point: every feature
   says what it will cost BEFORE the student does the work. Typing out a
   full explanation and only then learning the allowance is gone is a
   worse experience than being told up front, and a worse advertisement
   for the paid tier -- it reads as a bait rather than as a limit.

   NO WORDING LIVES HERE. Everything a student reads comes from
   aiTextCopy.js, so a round of notes on the writing is a round of
   editing one file.
   ================================================================== */

import { useEffect, useMemo, useRef, useState } from "react";
import { Sparkles, X, TriangleAlert, RefreshCw, Check, Camera } from "lucide-react";
import {
  AI_TEXT_FAILURES,
  describeTextFailure,
  describeExhausted,
  allowanceLine,
  lastActionWarning,
  READING_COPY,
} from "./aiTextCopy.js";
import {
  allowanceState,
  canAfford,
  isLastAction,
  canAffordCredits,
  sectionsAffordable,
  TASK_CREDITS,
} from "./aiTextLimits.js";
import { estimateReading, estimatePhotos, photoNumberFor, combineParts, MAX_READING_PHOTOS } from "./readingChunks.js";
import { bodyOf } from "./noteBlocks.js";
import { ConsentGate } from "./aiNotesConsent.jsx";
import { fetchTextAllowance, callAiText } from "./aiTextClient.js";
import { btnPrimary, btnGhost, iconBtn, inputCls, labelCls, Card } from "./PlannerApp.jsx";

/* ------------------------------------------------------------------ */
/*  The shared frame                                                  */
/* ------------------------------------------------------------------ */

/** Reads the allowance once per mount. Cheap: two RLS-scoped selects, no endpoint. */
export function useTextAllowance(session) {
  const [state, setState] = useState(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchTextAllowance(session).then((s) => {
      if (!cancelled) setState(s);
    });
    return () => {
      cancelled = true;
    };
  }, [session && session.user.id, nonce]);

  /* Called after a successful action so the line moves without a
     refetch. The server's fraction is authoritative -- this is the
     number it just told us, not a local guess. */
  const applyFraction = (fraction) =>
    setState((prev) => (prev && !prev.unavailable ? { ...prev, fraction, used: Math.round(fraction * prev.limit), remaining: Math.max(0, prev.limit - Math.round(fraction * prev.limit)) } : prev));

  return { allowance: state, refresh: () => setNonce((n) => n + 1), applyFraction };
}

/**
 * Everything a feature shows around its own controls.
 *
 * The order is deliberate: what's left, then whether this action fits,
 * then the controls. A student should never reach an input they cannot
 * afford to use.
 */
export function AiActionFrame({ title, task, allowance, error, busy, children, footer }) {
  /* An unavailable allowance means we could not read it -- offline, demo
     mode, no account. It must NOT read as "none left": showing a paywall
     because someone went into a tunnel is the failure worth avoiding
     more than an occasionally-missing line. */
  const unknown = !allowance || allowance.unavailable;
  const exhausted = !unknown && !canAfford(allowance, task);
  const last = !unknown && isLastAction(allowance, task);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Sparkles size={15} className="u-accent-text" />
        <h3 className="text-sm font-semibold text-stone-700">{title}</h3>
      </div>

      {!unknown && <p className="text-xs text-stone-500">{allowanceLine(allowance)}</p>}

      {exhausted ? (
        <ExhaustedNotice allowance={allowance} />
      ) : (
        <>
          {last && (
            <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <TriangleAlert size={13} className="mt-0.5 shrink-0" />
              {lastActionWarning(allowance)}
            </p>
          )}
          {children}
        </>
      )}

      {error && <FailureNotice code={error} allowance={allowance} />}
      {busy && <p className="text-xs text-stone-400">Working…</p>}
      {footer}
    </div>
  );
}

function ExhaustedNotice({ allowance }) {
  const copy = describeExhausted(allowance);
  return (
    <div className="rounded-lg bg-stone-100 px-3 py-2.5 text-sm">
      <p className="font-medium text-stone-700">{copy.title}</p>
      <p className="mt-0.5 text-stone-600">{copy.detail}</p>
    </div>
  );
}

function FailureNotice({ code, allowance }) {
  const copy = describeTextFailure(code, allowance);
  /* A charged failure is amber rather than grey. The student lost
     allowance for a result they never saw, and that deserves to look
     like something happened. */
  const charged = code === "ai_failed_charged";
  return (
    <div className={`rounded-lg px-3 py-2.5 text-sm ${charged ? "bg-amber-50 text-amber-900" : "bg-stone-100 text-stone-600"}`}>
      <p className="font-medium">{copy.title}</p>
      <p className="mt-0.5">{copy.detail}</p>
    </div>
  );
}


/* A page photo, downscaled CLIENT-SIDE before it goes anywhere: 1536px
   on the long edge (plenty for print, and the size the provider's
   high-detail tiling actually reads), JPEG at 0.8. This is what keeps a
   12MP camera original off the wire and under the server's per-image
   cap -- the cap exists for hand-built requests, not for this path. */
async function downscalePhoto(file, { maxEdge = 1536, quality = 0.8 } = {}) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("could not read the image"));
      el.src = url;
    });
    const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** One place that runs a task, so every feature handles failure identically. */
function useTask(session, applyFraction) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [errorDetail, setErrorDetail] = useState(null);
  /* The ref is the synchronous copy: a caller looping over parts reads
     the failure body IN THE SAME TICK the null came back, before React
     has re-rendered. State alone would hand it last render's value. */
  const errorDetailRef = useRef(null);

  const run = async (task, payload) => {
    setBusy(true);
    setError(null);
    setErrorDetail(null);
    errorDetailRef.current = null;
    try {
      const res = await callAiText({ token: session.token, task, payload });
      applyFraction(res.allowanceUsed);
      return res.result;
    } catch (err) {
      setError(err.code || "server_error");
      /* The body rides along for codes that carry something actionable
         -- pages_unreadable's page list is the one today. Kept separate
         from `error` so every existing `error === code` check is
         untouched. */
      setErrorDetail((err && err.body) || null);
      errorDetailRef.current = (err && err.body) || null;
      return null;
    } finally {
      setBusy(false);
    }
  };

  return { run, busy, error, errorDetail, errorDetailRef, clearError: () => setError(null) };
}

/* ------------------------------------------------------------------ */
/*  1. Practice questions  (Study tab)                                */
/* ------------------------------------------------------------------ */

export function PracticePanel({ session, cards = [], onRecordAttempt, allowanceApi }) {
  const { allowance, applyFraction } = allowanceApi;
  const { run, busy, error } = useTask(session, applyFraction);
  const [questions, setQuestions] = useState(null);
  const [marks, setMarks] = useState({});
  const [askedIds, setAskedIds] = useState([]);

  const pool = cards.filter((c) => c && !c.deletedAt);

  const start = async () => {
    // Newest first, so practice follows what was studied most recently.
    const picked = pool.slice(-10);
    setAskedIds(picked.map((c) => c.id));
    setMarks({});
    const result = await run("practice", { cards: picked.map((c) => ({ term: c.term, content: c.content })) });
    setQuestions(result ? result.questions : null);
  };

  const finish = () => {
    /* The ATTEMPT is stored, not the questions -- see practice.js. The
       questions go when this component unmounts, which is correct: they
       would be stale the moment a card is edited. */
    const correctIds = askedIds.filter((_, i) => marks[i] === true);
    onRecordAttempt({ cardIds: askedIds, correctIds });
    setQuestions(null);
    setMarks({});
  };

  return (
    <Card className="mt-3">
      <AiActionFrame title="Practice questions" task="practice" allowance={allowance} error={error} busy={busy}>
        {pool.length === 0 ? (
          <p className="text-sm text-stone-500">Make some study cards first — practice questions are written from them.</p>
        ) : !questions ? (
          <div className="space-y-2">
            <p className="text-sm text-stone-600">
              Questions written from your {Math.min(10, pool.length)} most recent study {pool.length === 1 ? "card" : "cards"}, asking
              you to use them rather than recite them.
            </p>
            <button className={btnPrimary} onClick={start} disabled={busy}>
              <Sparkles size={15} /> Write me some questions
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {questions.map((q, i) => (
              <QuestionRow key={i} q={q} mark={marks[i]} onMark={(v) => setMarks((m) => ({ ...m, [i]: v }))} />
            ))}
            <button className={btnPrimary} onClick={finish}>
              <Check size={15} /> Done
            </button>
          </div>
        )}
      </AiActionFrame>
    </Card>
  );
}

function QuestionRow({ q, mark, onMark }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="rounded-lg border border-stone-200 p-2.5">
      <p className="text-sm font-medium text-stone-700">{q.q}</p>
      {shown ? (
        <>
          <p className="mt-1.5 text-sm text-stone-600">{q.a}</p>
          {q.why && <p className="mt-1 text-xs text-stone-400">{q.why}</p>}
          <div className="mt-2 flex gap-2">
            <button className={mark === true ? btnPrimary : btnGhost} onClick={() => onMark(true)}>
              I got it
            </button>
            <button className={mark === false ? btnPrimary : btnGhost} onClick={() => onMark(false)}>
              I didn't
            </button>
          </div>
        </>
      ) : (
        <button className={`${btnGhost} mt-2`} onClick={() => setShown(true)}>
          Show answer
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  2. Weak spots — an explanation on the existing panel              */
/* ------------------------------------------------------------------ */

export function WeakSpotsExplain({ session, topics = [], allowanceApi }) {
  const { allowance, applyFraction } = allowanceApi;
  const { run, busy, error } = useTask(session, applyFraction);
  const [result, setResult] = useState(null);

  if (topics.length === 0) return null;

  return (
    <div className="mt-3 border-t border-stone-100 pt-3">
      <AiActionFrame title="Why these keep slipping" task="weakspots" allowance={allowance} error={error} busy={busy}>
        {result ? (
          <div className="space-y-2">
            {result.overall && <p className="text-sm text-stone-600">{result.overall}</p>}
            {result.topics.map((t, i) => (
              <div key={i} className="rounded-lg bg-stone-50 p-2.5">
                <p className="text-sm font-medium text-stone-700">{t.term}</p>
                <p className="mt-0.5 text-sm text-stone-600">{t.why}</p>
                {t.try && <p className="mt-1 text-sm u-accent-deeptext">{t.try}</p>}
              </div>
            ))}
            <button className={btnGhost} onClick={() => setResult(null)}>
              <RefreshCw size={15} /> Clear
            </button>
          </div>
        ) : (
          <button
            className={btnGhost}
            disabled={busy}
            onClick={async () =>
              setResult(await run("weakspots", { topics: topics.map((t) => ({ term: t.term, lapses: t.lapses })) }))
            }
          >
            <Sparkles size={15} /> Explain why these keep slipping
          </button>
        )}
      </AiActionFrame>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  3. Explain it back — on a study card                              */
/* ------------------------------------------------------------------ */

/**
 * The most intrusive of the four: a text box on a screen students use
 * daily. It is therefore COLLAPSED by default and opens only when asked,
 * so the review flow is unchanged for anyone who never touches it.
 */
export function ExplainItBack({ session, card, allowanceApi }) {
  const { allowance, applyFraction } = allowanceApi;
  const { run, busy, error, clearError } = useTask(session, applyFraction);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [result, setResult] = useState(null);

  if (!card) return null;

  if (!open) {
    return (
      <button className={`${btnGhost} mt-2`} onClick={() => setOpen(true)}>
        <Sparkles size={15} /> Explain it back
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-stone-200 p-2.5">
      <AiActionFrame title="Explain it back" task="explain" allowance={allowance} error={error} busy={busy}>
        {result ? (
          <div className="space-y-2 text-sm">
            <p className="font-medium text-stone-700">{result.verdict}</p>
            <ExplainList label="You had this right" items={result.correct} tone="text-emerald-700" />
            <ExplainList label="Worth adding" items={result.missing} tone="text-amber-800" />
            <ExplainList label="Have another look at" items={result.wrong} tone="text-rose-700" />
            <button
              className={btnGhost}
              onClick={() => {
                setResult(null);
                setText("");
              }}
            >
              <RefreshCw size={15} /> Try another
            </button>
          </div>
        ) : (
          <>
            <label className={labelCls}>Explain {card.term} in your own words</label>
            <textarea
              className={`${inputCls} min-h-24`}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                clearError();
              }}
              placeholder="Say it the way you'd say it to someone in your tutorial."
            />
            <div className="mt-2 flex gap-2">
              <button
                className={btnPrimary}
                disabled={busy || !text.trim()}
                onClick={async () => setResult(await run("explain", { topic: card.term, text }))}
              >
                <Check size={15} /> Check it
              </button>
              <button className={btnGhost} onClick={() => setOpen(false)}>
                <X size={15} /> Close
              </button>
            </div>
          </>
        )}
      </AiActionFrame>
    </div>
  );
}

const ExplainList = ({ label, items, tone }) =>
  items && items.length > 0 ? (
    <div>
      <p className={`text-xs font-medium ${tone}`}>{label}</p>
      <ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-stone-600">
        {items.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </div>
  ) : null;

/* ------------------------------------------------------------------ */
/*  4. Summarise a note I wrote                                       */
/* ------------------------------------------------------------------ */

/**
 * Produces the same shape ai-notes does, so the result goes down the
 * whole existing storage path -- stub, row, cache, reconciliation --
 * rather than becoming a second kind of AI note with its own rules.
 */
export function SummariseNote({ session, page, allowanceApi, onSummarised }) {
  const { allowance, applyFraction } = allowanceApi;
  const { run, busy, error } = useTask(session, applyFraction);

  /* THROUGH THE ACCESSOR, not off the page. This line was the one
     reader in the codebase left reading the legacy field directly --
     step 3's audit mapped every reader in PlannerApp.jsx and never
     looked here -- so when step 4b started writing body as "" on
     converted notes, this feature silently vanished for exactly the
     notes students edit. The gate and the payload broke together:
     even had the gate passed, the text SENT was the same empty string. */
  const text = bodyOf(page).trim();
  if (!text) return null;

  return (
    <div className="mt-3 border-t border-stone-100 pt-3">
      <AiActionFrame title="Summarise this note" task="summarise" allowance={allowance} error={error} busy={busy}>
        <p className="text-sm text-stone-600">
          Turns what you've written into the same structured notes a recorded lecture produces — overview, key points,
          and study cards you choose from. Your original note is kept exactly as it is.
        </p>
        <button
          className={`${btnPrimary} mt-2`}
          disabled={busy}
          onClick={async () => {
            const result = await run("summarise", { text });
            if (result) onSummarised(result);
          }}
        >
          <Sparkles size={15} /> Summarise it
        </button>
      </AiActionFrame>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  5. Summarise a reading  (on the reading row)                      */
/* ------------------------------------------------------------------ */

/**
 * Paste a section of a reading, get something to revise from.
 *
 * ON THE READING ROW, not a screen of its own. The student is looking
 * at "Ch. 4, pp. 89-112" when the thought "I should summarise this"
 * occurs, so the action belongs there — collapsed to one line, opening
 * inline. Same interaction shape as RubricPanel on an assignment, and
 * deliberately so: this app has one way of attaching a paste-and-do-
 * something panel to a row, and a second one would be a second thing to
 * learn.
 *
 * PASTE ONLY. No PDF parsing, no upload, no OCR, no stored library —
 * and that is the shape rather than a missing feature. What makes this
 * defensible is that the student supplies a piece at a time, of
 * material they already have, which is relayed and never stored; a bulk
 * upload with a library is a different product with a different answer.
 *
 * THERE IS NO ATTEMPT TO IDENTIFY WHAT THE TEXT IS. No heuristic for
 * "this looks published", because there isn't a reliable one and a
 * false positive blocks a student summarising their own handout — which
 * reads as the app being broken. The posture rests on the design facts
 * above and on the wording rule in aiTextCopy.js, not on content
 * identification this cannot do.
 *
 * Long readings are split (readingChunks.js), each part summarised, and
 * the parts combined by the `merge` task. A FAILED MERGE KEEPS THE
 * PARTS: each was summarised and each was charged, so discarding them
 * because the last cheap step failed would take the allowance and give
 * nothing back.
 */
export function SummariseReading({
  session,
  reading,
  summaryPage = null,
  allowanceApi,
  onSummarised,
  onOpenSummary,
  consentNeeded = false,
  onAcceptConsent,
  /* Standalone: the same tool mounted as a first-class home (the AI
     Notes tab) rather than as a one-line shortcut on a reading row.
     Two builders in a row failed to find the row control, and a
     control nobody finds is absence -- so the row stays as a shortcut
     into the same tool, and this stops it being the only door. The
     reading it receives standalone is just {course, week} from the
     hub's pickers; no id, so no sourceReadingId, which was always
     decorative. */
  standalone = false,
}) {
  const { allowance, applyFraction } = allowanceApi;
  const { run, busy, error, errorDetailRef } = useTask(session, applyFraction);

  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  /* PHOTOS LIVE IN COMPONENT STATE AND NOWHERE ELSE. Never the draft,
     never localStorage, gone on unmount -- the never-stored promise is
     a property of where this array can reach, and it can reach the
     request body and the screen. */
  const [photos, setPhotos] = useState([]);
  const [unreadable, setUnreadable] = useState(null); // photo numbers, 1-based
  const [result, setResult] = useState(null);
  const [progress, setProgress] = useState(null);
  const [mergeOutcome, setMergeOutcome] = useState(null); // null | "failed" | "charged"

  /* ONE MEDIUM PER RUN: pasted text or photographed pages, whichever
     the student supplied. A mixed run has no honest ordering, so the
     estimate follows whichever medium has content and the UI says so. */
  const usingPhotos = photos.length > 0;

  /* Memoised because it is not cheap and it is on the typing path:
     chunkReading splits and repacks the whole text, and at the 80,000
     character ceiling that is real work to redo on every keystroke. */
  const estimate = useMemo(
    () => (usingPhotos ? estimatePhotos(photos.length) : estimateReading(text)),
    [text, photos.length, usingPhotos]
  );

  const addPhotos = async (files) => {
    const room = MAX_READING_PHOTOS - photos.length;
    const take = [...files].slice(0, Math.max(0, room));
    const scaled = [];
    for (const f of take) {
      try {
        scaled.push(await downscalePhoto(f));
      } catch (e) {
        /* One unreadable file must not lose the batch -- skip it. The
           count line makes the miss visible. */
      }
    }
    if (scaled.length) {
      setPhotos((prev) => [...prev, ...scaled].slice(0, MAX_READING_PHOTOS));
      reset();
      setUnreadable(null);
    }
  };

  /* An unreadable allowance must not read as an exhausted one — a
     paywall caused by going into a tunnel is worse than a missing
     line. Same rule as AiActionFrame. */
  const unknown = !allowance || allowance.unavailable;
  const affordable = unknown || !estimate.ok || canAffordCredits(allowance, estimate.credits);

  const reset = () => {
    setResult(null);
    setMergeOutcome(null);
    setProgress(null);
    setUnreadable(null);
  };

  const go = async () => {
    reset();
    if (!estimate.ok) return;
    /* One list of requests, whichever medium: a text chunk or a photo
       batch is one `summarise` call either way, which is what lets the
       photo path ride the ENTIRE existing pipeline -- progress, the
       keep-what-was-charged rule on a failed part, the merge, the
       merge-failure fallback -- with no second scheme. */
    const requests = usingPhotos
      ? estimate.batches.map((b) => ({ payload: { images: photos.slice(b.start, b.start + b.size) }, batch: b }))
      : estimate.chunkTexts.map((t) => ({ payload: { text: t }, batch: null }));
    const parts = [];
    for (let i = 0; i < requests.length; i++) {
      setProgress({ done: i, total: requests.length });
      const part = await run("summarise", requests[i].payload);
      /* A part failing stops the run rather than pressing on with a hole
         in the middle. Whatever came back before it is kept and shown --
         it was done and it was charged. */
      if (!part) {
        /* The legibility refusal names positions within the batch the
           server saw; the student is looking at their whole photo
           strip, so translate before showing. run() has already stored
           the code and body -- this only maps the numbers. */
        const detail = errorDetailRef.current;
        if (requests[i].batch && detail && Array.isArray(detail.pages)) {
          setUnreadable(detail.pages.map((pos) => photoNumberFor(requests[i].batch, pos)));
        }
        break;
      }
      parts.push(part);
    }
    setProgress(null);
    if (parts.length === 0) return;

    if (parts.length === 1) {
      setResult({ ...parts[0], merged: true });
      return;
    }

    const merged = await run("merge", { parts });
    if (merged) {
      setResult({ ...merged, merged: true });
      return;
    }
    /* The merge failed. Combine locally -- no provider call, nothing
       further charged -- and say which kind of failure it was, because
       one cost the student allowance and the other didn't. */
    setMergeOutcome(error === "ai_failed_charged" ? "charged" : "failed");
    setResult(combineParts(parts));
  };

  const save = () => {
    onSummarised({ result, reading, sourceReadingId: reading.id });
    setOpen(false);
    setText("");
    reset();
  };

  /* ---- collapsed: one line on the row ---- */
  if (!open) {
    /* Already summarised: say so and link to it, rather than offering
       to do it again as if nothing had happened. Summarising again is
       still possible from inside — this is a signpost, not a lock. */
    if (summaryPage) {
      return (
        <button
          className="mt-1.5 text-xs font-medium u-accent-text hover:underline"
          onClick={() => onOpenSummary(summaryPage.id)}
        >
          <Check size={12} className="mr-0.5 inline" />
          {READING_COPY.summarisedLink}
        </button>
      );
    }
    if (standalone) {
      return (
        <button className={`${btnPrimary} w-full justify-center`} onClick={() => setOpen(true)}>
          <Sparkles size={15} /> {READING_COPY.rowAction}
        </button>
      );
    }
    return (
      <button className="mt-1.5 text-xs font-medium text-stone-500 hover:u-accent-text" onClick={() => setOpen(true)}>
        <Sparkles size={12} className="mr-0.5 inline" />
        {READING_COPY.rowAction}
      </button>
    );
  }

  /* ---- expanded: inline, in the row ---- */
  const cantAfford =
    estimate.ok && !affordable
      ? READING_COPY.cantAfford({
          chunks: estimate.chunks,
          sectionsLeft: sectionsAffordable(allowance),
          perMonth: allowance.perMonth,
        })
      : null;
  const mergeCopy = mergeOutcome === "charged" ? READING_COPY.mergeCharged : READING_COPY.mergeFailed;

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-stone-200 bg-stone-50 p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Sparkles size={14} className="u-accent-text" />
          <h4 className="text-sm font-semibold text-stone-700">{READING_COPY.title}</h4>
        </div>
        <button className={iconBtn} onClick={() => setOpen(false)} aria-label="Close">
          <X size={14} />
        </button>
      </div>

      {/* CONSENT IS ENFORCED HERE, at the point of use, and not by
          hiding the button. Consent v5 exists to describe supplied text
          going overseas, so a feature that sends it without agreement
          makes the document true on paper and false in the app -- but a
          feature nobody can see is not consent, it is absence, and the
          student never learns it exists.

          NOTE the other four text features are NOT gated. That gap
          predates this and closing it changes four existing screens, so
          it is reported rather than widened. */}
      {consentNeeded ? (
        <ConsentGate onAccept={onAcceptConsent} />
      ) : (
        <>
      {!unknown && <p className="text-xs text-stone-500">{allowanceLine(allowance)}</p>}
      <p className="text-xs text-stone-500">{READING_COPY.intro}</p>

      {!usingPhotos && (
        <>
          <textarea
            className={`${inputCls} min-h-[7rem]`}
            placeholder={READING_COPY.placeholder}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              reset();
            }}
          />
          <p className="text-xs text-stone-400">{READING_COPY.privacy}</p>
        </>
      )}

      {/* PHOTOGRAPHED PAGES. One medium per run: adding photos stands
          in for the paste box, and clearing them brings it back. */}
      {!text.trim() && (
        <div className="space-y-1.5">
          <label className={labelCls}>{READING_COPY.photosLabel}</label>
          {photos.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {photos.map((url, i) => (
                <span key={i} className="relative inline-block">
                  <img src={url} alt={`Page photo ${i + 1}`} className="h-16 w-12 rounded border border-stone-200 object-cover" />
                  <button
                    type="button"
                    aria-label={`Remove photo ${i + 1}`}
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-stone-700 text-white"
                    onClick={() => {
                      setPhotos((prev) => prev.filter((_, j) => j !== i));
                      reset();
                    }}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {photos.length < MAX_READING_PHOTOS && (
            <label className={`${btnGhost} cursor-pointer`}>
              <Camera size={15} /> {photos.length ? "Add more pages" : "Add photos of the pages"}
              {/* NO `capture` ATTRIBUTE, deliberately. `capture` does not
                  mean "offer the camera" — it means "use the camera and
                  nothing else", so it HID the photo library and the
                  files app on every phone. Without it the same input
                  offers all three routes (library, camera, files) and
                  desktop is unaffected either way. The accept list is
                  images only; a PDF is a different feature and is
                  deliberately not smuggled in here. */}
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  addPhotos(e.target.files || []);
                  e.target.value = "";
                }}
              />
            </label>
          )}
          {usingPhotos && (
            <>
              <p className="text-xs text-stone-400">{READING_COPY.photosPrivacy}</p>
              <p className="text-xs text-stone-400">{READING_COPY.photosQuality}</p>
            </>
          )}
        </div>
      )}

      {/* THE PRE-FLIGHT ESTIMATE, before anything is spent -- photos
          count in parts exactly the way text chunks do. */}
      {usingPhotos && estimate.ok && <p className="text-xs text-stone-500">{READING_COPY.photosEstimate(estimate)}</p>}
      {!usingPhotos && text.trim() && estimate.ok && <p className="text-xs text-stone-500">{READING_COPY.estimate(estimate)}</p>}

      {usingPhotos && estimate.code === "too_many" && (
        <p className="rounded-lg bg-stone-100 px-2.5 py-2 text-xs text-stone-600">
          {READING_COPY.photosTooMany({ count: estimate.count, max: estimate.maxPhotos })}
        </p>
      )}

      {unreadable && (
        <p className="rounded-lg bg-amber-50 px-2.5 py-2 text-xs font-medium text-amber-900">
          {READING_COPY.unreadablePages(unreadable)}
        </p>
      )}

      {estimate.code === "too_long" && (
        <p className="rounded-lg bg-stone-100 px-2.5 py-2 text-xs text-stone-600">
          {READING_COPY.tooLong({ chars: estimate.chars, limit: estimate.limit })}
        </p>
      )}

      {cantAfford && (
        <div className="rounded-lg bg-stone-100 px-2.5 py-2 text-xs">
          <p className="font-medium text-stone-700">{cantAfford.title}</p>
          <p className="mt-0.5 text-stone-600">{cantAfford.detail}</p>
        </div>
      )}

      {progress && (
        <p className="flex items-center gap-1.5 text-xs text-stone-500">
          <RefreshCw size={12} className="animate-spin" /> Part {progress.done + 1} of {progress.total}…
        </p>
      )}

      {/* The generic failure notice is suppressed once a merge failure
          has its own panel below: that one says something different
          about what was charged. */}
      {error && !mergeOutcome && <FailureNotice code={error} allowance={allowance} />}

      {mergeOutcome && (
        <div className="space-y-1 rounded-lg bg-amber-50 px-2.5 py-2 text-xs text-amber-900">
          <p className="font-medium">
            <TriangleAlert size={13} className="mr-1 inline" />
            {mergeCopy.title}
          </p>
          <p>{mergeCopy.billing}</p>
          <p>{mergeCopy.detail}</p>
        </div>
      )}

      {result ? (
        <div className="space-y-2 border-t border-stone-200 pt-2">
          <p className="text-sm text-stone-600">{result.overview}</p>
          {result.terms && result.terms.length > 0 && (
            <p className="text-xs text-stone-500">
              {result.terms.length} term{result.terms.length === 1 ? "" : "s"} — you'll pick which become study cards on
              the note.
            </p>
          )}
          <button className={btnPrimary} onClick={save}>
            <Check size={15} /> {READING_COPY.saveLabel}
          </button>
        </div>
      ) : (
        <button className={btnPrimary} disabled={busy || !estimate.ok || !affordable} onClick={go}>
          <Sparkles size={15} /> {READING_COPY.runLabel}
        </button>
      )}
        </>
      )}
    </div>
  );
}
