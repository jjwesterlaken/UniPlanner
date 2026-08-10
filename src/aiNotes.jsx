/* ==================================================================
   aiNotes.jsx — AI lecture notes UI

   Record -> transcribe -> structured summary -> optional translation
   -> saved as a normal note. Kept in its own module (with
   aiNotesLogic.js and aiNotesClient.js) rather than folded into
   PlannerApp.jsx: this feature is a multi-step async state machine
   with MediaRecorder, a genuine blocking overlay and retryable
   network calls, which is a different shape of complexity than the
   rest of the app's CRUD-over-array sections.
   ================================================================== */

import { useEffect, useReducer, useRef, useState } from "react";
import { Mic, Square, Pause, Play, Check, X, TriangleAlert, RefreshCw, Globe } from "lucide-react";
import { ConsentGate } from "./aiNotesConsent.jsx";
import {
  AI_CONSENT_VERSION,
  needsConsent,
  buildConsentPatch,
  pickSupportedMimeType,
  RECORDER_AUDIO_BITS_PER_SECOND,
  MONTHLY_MINUTES_LIMIT_HINT,
  describeRecorderError,
  parseAiNotesError,
  PERMANENT_FAILURE_CODES,
  mapAiResultToItems,
  recorderReducer,
  INITIAL_RECORDER_STATE,
  TRANSLATION_LANGUAGES,
  newIdempotencyKey,
} from "./aiNotesLogic.js";
import { fetchUsage, uploadAudio, callAiNotes } from "./aiNotesClient.js";
import { nowISO } from "./sync.js";
import { inputCls, labelCls, btnPrimary, btnGhost, iconBtn, Card, CourseSelect, uid } from "./PlannerApp.jsx";

/* ------------------------------------------------------------------ */
/*  Usage badge                                                       */
/* ------------------------------------------------------------------ */

function UsageBadge({ session }) {
  const [usage, setUsage] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetchUsage(session).then((u) => {
      if (!cancelled) setUsage(u);
    });
    return () => {
      cancelled = true;
    };
  }, [session && session.user.id]);

  if (!usage || usage.unavailable) return null;
  const near = usage.minutesUsed >= MONTHLY_MINUTES_LIMIT_HINT * 0.9;
  return (
    <div className={`mb-3 flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs ${near ? "bg-amber-50 text-amber-800" : "bg-stone-100 text-stone-500"}`}>
      {near && <TriangleAlert size={13} />}
      {Math.round(usage.minutesUsed)} of {MONTHLY_MINUTES_LIMIT_HINT} AI minutes used this month
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Level meter                                                       */
/* ------------------------------------------------------------------ */

function LevelMeter({ level }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-stone-100">
      <div className="h-full u-accent-bg transition-all" style={{ width: `${Math.min(100, Math.round(level * 100))}%` }} />
    </div>
  );
}

