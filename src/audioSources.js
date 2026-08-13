/* ==================================================================
   audioSources.js — what can be recorded, and what to ask for

   Pure, like srs.js and aiNotesLogic.js: nothing here touches a browser
   global until a function is called, and every function that needs the
   environment takes it as an argument. That is what lets the whole
   platform matrix be a table-driven test in Node, where neither
   getDisplayMedia nor enumerateDevices exists.

   The side effects — actually opening a stream, building the WebAudio
   graph — stay in aiNotes.jsx. This module decides WHAT to ask for and
   WHETHER what came back is usable.
   ================================================================== */

/* Device-local, deliberately NOT in the synced blob.

   A deviceId is meaningless on another machine, so syncing "use the
   Blue Yeti" to a phone is at best a no-op and at worst two devices
   overwriting each other's preference through last-write-wins. It also
   keeps the 1MB budget untouched. Declared in scripts/test-legal.mjs
   with the other uni-planner-* stores. */
export const AUDIO_INPUT_STORE_KEY = "uni-planner-audio-input";

export const AUDIO_SOURCES = ["microphone", "system", "both"];

/* The microphone path runs through a high-pass before the recorder.
   80Hz is below the bottom of a speaking voice (~85Hz for a low male
   voice) and above the band that air conditioning, projector fans and
   desk rumble live in, so it removes energy that is never speech. */
export const ROOM_HIGHPASS_HZ = 80;

/* ------------------------------------------------------------------ */
/*  Reading the environment                                           */
/* ------------------------------------------------------------------ */

/** Snapshots the globals this module reasons about. Called, never imported-time. */
export function readEnv() {
  const nav = typeof navigator === "undefined" ? null : navigator;
  return {
    userAgent: (nav && nav.userAgent) || "",
    isCapacitor: typeof window !== "undefined" && !!window.Capacitor,
    hasGetDisplayMedia: !!(nav && nav.mediaDevices && nav.mediaDevices.getDisplayMedia),
    hasEnumerateDevices: !!(nav && nav.mediaDevices && nav.mediaDevices.enumerateDevices),
  };
}

function platformOf(ua, isCapacitor) {
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (isCapacitor) return "ios"; // a Capacitor shell that somehow hid its UA
  if (/Macintosh|Mac OS X/i.test(ua)) return "macos";
  if (/Windows/i.test(ua)) return "windows";
  if (/Linux/i.test(ua)) return "linux";
  return "other";
}

