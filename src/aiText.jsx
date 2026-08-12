/* ==================================================================
   aiText.jsx — the four text AI features

   All four share one frame, and the frame is the point: every feature
   says what it will cost BEFORE the student does the work. Typing out a
   full explanation and only then learning the allowance is gone is a
   worse experience than being told up front, and a worse advertisement
   for the paid tier -- it reads as a bait rather than as a limit.

   NO WORDING LIVES HERE. Everything a student reads comes from
   aiTextCopy.js, so a round of notes on the writing is a round of
   editing one file.
   ================================================================== */

import { useEffect, useState } from "react";
import { Sparkles, X, TriangleAlert, RefreshCw, Check } from "lucide-react";
import {
  AI_TEXT_FAILURES,
  describeTextFailure,
  describeExhausted,
  allowanceLine,
  LAST_ACTION_WARNING,
} from "./aiTextCopy.js";
import { allowanceState, canAfford, isLastAction, TASK_UNITS } from "./aiTextLimits.js";
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
              {LAST_ACTION_WARNING}
            </p>
          )}
          {children}
        </>
      )}

      {error && <FailureNotice code={error} />}
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

function FailureNotice({ code }) {
  const copy = describeTextFailure(code);
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

/** One place that runs a task, so every feature handles failure identically. */
function useTask(session, applyFraction) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const run = async (task, payload) => {
    setBusy(true);
    setError(null);
    try {
      const res = await callAiText({ token: session.token, task, payload });
      applyFraction(res.allowanceUsed);
      return res.result;
    } catch (err) {
      setError(err.code || "server_error");
      return null;
    } finally {
      setBusy(false);
    }
  };

  return { run, busy, error, clearError: () => setError(null) };
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

  const text = (page && (page.body || "")).trim();
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