function formatElapsed(totalSeconds) {
  const m = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const s = String(totalSeconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

/* ------------------------------------------------------------------ */
/*  useLectureRecorder — owns MediaRecorder/AudioContext side effects  */
/* ------------------------------------------------------------------ */

function useLectureRecorder() {
  const [state, dispatch] = useReducer(recorderReducer, INITIAL_RECORDER_STATE);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [level, setLevel] = useState(0);

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const rafRef = useRef(null);
  const wakeLockRef = useRef(null);
  const startTimeRef = useRef(0);
  const pausedMsRef = useRef(0);
  const pauseStartRef = useRef(0);

  const cleanupStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
    }
  };

  useEffect(() => () => cleanupStream(), []);

  const tickLevel = () => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let sumSquares = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sumSquares += v * v;
    }
    setLevel(Math.sqrt(sumSquares / data.length));
    rafRef.current = requestAnimationFrame(tickLevel);
  };

  const start = async () => {
    dispatch({ type: "request" });
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      dispatch({ type: "requestDenied", message: describeRecorderError(err) });
      return;
    }

    const picked = pickSupportedMimeType();
    if (!picked) {
      stream.getTracks().forEach((t) => t.stop());
      dispatch({ type: "requestDenied", message: "This browser can't record audio in a supported format." });
      return;
    }

    streamRef.current = stream;
    chunksRef.current = [];
    const recorder = new MediaRecorder(stream, {
      mimeType: picked.mimeType,
      audioBitsPerSecond: RECORDER_AUDIO_BITS_PER_SECOND,
    });
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunksRef.current.push(e.data);
    };
    mediaRecorderRef.current = recorder;

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      rafRef.current = requestAnimationFrame(tickLevel);
    } catch (e) {
      /* level meter is a nice-to-have; recording still works without it */
    }

    if (navigator.wakeLock) {
      navigator.wakeLock
        .request("screen")
        .then((wl) => {
          wakeLockRef.current = wl;
        })
        .catch(() => {});
    }

    startTimeRef.current = Date.now();
    pausedMsRef.current = 0;
    setElapsedSeconds(0);
    recorder.start(1000);
    dispatch({ type: "started" });
  };

  useEffect(() => {
    if (state.status !== "recording") return;
    const t = setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startTimeRef.current - pausedMsRef.current) / 1000)));
    }, 250);
    return () => clearInterval(t);
  }, [state.status]);

  const pause = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.pause();
      pauseStartRef.current = Date.now();
      dispatch({ type: "pause" });
    }
  };

  const resume = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "paused") {
      mediaRecorderRef.current.resume();
      pausedMsRef.current += Date.now() - pauseStartRef.current;
      dispatch({ type: "resume" });
    }
  };

  const stop = () =>
    new Promise((resolve) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder) return resolve();
      const mimeType = recorder.mimeType;
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const estimatedDurationSeconds = Math.max(
          1,
          Math.floor((Date.now() - startTimeRef.current - pausedMsRef.current) / 1000)
        );
        cleanupStream();
        // A UUID, not uid(): this value goes into a `uuid` column.
        dispatch({ type: "stop", blob, mimeType, idempotencyKey: newIdempotencyKey(), estimatedDurationSeconds });
        resolve();
      };
      recorder.stop();
    });

  const discard = () => {
    cleanupStream();
    setElapsedSeconds(0);
    setLevel(0);
    dispatch({ type: "discard" });
  };

  return { state, dispatch, elapsedSeconds, level, start, pause, resume, stop, discard };
}

/* ------------------------------------------------------------------ */
/*  Recorder controls (presentational)                                */
/* ------------------------------------------------------------------ */