function engineOf(ua) {
  // Order matters: Electron's UA contains Chrome, and Chrome's contains
  // Safari. Testing the most specific first is the only way to read it.
  if (/Electron\//i.test(ua)) return "electron";
  if (/Edg\/|Chrome\/|Chromium\//i.test(ua)) return "chromium";
  if (/Firefox\//i.test(ua)) return "firefox";
  if (/Safari\//i.test(ua)) return "safari";
  return "other";
}

/**
 * What this platform can record from.
 *
 * `system.mode` is the part worth reading:
 *   "full" — the whole machine's output can be captured
 *   "tab"  — audio comes back ONLY if the student shares a browser tab.
 *            Chrome on macOS returns a stream with zero audio tracks for
 *            a screen or window share, silently. See checkCapturedAudio.
 *   "none" — not offered
 *
 * `reason` is a code, never a sentence — the wording lives in
 * aiNotesCopy.js so Grace can rework it without touching this.
 */
export function describeCapabilities(env = readEnv()) {
  const platform = platformOf(env.userAgent || "", env.isCapacitor);
  const engine = engineOf(env.userAgent || "");
  const mobile = platform === "ios" || platform === "android" || env.isCapacitor;

  let system;
  if (mobile) {
    system = { available: false, mode: "none", reason: "mobile-platform" };
  } else if (!env.hasGetDisplayMedia) {
    system = { available: false, mode: "none", reason: "unsupported-browser" };
  } else if (engine === "electron") {
    /* The desktop shell answers the request itself (see desktop/main.js)
       and asks the OS for loopback audio. Whether the OS delivers it is
       a separate question that checkCapturedAudio answers at runtime,
       which is why nothing here promises it works. */
    system = { available: true, mode: "full", reason: null };
  } else if (engine === "chromium") {
    system = { available: true, mode: platform === "macos" ? "tab" : "full", reason: null };
  } else {
    /* Firefox's getDisplayMedia exists and takes an audio constraint; it
       has never returned an audio track. Safari's does not offer audio
       at all. Both are "no", and saying so is better than offering an
       option that silently records nothing. */
    system = { available: false, mode: "none", reason: "unsupported-browser" };
  }

  return {
    platform,
    engine,
    microphone: { available: true },
    /* iOS routes audio input at the system level and returns unlabelled
       devices that cannot reliably be selected, so a picker there is a
       list of identical blank rows that does nothing. */
    devicePicker: { available: !!env.hasEnumerateDevices && platform !== "ios" },
    system,
  };
}

/** Whether a source can be started on this platform right now. */
export function canUseSource(source, caps) {
  if (source === "microphone") return caps.microphone.available;
  if (source === "system") return caps.system.available;
  if (source === "both") return caps.microphone.available && caps.system.available;
  return false;
}

/* ------------------------------------------------------------------ */
/*  Constraints — two sets, on purpose                                */
/* ------------------------------------------------------------------ */

/**
 * The microphone set. Everything a browser turns on by default here is
 * tuned for a phone call and is wrong for a lecture theatre:
 *
 *   echoCancellation  assumes the far end is a loudspeaker beside you;
 *                     with none, it removes signal and adds nothing
 *   noiseSuppression  treats a quiet steady voice eight metres away much
 *                     the way it treats a hum — this is the one that
 *                     actually costs transcription accuracy
 *   autoGainControl   rides the level up through every pause, which
 *                     turns room noise into something loud between
 *                     sentences
 *
 * `deviceId` is IDEAL, never EXACT. Exact throws OverconstrainedError on
 * a headset that has been unplugged, so a student who took their
 * earphones out would get "recording failed" instead of their laptop
 * microphone. Ideal falls back silently, which is the behaviour wanted.
 */
export function micConstraints(deviceId) {
  const c = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
    sampleRate: 16000,
  };
  if (deviceId) c.deviceId = { ideal: deviceId };
  return c;
}

/**
 * The system-audio set. Deliberately NOT the same object.
 *
 * Loopback is already a clean digital signal with no room in it, so
 * there is no room handling to turn off — asking a browser to disable
 * echo cancellation on a stream that never had a microphone is at best
 * meaningless. Only the shape is shared.
 */
export function systemConstraints() {
  return { channelCount: 1, sampleRate: 16000 };
}

/* ------------------------------------------------------------------ */
/*  The guard                                                         */
/* ------------------------------------------------------------------ */

/**
 * THE most important three lines in this feature.
 *
 * getDisplayMedia({audio:true}) resolves happily with a stream that has
 * NO audio track when:
 *   - macOS Chrome and the student picked a screen or a window
 *     (only a browser tab carries audio there), or
 *   - anywhere, if they did not tick the share-audio box in the picker.
 *
 * MediaRecorder is equally happy to record an hour of that. The upload
 * succeeds, transcription runs on silence, the minimum billed increment
 * applies, and the student is charged for nothing. So this is checked
 * BEFORE the recorder is constructed, and a failure aborts having
 * recorded and billed nothing at all.
 */
export function checkCapturedAudio(stream) {
  const tracks = stream && typeof stream.getAudioTracks === "function" ? stream.getAudioTracks() : [];
  if (!tracks.length) return { ok: false, code: "no-audio-track" };
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/*  Remembering which microphone                                      */
/* ------------------------------------------------------------------ */

/**
 * Resolves a saved preference against the devices that exist now.
 *
 * By id first, then by label, then nothing — and "nothing" means the
 * system default, silently. Safari rotates deviceId every session and
 * Chrome rotates it when site data is cleared, so a miss is ordinary
 * rather than exceptional; a student who once chose "Blue Yeti" and is
 * now on the train does not need a warning, they need it to record.
 */
export function pickDevice(devices = [], preference = null) {
  const inputs = devices.filter((d) => d && d.kind === "audioinput");
  if (!preference) return null;
  const byId = inputs.find((d) => d.deviceId && d.deviceId === preference.deviceId);
  if (byId) return byId.deviceId;
  const byLabel = preference.label && inputs.find((d) => d.label && d.label === preference.label);
  return byLabel ? byLabel.deviceId : null;
}

/** The list the picker shows: audio inputs, with "default" first if present. */
export function audioInputs(devices = []) {
  return devices.filter((d) => d && d.kind === "audioinput" && d.deviceId !== "communications");
}

/* Guarded read/write. A device preference is a convenience; if storage
   is unavailable the recorder still works on the default input, so
   there is nothing to report and nothing to retry — the same reasoning
   as noteCache.js. */
export function loadPreferredInput() {
  try {
    const raw = window.localStorage.getItem(AUDIO_INPUT_STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (e) {
    return null;
  }
}

export function savePreferredInput(pref) {
  try {
    if (!pref || !pref.deviceId) window.localStorage.removeItem(AUDIO_INPUT_STORE_KEY);
    else window.localStorage.setItem(AUDIO_INPUT_STORE_KEY, JSON.stringify({ deviceId: pref.deviceId, label: pref.label || "" }));
  } catch (e) {
    /* preference not remembered; recording is unaffected */
  }
}
