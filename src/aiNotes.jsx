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
import { Mic, Square, Pause, Play, Check, X, TriangleAlert, RefreshCw, Globe, Download } from "lucide-react";
import { ConsentGate } from "./aiNotesConsent.jsx";
import { SummariseReading } from "./aiText.jsx";
import {
  AI_CONSENT_VERSION,
  needsConsent,
  buildConsentPatch,
  pickSupportedMimeType,
  RECORDER_AUDIO_BITS_PER_SECOND,
  MONTHLY_MINUTES_LIMIT_HINT,
  MINIMUM_BILLED_MINUTES_HINT,
  describeRecorderError,
  parseAiNotesError,
  PERMANENT_FAILURE_CODES,
  mapAiResultToItems,
  recorderReducer,
  INITIAL_RECORDER_STATE,
  TRANSLATION_LANGUAGES,
  newIdempotencyKey,
  TRANSCRIPT_EXCERPT_CHARS,
  setPendingRecovery,
  clearPendingRecovery,
  pendingRecovery,
  recoveryFailureKind,
  defaultCardSelection,
  folderForRecording,
  DEFAULT_CARDS_SELECTED,
  RESUMMARISE_BILLED_MINUTES_HINT,
} from "./aiNotesLogic.js";
import {
  describeCapabilities,
  canUseSource,
  micConstraints,
  systemConstraints,
  checkCapturedAudio,
  pickDevice,
  audioInputs,
  loadPreferredInput,
  savePreferredInput,
  ROOM_HIGHPASS_HZ,
  AUDIO_SOURCES,
} from "./audioSources.js";
import { migrateNote, isRemote, fetchNote, buildContent, previewFor } from "./aiNotesStore.js";
import { noteCache } from "./noteCache.js";
import { AI_NOTES_COPY } from "./aiNotesCopy.js";
import { fetchUsage, fetchRecordingAccess, uploadAudio, callAiNotes, callResummarise } from "./aiNotesClient.js";
import { nowISO, supabase } from "./sync.js";
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
    <div className={`mb-3 rounded-lg px-3 py-2 text-xs ${near ? "bg-amber-50 text-amber-800" : "bg-stone-100 text-stone-500"}`}>
      <div className="flex items-center gap-1.5">
        {near && <TriangleAlert size={13} />}
        {Math.round(usage.minutesUsed)} of {MONTHLY_MINUTES_LIMIT_HINT} AI minutes used this month
      </div>
      {/* Disclosed here rather than discovered by watching the counter
          jump after a two-minute recording. */}
      <p className="mt-1 opacity-80">{AI_NOTES_COPY.minimumBilling(MINIMUM_BILLED_MINUTES_HINT)}</p>
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
  /* Two ways a recording quietly becomes silence while still being
     billed. Neither stops the recording -- see the note on the mute
     listener below -- so both are surfaced instead. */
  const [micMuted, setMicMuted] = useState(false);
  const [wentToBackground, setWentToBackground] = useState(false);

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  /* An ARRAY now: "Both" holds a microphone stream and a display stream
     at once, and the display one carries a video track we never record
     but do keep alive (see startCapture). All of them have to be
     stopped, or the browser's "sharing" indicator outlives the
     recording. */
  const streamsRef = useRef([]);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const rafRef = useRef(null);
  const wakeLockRef = useRef(null);
  const startTimeRef = useRef(0);
  const pausedMsRef = useRef(0);
  const pauseStartRef = useRef(0);
  /* Set when the recording ended because the share did, so the review
     screen can say so rather than leaving a short recording unexplained.
     stopRef exists because the track listener is registered inside
     start(), above where stop() is defined. */
  const shareEndedRef = useRef(false);
  const stopRef = useRef(() => {});

  const cleanupStream = () => {
    if (streamsRef.current.length) {
      streamsRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()));
      streamsRef.current = [];
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

  /* Opens the streams the chosen source needs.
     Returns { micStream, sysStream } or { failed, message }. */
  const openStreams = async (source, deviceId, caps) => {
    let sysStream = null;
    let micStream = null;

    /* THE DISPLAY PROMPT GOES FIRST, and the order is load-bearing.
       getDisplayMedia requires transient user activation, and awaiting
       a microphone permission prompt first can outlast it — so asking
       for the microphone first turns "Both" into a silent refusal on
       the browsers that enforce activation strictly. */
    if (source === "system" || source === "both") {
      try {
        sysStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: systemConstraints(),
        });
      } catch (err) {
        return { failed: true, message: describeRecorderError(err) };
      }

      /* Before the recorder exists, before anything is billed. */
      const check = checkCapturedAudio(sysStream);
      if (!check.ok) {
        sysStream.getTracks().forEach((t) => t.stop());
        return { failed: true, message: AI_NOTES_COPY.audioSource.noAudioCaptured(caps.platform) };
      }
    }

    if (source === "microphone" || source === "both") {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(deviceId) });
      } catch (err) {
        if (sysStream) sysStream.getTracks().forEach((t) => t.stop());
        return { failed: true, message: describeRecorderError(err) };
      }
    }

    return { micStream, sysStream };
  };

  /* Mic -> high-pass -> destination, system -> destination, both -> both.
     The analyser taps the same nodes, so the level meter shows what is
     actually being recorded rather than one half of it.

     Returns null if the graph can't be built. That is survivable for a
     single source (fall back to the raw stream, losing the filter and
     the meter — exactly the behaviour before this feature) and fatal
     for "Both", where mixing is the entire point. */
  const buildGraph = ({ micStream, sysStream }) => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const dest = ctx.createMediaStreamDestination();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;

      if (micStream) {
        const src = ctx.createMediaStreamSource(micStream);
        const highpass = ctx.createBiquadFilter();
        highpass.type = "highpass";
        highpass.frequency.value = ROOM_HIGHPASS_HZ;
        src.connect(highpass);
        highpass.connect(dest);
        highpass.connect(analyser);
      }
      if (sysStream) {
        /* No high-pass. Loopback has no room in it to remove, and
           filtering a clean digital signal only loses bass. */
        const src = ctx.createMediaStreamSource(sysStream);
        src.connect(dest);
        src.connect(analyser);
      }
      return { ctx, analyser, stream: dest.stream };
    } catch (e) {
      return null;
    }
  };

  const start = async (source = "microphone", deviceId = null) => {
    dispatch({ type: "request" });
    const caps = describeCapabilities();

    const picked = pickSupportedMimeType();
    if (!picked) {
      dispatch({ type: "requestDenied", message: "This browser can't record audio in a supported format." });
      return;
    }

    const opened = await openStreams(source, deviceId, caps);
    if (opened.failed) {
      dispatch({ type: "requestDenied", message: opened.message });
      return;
    }
    const { micStream, sysStream } = opened;
    const stopEverything = () => [micStream, sysStream].forEach((s) => s && s.getTracks().forEach((t) => t.stop()));

    const graph = buildGraph({ micStream, sysStream });
    if (!graph && micStream && sysStream) {
      stopEverything();
      dispatch({ type: "requestDenied", message: AI_NOTES_COPY.audioSource.mixFailed });
      return;
    }

    const recordedStream = graph ? graph.stream : micStream || new MediaStream(sysStream.getAudioTracks());

    streamsRef.current = [micStream, sysStream].filter(Boolean);
    chunksRef.current = [];
    const recorder = new MediaRecorder(recordedStream, {
      mimeType: picked.mimeType,
      audioBitsPerSecond: RECORDER_AUDIO_BITS_PER_SECOND,
    });
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunksRef.current.push(e.data);
    };
    mediaRecorderRef.current = recorder;

    /* The student clicking Chrome's "Stop sharing" bar, closing the tab
       or ending the meeting kills the track — and MediaRecorder does not
       notice. It keeps writing silence and the billed duration keeps
       climbing. Stop on the first track that ends and keep what we have.

       The video track is watched too: it is the one the browser's own
       stop-sharing control ends, and it is never fed to the recorder --
       only audio tracks reach recordedStream -- so nothing else in here
       would have noticed it going. */
    /* ANDROID MUTES THE MICROPHONE IN THE BACKGROUND. API 30+ refuses
       mic capture to an app without a foreground service, and the track
       does NOT end -- it goes `muted`, which fires here and nothing was
       listening for it before. Without this, a student who locks their
       screen mid-lecture gets forty minutes of silence and is billed for
       it, which is the same billed-silence failure checkCapturedAudio
       exists to prevent, arriving through the one door it can't watch:
       that guard runs once, before recording starts.

       IT DOES NOT STOP THE RECORDING, deliberately. A mute can be
       momentary -- an incoming call, a permission toast -- and killing
       an hour of lecture over three seconds of it would be the worse
       failure. It warns, and it is remembered, so the review screen can
       say part of the recording may be silent. */
    if (micStream) {
      micStream.getAudioTracks().forEach((t) => {
        t.addEventListener("mute", () => setMicMuted(true));
        t.addEventListener("unmute", () => setMicMuted(false));
      });
    }

    if (sysStream) {
      sysStream.getTracks().forEach((t) =>
        t.addEventListener("ended", () => {
          if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
            shareEndedRef.current = true;
            stopRef.current();
          }
        })
      );
    }

    if (graph) {
      audioCtxRef.current = graph.ctx;
      analyserRef.current = graph.analyser;
      rafRef.current = requestAnimationFrame(tickLevel);
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
    shareEndedRef.current = false;
    setMicMuted(false);
    setWentToBackground(false);
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

  /* Backgrounding the app degrades a recording on a phone and there is
     nothing we can do about it from a WebView -- so the app says so
     rather than degrading silently. Only while actually recording, and
     only on the platforms where it is true: a desktop browser keeps
     getUserMedia alive in a background tab, so warning there would be
     noise that teaches people to ignore the warning that matters. */
  useEffect(() => {
    if (state.status !== "recording" && state.status !== "paused") return;
    if (typeof document === "undefined") return;
    const caps = describeCapabilities();
    if (!caps.mobile) return;
    const onHide = () => {
      if (document.hidden) setWentToBackground(true);
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
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

  stopRef.current = stop;

  const discard = () => {
    cleanupStream();
    setElapsedSeconds(0);
    setLevel(0);
    shareEndedRef.current = false;
    setMicMuted(false);
    setWentToBackground(false);
    dispatch({ type: "discard" });
  };

  return {
    state,
    dispatch,
    elapsedSeconds,
    level,
    start,
    pause,
    resume,
    stop,
    discard,
    shareEnded: shareEndedRef,
    micMuted,
    wentToBackground,
  };
}

/* ------------------------------------------------------------------ */
/*  Audio source picker                                               */
/* ------------------------------------------------------------------ */

/* Unavailable options are DISABLED WITH A REASON, never hidden. A
   student in Firefox who sees only "Microphone" learns nothing and
   concludes the feature doesn't exist; one who sees the option greyed
   out with "Needs Chrome or Edge" knows exactly what to do. The one
   exception is a platform where the option could never work at all --
   iOS has no device picker, so there is nothing informative to grey
   out.

   EXPORTED only so the smoke test can mount it. The recorder refuses to
   render in demo mode -- AI notes needs a real account -- so the tab
   walk can never reach this, and a component nothing renders is exactly
   where all four wiring faults this repo has shipped lived. */
export function AudioSourcePicker({ caps, source, setSource, deviceId, setDeviceId }) {
  const copy = AI_NOTES_COPY.audioSource;
  const [devices, setDevices] = useState([]);
  const [labelsHidden, setLabelsHidden] = useState(false);

  const refresh = async () => {
    try {
      const inputs = audioInputs(await navigator.mediaDevices.enumerateDevices());
      setDevices(inputs);
      /* Before permission is granted every label is the empty string, so
         the list reads as "Microphone, Microphone, Microphone". That is
         why enumeration is offered but not forced: ask first, populate
         after. */
      setLabelsHidden(inputs.length > 0 && inputs.every((d) => !d.label));
    } catch (e) {
      setDevices([]);
    }
  };

  useEffect(() => {
    if (!caps.devicePicker.available) return;
    refresh();
    const md = navigator.mediaDevices;
    if (!md.addEventListener) return;
    md.addEventListener("devicechange", refresh);
    return () => md.removeEventListener("devicechange", refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caps.devicePicker.available]);

  /* Runs on every change to the list, which covers both restoring a
     saved choice and a device being unplugged mid-session: if what is
     selected is no longer there, fall back to the preference, and then
     to the system default. Silently — see pickDevice. */
  useEffect(() => {
    if (!devices.length) return;
    if (deviceId && devices.some((d) => d.deviceId === deviceId)) return;
    setDeviceId(pickDevice(devices, loadPreferredInput()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices]);

  const grantAccess = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      await refresh();
    } catch (e) {
      /* Denied. The default input still works, and Start recording will
         ask again and explain properly if it is refused there. */
    }
  };

  const chooseDevice = (id) => {
    setDeviceId(id || null);
    const match = devices.find((d) => d.deviceId === id);
    savePreferredInput(id ? { deviceId: id, label: (match && match.label) || "" } : null);
  };

  const wantsMic = source === "microphone" || source === "both";
  const btn = (active, enabled) =>
    `rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
      active
        ? "u-accent-bg border-transparent text-white"
        : enabled
          ? "border-stone-200 bg-surface text-stone-600 hover:bg-stone-50"
          : "cursor-not-allowed border-stone-100 bg-stone-50 text-stone-300"
    }`;

  return (
    <div className="col-span-2">
      <label className={labelCls}>{copy.label}</label>
      <div className="flex flex-wrap gap-1.5">
        {AUDIO_SOURCES.map((s) => {
          const enabled = canUseSource(s, caps);
          return (
            <button
              key={s}
              type="button"
              className={btn(source === s, enabled)}
              disabled={!enabled}
              onClick={() => setSource(s)}
            >
              {copy.options[s]}
            </button>
          );
        })}
      </div>

      <p className="mt-1 text-xs text-stone-400">{copy.hint[source]}</p>

      {!caps.system.available && caps.system.reason && (
        <p className="mt-0.5 text-xs text-stone-400">
          {copy.options.system} — {copy.unavailable[caps.system.reason]}
        </p>
      )}

      {caps.system.mode === "tab" && (source === "system" || source === "both") && (
        <p className="mt-1 rounded-lg bg-stone-100 px-2.5 py-1.5 text-xs text-stone-600">{copy.tabOnlyHint}</p>
      )}

      {wantsMic && caps.devicePicker.available && devices.length > 1 && (
        <div className="mt-2">
          {labelsHidden ? (
            <button type="button" className="text-xs text-stone-500 underline" onClick={grantAccess}>
              Show my microphones
            </button>
          ) : (
            <select className={inputCls} value={deviceId || ""} onChange={(e) => chooseDevice(e.target.value)}>
              <option value="">Default microphone</option>
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || "Microphone"}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
    </div>
  );
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

/* Saves the full transcript to a file. Same approach as the backup
   panel's export: a Blob and an object URL, no server round trip, so
   the text never leaves the device a second time. */
function downloadTranscript(text) {
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    const blob = new Blob([text || ""], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lecture-transcript-${stamp}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    /* A blocked download shouldn't take the review screen down with it;
       the transcript is still on screen to copy by hand. */
  }
}

function ReviewAndSave({ result, onSave, onDiscard, selectedCards, setSelectedCards, onRetrySummary }) {
  /* Declared ABOVE the early return: a hook after a conditional return
     is the temporal-dead-zone shape that has taken this app down twice. */
  const [retryState, setRetryState] = useState({ status: "idle", message: "" });
  const runRetry = async () => {
    setRetryState({ status: "working", message: "" });
    try {
      await onRetrySummary();
      // On success the parent swaps `result`, so this screen unmounts.
    } catch (err) {
      setRetryState({
        status: "error",
        message:
          err && err.code === "transcript_expired"
            ? AI_NOTES_COPY.summaryFailed.retryExpired()
            : err && err.code === "already_summarised"
              ? AI_NOTES_COPY.summaryFailed.retryAlreadyDone
              : AI_NOTES_COPY.summaryFailed.retryFailed,
      });
    }
  };

  if (result.summaryFailed) {
    const full = result.transcript || "";
    const willTruncate = full.length > TRANSCRIPT_EXCERPT_CHARS;
    return (
      <div className="space-y-3">
        <div className="space-y-1.5 rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
          <p className="font-medium">
            <TriangleAlert size={14} className="mr-1 inline" />
            {AI_NOTES_COPY.summaryFailed.title}
          </p>
          {/* Minutes were billed before summarising was even attempted.
              Saying so here is not optional -- see aiNotesCopy.js. */}
          <p className="text-amber-800">{AI_NOTES_COPY.summaryFailed.billing}</p>
          <p className="text-amber-800">{AI_NOTES_COPY.summaryFailed.recoverable()}</p>
        </div>
        <div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
          {full}
        </div>
        {/* A full transcript is ~40x a normal note and would sync in full
            on every change, so only the opening is saved. The rest is
            offered here, while it is still in memory — this is the last
            screen on which it exists. */}
        {willTruncate && (
          <p className="text-xs text-stone-500">
            {AI_NOTES_COPY.transcriptTruncated({ kept: TRANSCRIPT_EXCERPT_CHARS, total: full.length })}
          </p>
        )}
        {/* THE RETRY, offered WHERE THE FAILURE IS SHOWN. A student
            sitting on a failed summary should not have to go looking
            for it, and this is the screen they are already on. The cost
            line says what it charges and what it does not, because this
            lecture has already been paid for once. */}
        {onRetrySummary && (
          <div className="space-y-2 rounded-lg border border-stone-200 p-3">
            <p className="text-xs text-stone-600">
              {AI_NOTES_COPY.summaryFailed.retryCost(RESUMMARISE_BILLED_MINUTES_HINT)}
            </p>
            {retryState.status === "error" && (
              <p role="status" className="text-xs text-rose-700">
                {retryState.message}
              </p>
            )}
            <button className={btnGhost} disabled={retryState.status === "working"} onClick={runRetry}>
              <RefreshCw size={15} />{" "}
              {retryState.status === "working" ? AI_NOTES_COPY.summaryFailed.retrying : AI_NOTES_COPY.summaryFailed.retry}
            </button>
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button className={btnGhost} onClick={onDiscard}>
            <X size={15} /> Discard
          </button>
          <button className={btnGhost} onClick={() => downloadTranscript(full)}>
            <Download size={15} /> Download full transcript
          </button>
          <button className={btnPrimary} onClick={onSave}>
            <Check size={15} /> {AI_NOTES_COPY.summaryFailed.action}
          </button>
        </div>
      </div>
    );
  }

  const { overview, keyPoints, terms, assessable, openQuestions } = result.original;
  const selection = selectedCards || defaultCardSelection(terms);
  const chosen = selection.filter(Boolean).length;
  const toggleOne = (i) => setSelectedCards(selection.map((v, j) => (j === i ? !v : v)));
  const toggleAll = () => setSelectedCards(selection.map(() => chosen !== (terms || []).length));

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
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-stone-700">
              Study cards ({chosen} of {terms.length})
            </h3>
            <button className="text-xs text-stone-500 underline" onClick={toggleAll}>
              {chosen === terms.length ? "Clear all" : "Select all"}
            </button>
          </div>
          <p className="mt-0.5 text-xs text-stone-500">
            The first {DEFAULT_CARDS_SELECTED} are ticked. Untick anything you don't want to revise — only the ticked
            ones become cards.
          </p>
          <ul className="mt-1.5 space-y-1 text-sm text-stone-600">
            {terms.map((t, i) => (
              <li key={i}>
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1 shrink-0"
                    checked={!!selection[i]}
                    onChange={() => toggleOne(i)}
                  />
                  <span>
                    <span className="font-medium">{t.term}</span> — {t.content}
                  </span>
                </label>
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
/*  useRecordingSession — the whole recording, ABOVE the tab switcher   */
/* ------------------------------------------------------------------ */

/**
 * Everything a recording is: the stream, the form fields that describe
 * it, the upload driver, and saving the result.
 *
 * WHY IT LIVES IN PlannerApp AND NOT IN THE PANEL. The AI Notes tab is
 * rendered as `{tab === "ai-notes" && ...}`, so tapping another tab
 * unmounts the subtree. Before this, that ran cleanupStream() — every
 * track stopped, the AudioContext closed, chunksRef garbage-collected —
 * WITHOUT calling recorder.stop(), so no Blob was ever assembled and no
 * recovery key had been parked yet. A two-hour lecture disappeared on
 * one stray tap, silently. Called once at app level, none of that can
 * happen: a component unmounting no longer takes the recording with it.
 *
 * IT ALSO HAD TO BE THE WHOLE SESSION, not just the stream. runUpload
 * reads `course`, `week` and `translateTo` out of this closure at the
 * moment recording stops — so hoisting the stream alone would leave a
 * stopped recording with nothing to drive it, and the form fields still
 * dying with the panel.
 *
 * The happy side effect is that saving moves up here, where addItem,
 * setData, folders and session already live. That DELETES the prop-relay
 * chain — `folders` no longer travels PlannerApp -> AiNotesPanel ->
 * RecoveryGate -> Recorder — which is the exact shape that produced the
 * ReferenceError that white-screened Android. There is nothing left to
 * relay, so there is nothing left to drop.
 */
export function useRecordingSession({ session, folders = [], addItem, setData }) {
  const recorder = useLectureRecorder();
  const { state, dispatch, discard } = recorder;

  const [course, setCourse] = useState("");
  const [week, setWeek] = useState("");
  const [translateTo, setTranslateTo] = useState("");
  /* Computed once. Nothing about the platform changes while the app is
     open, and describeCapabilities reads navigator, which is not
     something to do on every render. */
  const [caps] = useState(() => describeCapabilities());
  const [source, setSource] = useState("microphone");
  const [deviceId, setDeviceId] = useState(null);
  /* Which study cards the student wants. Null until a result arrives,
     then the default selection, so the checkboxes have somewhere to
     live and Save has something to read. */
  const [selectedCards, setSelectedCards] = useState(null);

  const runUpload = async () => {
    dispatch({ type: "upload" });
    /* Park the key in the synced blob BEFORE the upload, not after: the
       whole point is to survive the app closing, and the window where
       that matters starts here. It syncs, so recovery also works from
       the device that didn't do the recording. */
    if (setData) {
      setData((d) => ({
        ...d,
        meta: setPendingRecovery(d.meta, {
          key: state.idempotencyKey,
          course,
          week,
          startedAt: nowISO(),
        }),
      }));
    }
    try {
      // The upload needs a path; the function does not. It derives its
      // own from the JWT and the idempotency key.
      await uploadAudio({
        session,
        audioBlob: state.blob,
        mimeType: state.mimeType,
        idempotencyKey: state.idempotencyKey,
      });
      const result = await callAiNotes({
        token: session.token,
        course,
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
    // closure at the moment recording stops, which is now a closure that
    // outlives the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status]);

  /* A recovered result re-enters the flow at exactly the point the app
     closed: the review screen, with Save and Discard, rather than a
     separate "recovered note" path that would need its own testing. */
  const acceptRecovered = (result) => dispatch({ type: "processed", result });

  const onSave = async () => {
    dispatch({ type: "save" });
    try {
      const { pageItem, noteItems } = mapAiResultToItems({
        result: state.result,
        course,
        week,
        language: translateTo || null,
        uid,
        nowISO,
        selectedCards,
      });

      /* The content goes to its own row FIRST, and only a stub reaches
         the blob. Same ordering rule as migrating an old note, for the
         same reason: if the row write fails we keep the full note in the
         blob, which is heavy but correct, rather than a stub pointing at
         nothing. migrateNote returns the stub only on success, so the
         fallback is simply the page we already have.

         Signed out or in demo mode there is no row to write and the note
         stays whole in the blob — that path is unchanged, and the
         migration pass picks it up on the next sign-in. */
      let toStore = pageItem;
      if (supabase && session && session.user) {
        const { ok, stub } = await migrateNote({ supabaseClient: supabase, userId: session.user.id, page: pageItem });
        if (ok) {
          toStore = stub;
          // Readable offline from the moment it is saved, which is the
          // state the student expects: they just watched it appear.
          await noteCache.put(pageItem.id, buildContent(pageItem));
        }
      }

      /* The folder is a CONVENIENCE and must never block the note. It is
         computed and created inside its own try, so a failure here leaves
         the note filed nowhere -- visible in the list, exactly as before
         this feature existed -- rather than losing a lecture someone just
         recorded. */
      try {
        const { folderId, newFolder } = folderForRecording({ folders, course, uid, nowISO });
        if (newFolder) addItem("folders", newFolder);
        if (folderId) toStore = { ...toStore, folderId };
      } catch (e) {
        /* filed nowhere, saved anyway */
      }

      addItem("pages", toStore);
      noteItems.forEach((n) => addItem("notes", n));
      if (setData) setData((d) => ({ ...d, meta: clearPendingRecovery(d.meta) }));
      dispatch({ type: "saved" });
    } catch (err) {
      dispatch({ type: "saveFailed", message: err.message || "Couldn't save this note. Please try again." });
    }
  };

  const onDiscard = () => {
    if (setData) setData((d) => ({ ...d, meta: clearPendingRecovery(d.meta) }));
    discard();
  };

  /* Retry the SUMMARY only, for a lecture whose transcription already
     succeeded and was already billed. The transcript is on the server,
     owner-scoped, so nothing is re-uploaded and nothing is
     re-transcribed — see the endpoint's own notes.

     On success the result replaces the failed one in place, so the
     student lands on the ordinary review screen with their cards; the
     error is re-thrown so the failure screen can say which failure it
     was, and the transcript stays exactly where it is either way. */
  const onRetrySummary = async () => {
    const key = state.idempotencyKey;
    if (!key) {
      const err = new Error("This recording can't be retried on this device.");
      err.code = "bad_idempotency_key";
      throw err;
    }
    const { result } = await callResummarise({ token: session && session.token, idempotencyKey: key, translateTo });
    /* `processed` is exactly the transition this needs — review, with
       the new result — so the retry reuses it rather than adding a
       second way into the same state. */
    dispatch({ type: "processed", result });
    return result;
  };

  /* Is there a recording or a result the student would lose track of by
     navigating away? This is what the indicator watches. "done" is
     excluded: the note is saved, there is nothing in flight. */
  const busyStatuses = ["requesting", "recording", "paused", "stopped", "uploading", "review", "saving"];
  const active = busyStatuses.includes(state.status);
  const capturing = state.status === "recording" || state.status === "paused";

  return {
    ...recorder,
    course,
    setCourse,
    week,
    setWeek,
    translateTo,
    setTranslateTo,
    caps,
    source,
    setSource,
    deviceId,
    setDeviceId,
    selectedCards,
    setSelectedCards,
    runUpload,
    acceptRecovered,
    onSave,
    onDiscard,
    onRetrySummary,
    active,
    capturing,
  };
}

/* ------------------------------------------------------------------ */
/*  The indicator — visible from every tab                             */
/* ------------------------------------------------------------------ */

/**
 * Rendered OUTSIDE the tab switch, so it is on screen wherever the
 * student goes. Two jobs, and the second is not a nicety:
 *
 *   - say what is happening (elapsed time, or writing up)
 *   - STOP, one tap, from anywhere
 *
 * "I can't stop the recording" is a privacy problem before it is a
 * usability one — a student who walks out of a lecture into a private
 * conversation must be able to stop it without hunting for a tab.
 *
 * All wording is in aiNotesCopy.js and the markup is one small
 * component, so Grace can restyle this without going near the state
 * machine that decides when it appears.
 */
export function RecordingIndicator({ recording, onOpen, liftedForNav = false }) {
  if (!recording || !recording.active) return null;
  const copy = AI_NOTES_COPY.indicator;
  const { state, elapsedSeconds, capturing, stop } = recording;

  return (
    /* It floats at the bottom, which is exactly where the phone's tab
       bar now lives — so when that bar is rendered the indicator sits
       ABOVE it rather than over it. Stopping a recording must never
       require guessing which of two overlapping controls is on top,
       and "I can't stop it" is a privacy problem before it is a
       usability one. */
    <div
      className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-3 pointer-events-none"
      style={liftedForNav ? { paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 4.25rem)" } : undefined}
    >
      <div className="pointer-events-auto flex w-full max-w-md items-center gap-2 rounded-xl border border-stone-200 bg-surface/95 px-3 py-2 shadow-lg backdrop-blur">
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onOpen}>
          {capturing ? (
            <>
              <span
                className={`h-2.5 w-2.5 flex-shrink-0 rounded-full bg-rose-600 ${
                  state.status === "recording" ? "animate-pulse" : ""
                }`}
              />
              <span className="font-mono text-sm text-stone-700">{formatElapsed(elapsedSeconds)}</span>
              <span className="truncate text-xs text-stone-500">
                {state.status === "paused" ? copy.paused : copy.recording}
              </span>
            </>
          ) : (
            <>
              <RefreshCw size={14} className="flex-shrink-0 animate-spin text-stone-400" />
              <span className="truncate text-xs text-stone-600">
                {state.status === "review" ? copy.waitingToSave : copy.processing}
              </span>
            </>
          )}
        </button>

        {/* Never more than one tap away. */}
        {capturing && (
          <button
            className="inline-flex flex-shrink-0 items-center gap-1 rounded-lg bg-rose-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-rose-700 u-focus"
            onClick={stop}
          >
            <Square size={12} /> {copy.stop}
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Recorder — a view over the session                                 */
/* ------------------------------------------------------------------ */

/* Owns no recording state at all now. It reads and renders; everything
   it touches lives in useRecordingSession, above the tab switch. Note
   what it no longer takes: folders, addItem, setData. Those went up
   with the save, which is what removed the relay chain. */
function Recorder({ session, courses, recording }) {
  const {
    state,
    elapsedSeconds,
    level,
    start,
    pause,
    resume,
    stop,
    discard,
    shareEnded,
    micMuted,
    wentToBackground,
    course,
    setCourse,
    week,
    setWeek,
    translateTo,
    setTranslateTo,
    caps,
    source,
    setSource,
    deviceId,
    setDeviceId,
    selectedCards,
    setSelectedCards,
    runUpload,
    onSave,
    onDiscard,
    onRetrySummary,
  } = recording;

  /* THE TIER, READ BEFORE THE WORK. The server refuses a free-tier
     request at its own tier check, before the paid transcription call
     -- but that refusal used to arrive after the student had recorded
     the whole lecture and uploaded it. Nothing was charged; an hour of
     theirs was gone, and the upload sat in Storage until the orphan
     sweep. Reading profiles.tier here (select-own RLS, same as the text
     pre-flight) moves the refusal to before the record button.

     Three states, not two: null/unknown NEVER gates. A tier read that
     failed because the lecture theatre has no signal must not become a
     paywall -- the server still enforces, this is only the early
     warning. And it re-reads per session-user, so upgrading the account
     doesn't leave a stale wall. */
  const [access, setAccess] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetchRecordingAccess(session).then((a) => {
      if (!cancelled) setAccess(a);
    });
    return () => {
      cancelled = true;
    };
  }, [session && session.user.id]);

  const showForm = state.status === "idle";
  const showControls = ["idle", "requesting", "recording", "paused"].includes(state.status);

  /* Definitively not entitled -- the read RAN and said so. The controls
     go entirely: a disabled record button invites tapping it to find
     out why, and a recording that cannot be summarised is not a thing
     this screen offers. mid-recording states are untouched, so a
     downgrade mid-lecture cannot kill a recording in progress. */
  if (access && access.canRecord === false && state.status === "idle") {
    return (
      <Card>
        <div className="rounded-lg u-accent-soft p-3">
          <h3 className="text-sm font-semibold text-stone-800">{AI_NOTES_COPY.recordingNeedsPlan.title}</h3>
          <p className="mt-1 text-sm text-stone-600">{AI_NOTES_COPY.recordingNeedsPlan.detail}</p>
        </div>
      </Card>
    );
  }

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
          <AudioSourcePicker
            caps={caps}
            source={source}
            setSource={setSource}
            deviceId={deviceId}
            setDeviceId={setDeviceId}
          />
        </div>
      )}

      {/* Switching tabs is fine and the student is told so, because the
          old behaviour was to lose the recording and they have no way of
          knowing that changed. */}
      {["recording", "paused"].includes(state.status) && (
        <p className="mt-2 text-center text-xs text-stone-400">{AI_NOTES_COPY.indicator.keepsRunning}</p>
      )}

      {showControls && (
        <RecorderControls
          status={state.status}
          elapsedSeconds={elapsedSeconds}
          level={level}
          onStart={() => start(source, deviceId)}
          onPause={pause}
          onResume={resume}
          onStop={stop}
        />
      )}

      {/* The two ways a recording quietly becomes silence. Both are
          warnings rather than stops -- see the mute listener. */}
      {micMuted && <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{AI_NOTES_COPY.micMuted}</p>}
      {wentToBackground && (
        <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{AI_NOTES_COPY.wentToBackground}</p>
      )}

      {/* The recording stopped on its own because the share did. Said
          here rather than left as an unexplained short recording. */}
      {shareEnded.current && ["uploading", "review", "saving"].includes(state.status) && (
        <p className="mb-3 rounded-lg bg-stone-100 px-3 py-2 text-sm text-stone-600">
          {AI_NOTES_COPY.audioSource.shareEnded}
        </p>
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
            {/* "Discard" is wrong when nothing was ever recorded -- which
                is every failure that happens before the recorder starts,
                including picking the wrong thing in the share dialog. */}
            <button className={btnGhost} onClick={discard}>
              <X size={15} /> {state.blob ? "Discard" : "Back"}
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
          <ReviewAndSave
            result={state.result}
            onSave={onSave}
            onDiscard={onDiscard}
            selectedCards={selectedCards}
            setSelectedCards={setSelectedCards}
            onRetrySummary={onRetrySummary}
          />
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

/* The AI Notes tab is the home for BOTH capture tools -- record a
   lecture, summarise a reading -- because it is already the "AI does
   work for you" place and already carries the consent gate and the
   allowance line. The reading-row control remains as a shortcut into
   the same tool; it stops being the only door, because two builders in
   a row failed to find it there. */
export function AiNotesPanel({ session, backend, courses, data, setData, recording, textAllowance, onSummariseReading, onOpenSummary }) {
  if (!session || backend.isDemo) {
    /* Gated, but DISCOVERABLE: the tools are named, so a signed-out
       student learns they exist. A bare needs-account line is the
       feature-nobody-can-see failure in sign-in clothing. */
    return (
      <Card>
        <p className="text-sm font-medium text-stone-700">{AI_NOTES_COPY.signedOutTools.tools}</p>
        <p className="mt-1 text-sm text-stone-500">{AI_NOTES_COPY.signedOutTools.detail}</p>
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

  return (
    <>
      <RecoveryGate session={session} courses={courses} data={data} setData={setData} recording={recording} />
      <ReadingHub
        session={session}
        courses={courses}
        textAllowance={textAllowance}
        onSummariseReading={onSummariseReading}
        onOpenSummary={onOpenSummary}
      />
    </>
  );
}

/* The standalone home for the reading summariser. Course and week are
   the hub's job -- the reading-row path pre-fills them from the row,
   but a standalone launch has no row to read. The tool itself is the
   SAME component the row uses, with the same estimate, refusals and
   filing; only the door is new. */
function ReadingHub({
  session,
  courses,
  textAllowance = { allowance: null, applyFraction: () => {} },
  onSummariseReading = () => {},
  onOpenSummary = () => {},
}) {
  const [course, setCourse] = useState("");
  const [week, setWeek] = useState("");
  return (
    <Card className="mt-3">
      <h3 className="font-serif text-base font-semibold text-stone-800">Summarise a reading</h3>
      <p className="mt-1 text-sm text-stone-500">
        Paste a section of a reading and get structured notes to revise from, filed with your course.
      </p>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>Course</label>
          <CourseSelect value={course} onChange={setCourse} courses={courses} />
        </div>
        <div>
          <label className={labelCls}>Week</label>
          <input type="number" min="1" className={inputCls} placeholder="e.g. 5" value={week} onChange={(e) => setWeek(e.target.value)} />
        </div>
      </div>
      <div className="mt-3">
        <SummariseReading
          standalone
          session={session}
          reading={{ course, week }}
          summaryPage={null}
          allowanceApi={textAllowance}
          onSummarised={onSummariseReading}
          onOpenSummary={onOpenSummary}
        />
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Recovering a result the app closed on                             */
/* ------------------------------------------------------------------ */

/* The Edge Function already stored the whole result, scoped to this
   user, keyed by the idempotency key. Asking for it again is just
   calling the function with the same key: the insert hits a unique
   violation, the scoped lookup finds the completed row and returns it.
   No new endpoint, no audio, and no minutes -- billing happens on the
   transcription path this request never reaches.

   It hands a recovered result straight to the session rather than
   passing it down as a prop, which is one fewer thing to relay. */
function RecoveryGate({ session, courses, data, setData, recording }) {
  const pending = pendingRecovery(data.meta);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /* Survives the key being cleared. The card renders on `pending`, so
     forgetting a genuinely-gone result used to unmount the card in the
     same tick as the explanation was set -- the student tapped "Get it
     back", everything vanished, and they were told nothing at all. */
  const [gone, setGone] = useState(false);

  const forget = () => setData((d) => ({ ...d, meta: clearPendingRecovery(d.meta) }));

  const recover = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await callAiNotes({
        token: session.token,
        course: pending.course,
        translateTo: null,
        idempotencyKey: pending.key,
        estimatedDurationSeconds: 0,
      });
      recording.acceptRecovered(result);
    } catch (err) {
      /* NEVER TREAT A FAILED REQUEST AS EVIDENCE OF ABSENCE. This used
         to forget the key on ANY error, so a dropped connection told a
         student their paid notes had expired and then deleted the only
         handle they had on them, while the server held the result for
         another week. Second occurrence of the fetchNote rule; see
         recoveryFailureKind. */
      if (recoveryFailureKind(err) === "missing") {
        setError(AI_NOTES_COPY.recovery.expired);
        setGone(true);
        forget();
      } else {
        // The key is KEPT, so the button below is a real retry.
        setError(AI_NOTES_COPY.recovery.unreachable);
      }
    } finally {
      setBusy(false);
    }
  };

  /* Hidden once the session is showing the result: the card's job was to
     get it back, and it has. */
  const showCard = (pending || gone) && recording.state.status === "idle";

  return (
    <>
      {showCard && (
        <Card className="mb-3">
          {gone ? (
            <>
              <p className="text-sm font-medium text-stone-800">That recording has expired.</p>
              <p className="mt-1 text-sm text-stone-500">{error}</p>
              <div className="mt-3 flex justify-end">
                <button className={btnGhost} onClick={() => setGone(false)}>
                  <X size={15} /> OK
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-stone-800">{AI_NOTES_COPY.recovery.title}</p>
              <p className="mt-1 text-sm text-stone-500">
                {AI_NOTES_COPY.recovery.detail({ course: pending.course, week: pending.week })}
              </p>
              {error && <p className="mt-2 text-sm text-rose-700">{error}</p>}
              <div className="mt-3 flex justify-end gap-2">
                <button className={btnGhost} onClick={forget} disabled={busy}>
                  <X size={15} /> {AI_NOTES_COPY.recovery.dismiss}
                </button>
                <button className={btnPrimary} onClick={recover} disabled={busy}>
                  <RefreshCw size={15} className={busy ? "animate-spin" : ""} /> {AI_NOTES_COPY.recovery.action}
                </button>
              </div>
            </>
          )}
        </Card>
      )}
      <Recorder session={session} courses={courses} recording={recording} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Viewer for a saved AI note (opened from Notes/Folders)             */
/* ------------------------------------------------------------------ */

export function AiLectureNoteView({ page, patchItem, onClose, onMissing }) {
  const meta = (page && page.aiMeta) || {};
  const remote = isRemote(page);

  /* An old note still carries its content in the blob; a moved one has a
     stub and fetches. The languages are known either way before anything
     loads — from `translations` for the first, from the stub's previews
     for the second — so the selector never flickers or disappears while
     a fetch is in flight. */
  const [fetched, setFetched] = useState(null);
  const [status, setStatus] = useState(remote ? "loading" : "ready");
  const [activeLang, setActiveLang] = useState(meta.activeLanguage || "en");
  /* Bumped by "Try again". The fetch is an effect, so retrying needs a
     dependency that changes -- calling the loader directly would leave
     the cancelled-flag handling in two places. */
  const [attempt, setAttempt] = useState(0);

  const translations = remote ? (fetched && fetched.translations) || {} : meta.translations || {};
  const langs = remote ? Object.keys(meta.previews || {}) : Object.keys(translations);

  useEffect(() => {
    if (!remote || !page) return;
    let cancelled = false;
    (async () => {
      setStatus("loading");
      const cached = await noteCache.get(page.id);
      if (cancelled) return;
      if (cached) {
        setFetched(cached);
        setStatus("ready");
        return;
      }
      const res = await fetchNote({ supabaseClient: supabase, id: page.id });
      if (cancelled) return;
      if (res.content) {
        setFetched(res.content);
        setStatus("ready");
        noteCache.put(page.id, res.content);
      } else if (res.missing) {
        /* DEFINITIVELY not there: the query ran and returned no row. That
           is the self-healing half of an interrupted delete, and the only
           outcome allowed to remove anything. */
        setStatus("missing");
        if (onMissing) onMissing(page.id);
      } else {
        /* Anything else — offline, a 500, an expired token, a rate limit.
           We know nothing, so we change nothing and say so. */
        setStatus("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote, page && page.id, attempt]);

  if (!page) return null;
  const content = translations[activeLang] || translations.en;

  const onLangChange = (code) => {
    setActiveLang(code);
    if (patchItem && page.aiMeta) {
      /* Only activeLanguage moves. On a stub the rest of aiMeta is the
         list's data and the row is immutable, so spreading the existing
         meta is what keeps the two halves consistent. */
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
        /* data-ai-note-body marks the FETCHED content — as opposed to
           the row's preview, which comes from the stub in the blob and
           shows whether or not the fetch worked. The e2e journey scopes
           to this attribute for exactly that reason; renaming it breaks
           the journey by design. */
        <div className="mt-3 space-y-3 text-sm text-stone-600" data-ai-note-body>
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
      ) : status === "loading" ? (
        /* The preview is already in the blob, so there is something real
           to read while the rest arrives rather than a spinner over
           nothing. */
        <div className="mt-3 space-y-2">
          <p className="text-sm text-stone-500">{previewFor(page)}</p>
          <p className="text-xs text-stone-400">Loading the full note…</p>
        </div>
      ) : status === "failed" ? (
        <div className="mt-3 space-y-2">
          <p className="text-sm text-stone-500">{previewFor(page)}</p>
          <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <p className="font-medium">
              <TriangleAlert size={14} className="mr-1 inline" />
              Couldn't load this note
            </p>
            {/* Deliberately not "this note is gone". We do not know that,
                and saying it would be both wrong and frightening. */}
            <p className="mt-0.5 text-amber-800">
              You may be offline. Notes you've opened before stay readable without a connection — this one hasn't been
              opened on this device yet. It's still saved; try again when you're back online.
            </p>
          </div>
          <button className={btnGhost} onClick={() => setAttempt((n) => n + 1)}>
            <RefreshCw size={15} /> Try again
          </button>
        </div>
      ) : status === "missing" ? (
        <p className="mt-3 text-sm text-stone-500">
          This note was deleted on another device, so it's been removed here too.
        </p>
      ) : (
        <p className="mt-3 whitespace-pre-wrap text-sm text-stone-600">{page.body}</p>
      )}
    </Card>
  );
}