function RecorderControls({ status, elapsedSeconds, level, onStart, onPause, onResume, onStop }) {
  const stopBtn =
    "inline-flex items-center justify-center gap-1.5 rounded-lg bg-rose-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-rose-700 u-focus transition-colors";
  return (
    <div className="flex flex-col items-center gap-3 py-4">
      <div className="font-mono text-3xl text-stone-700">{formatElapsed(elapsedSeconds)}</div>
      {(status === "recording" || status === "paused") && (
        <div className="w-full max-w-xs">
          <LevelMeter level={status === "recording" ? level : 0} />
        </div>
      )}
      <div className="flex gap-2">
        {status === "idle" && (
          <button className={btnPrimary} onClick={onStart}>
            <Mic size={16} /> Start recording
          </button>
        )}
        {status === "requesting" && (
          <button className={btnPrimary} disabled>
            <Mic size={16} /> Requesting microphone…
          </button>
        )}
        {status === "recording" && (
          <>
            <button className={btnGhost} onClick={onPause}>
              <Pause size={16} /> Pause
            </button>
            <button className={stopBtn} onClick={onStop}>
              <Square size={16} /> Stop
            </button>
          </>
        )}
        {status === "paused" && (
          <>
            <button className={btnGhost} onClick={onResume}>
              <Play size={16} /> Resume
            </button>
            <button className={stopBtn} onClick={onStop}>
              <Square size={16} /> Stop
            </button>
          </>
        )}
      </div>
      {(status === "recording" || status === "paused") && (
        <p className="text-xs text-stone-400">Keep this screen on while recording — locking it may stop recording on some devices.</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Review + save                                                     */
/* ------------------------------------------------------------------ */

function ReviewAndSave({ result, onSave, onDiscard }) {
  if (result.summaryFailed) {
    return (
      <div className="space-y-3">
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <TriangleAlert size={14} className="mr-1 inline" />
          We transcribed your lecture but couldn't generate a summary. You can still save the raw transcript.
        </p>
        <div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
          {result.transcript}
        </div>
        <div className="flex justify-end gap-2">
          <button className={btnGhost} onClick={onDiscard}>
            <X size={15} /> Discard
          </button>
          <button className={btnPrimary} onClick={onSave}>
            <Check size={15} /> Save transcript as a note
          </button>
        </div>
      </div>
    );
  }

  const { overview, keyPoints, terms, assessable, openQuestions } = result.original;
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-stone-700">Overview</h3>
        <p className="mt-1 text-sm text-stone-600">{overview}</p>
      </div>
      {keyPoints && keyPoints.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-stone-700">Key points</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-stone-600">
            {keyPoints.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {terms && terms.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-stone-700">Study cards ({terms.length})</h3>
          <ul className="mt-1 space-y-1 text-sm text-stone-600">
            {terms.map((t, i) => (
              <li key={i}>
                <span className="font-medium">{t.term}</span> — {t.content}
              </li>
            ))}
          </ul>
        </div>
      )}
      {assessable && assessable.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-stone-700">Might be assessed</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-stone-600">
            {assessable.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {openQuestions && openQuestions.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-stone-700">Open questions</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-stone-600">
            {openQuestions.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {result.translated && (
        <p className="flex items-center gap-1 text-xs text-stone-400">
          <Globe size={12} /> A translated version was also generated and will be saved alongside the English original.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button className={btnGhost} onClick={onDiscard}>
          <X size={15} /> Discard
        </button>
        <button className={btnPrimary} onClick={onSave}>
          <Check size={15} /> Save to Notes
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Recorder — course/week form + drives the whole flow                */
/* ------------------------------------------------------------------ */

function Recorder({ session, courses, addItem }) {
  const { state, dispatch, elapsedSeconds, level, start, pause, resume, stop, discard } = useLectureRecorder();
  const [course, setCourse] = useState("");
  const [week, setWeek] = useState("");
  const [translateTo, setTranslateTo] = useState("");

  const runUpload = async () => {
    dispatch({ type: "upload" });
    try {
      const path = await uploadAudio({
        session,
        audioBlob: state.blob,
        mimeType: state.mimeType,
        idempotencyKey: state.idempotencyKey,
      });
      const result = await callAiNotes({
        token: session.token,
        path,
        mimeType: state.mimeType,
        course,
        week,
        translateTo: translateTo || null,
        idempotencyKey: state.idempotencyKey,
        estimatedDurationSeconds: state.estimatedDurationSeconds,
      });
      dispatch({ type: "processed", result });
    } catch (err) {
      const message = err.body ? parseAiNotesError(err.body, err.status) : err.message;
      dispatch({ type: "uploadFailed", code: err.code, message });
    }
  };

  useEffect(() => {
    if (state.status === "stopped") runUpload();
    // Deliberately only re-runs when status itself changes (not on every
    // course/week/translateTo keystroke) — those are read fresh from this
    // closure at the moment recording stops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status]);

  const onSave = () => {
    dispatch({ type: "save" });
    try {
      const { pageItem, noteItems } = mapAiResultToItems({
        result: state.result,
        course,
        week,
        language: translateTo || null,
        uid,
        nowISO,
      });
      addItem("pages", pageItem);
      noteItems.forEach((n) => addItem("notes", n));
      dispatch({ type: "saved" });
    } catch (err) {
      dispatch({ type: "saveFailed", message: err.message || "Couldn't save this note. Please try again." });
    }
  };

  const showForm = state.status === "idle";
  const showControls = ["idle", "requesting", "recording", "paused"].includes(state.status);

  return (
    <Card>
      <UsageBadge session={session} />

      {showForm && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>Course</label>
            <CourseSelect value={course} onChange={setCourse} courses={courses} />
          </div>
          <div>
            <label className={labelCls}>Week</label>
            <input
              type="number"
              min="1"
              className={inputCls}
              placeholder="e.g. 5"
              value={week}
              onChange={(e) => setWeek(e.target.value)}
            />
          </div>
          <div className="col-span-2">
            <label className={labelCls}>Translate into (optional — the English version is always kept too)</label>
            <select className={inputCls} value={translateTo} onChange={(e) => setTranslateTo(e.target.value)}>
              <option value="">English only</option>
              {TRANSLATION_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {showControls && (
        <RecorderControls
          status={state.status}
          elapsedSeconds={elapsedSeconds}
          level={level}
          onStart={start}
          onPause={pause}
          onResume={resume}
          onStop={stop}
        />
      )}

      {state.status === "uploading" && (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-stone-500">
          <RefreshCw size={16} className="animate-spin" /> Uploading and transcribing…
        </div>
      )}

      {state.status === "error" && (
        <div className="space-y-3 py-2">
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{state.errorMessage}</p>
          <div className="flex justify-end gap-2">
            <button className={btnGhost} onClick={discard}>
              <X size={15} /> Discard
            </button>
            {state.blob && !PERMANENT_FAILURE_CODES.has(state.errorCode) && (
              <button className={btnPrimary} onClick={runUpload}>
                <RefreshCw size={15} /> Try again
              </button>
            )}
          </div>
        </div>
      )}

      {state.status === "review" && state.result && (
        <>
          {state.errorMessage && (
            <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{state.errorMessage}</p>
          )}
          <ReviewAndSave result={state.result} onSave={onSave} onDiscard={discard} />
        </>
      )}

      {state.status === "saving" && (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-stone-500">
          <RefreshCw size={16} className="animate-spin" /> Saving…
        </div>
      )}

      {state.status === "done" && (
        <div className="space-y-3 py-4">
          <p className="flex items-center gap-2 text-sm u-accent-text">
            <Check size={16} /> Saved — check the Notes and Study tabs.
          </p>
          <button className={btnGhost} onClick={discard}>
            Record another lecture
          </button>
        </div>
      )}

      <p className="mt-4 text-xs text-stone-400">
        Audio is uploaded for processing and deleted immediately after transcription — it isn't stored long-term.
      </p>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Panel — consent + account gating, then the recorder                */
/* ------------------------------------------------------------------ */

export function AiNotesPanel({ session, backend, courses, data, setData, addItem }) {
  if (!session || backend.isDemo) {
    return (
      <Card>
        <p className="text-sm text-stone-500">
          AI notes needs a real signed-in account. Sign in (or create one) from the Account tab first.
        </p>
      </Card>
    );
  }

  if (needsConsent(data.meta)) {
    return (
      <ConsentGate
        onAccept={() =>
          setData((d) => ({ ...d, meta: { ...d.meta, ...buildConsentPatch(AI_CONSENT_VERSION, nowISO) } }))
        }
      />
    );
  }

  return <Recorder session={session} courses={courses} addItem={addItem} />;
}

/* ------------------------------------------------------------------ */
/*  Viewer for a saved AI note (opened from Notes/Folders)             */
/* ------------------------------------------------------------------ */

export function AiLectureNoteView({ page, patchItem, onClose }) {
  const translations = (page && page.aiMeta && page.aiMeta.translations) || {};
  const langs = Object.keys(translations);
  const [activeLang, setActiveLang] = useState((page && page.aiMeta && page.aiMeta.activeLanguage) || "en");

  if (!page) return null;
  const content = translations[activeLang] || translations.en;

  const onLangChange = (code) => {
    setActiveLang(code);
    if (patchItem && page.aiMeta) {
      patchItem("pages", page.id, { aiMeta: { ...page.aiMeta, activeLanguage: code } });
    }
  };

  return (
    <Card className="mt-3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-serif text-base font-semibold text-stone-800">{page.title}</h3>
        <button className={iconBtn} onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>

      {langs.length > 1 && (
        <select className={`${inputCls} mt-2 max-w-xs`} value={activeLang} onChange={(e) => onLangChange(e.target.value)}>
          {langs.map((code) => (
            <option key={code} value={code}>
              {code === "en" ? "English" : (TRANSLATION_LANGUAGES.find((l) => l.code === code) || {}).label || code}
            </option>
          ))}
        </select>
      )}

      {content ? (
        <div className="mt-3 space-y-3 text-sm text-stone-600">
          <p>{content.overview}</p>
          {content.keyPoints && content.keyPoints.length > 0 && (
            <ul className="list-disc space-y-1 pl-5">
              {content.keyPoints.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          )}
          {content.assessable && content.assessable.length > 0 && (
            <div>
              <p className="font-medium text-stone-700">Might be assessed</p>
              <ul className="list-disc space-y-1 pl-5">
                {content.assessable.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          {content.openQuestions && content.openQuestions.length > 0 && (
            <div>
              <p className="font-medium text-stone-700">Open questions</p>
              <ul className="list-disc space-y-1 pl-5">
                {content.openQuestions.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <p className="mt-3 whitespace-pre-wrap text-sm text-stone-600">{page.body}</p>
      )}
    </Card>
  );
}
