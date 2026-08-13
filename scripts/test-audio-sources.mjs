/* Tests for src/audioSources.js — what can be recorded, and what to ask
   for. Plain node:assert, same style as the rest of scripts/.

   The claims worth reading first are the two about billed silence:
   "a display capture with no audio track is refused" and "the refusal
   names what to pick instead". Everything else here is a preference or
   a label; those two are the difference between a student being charged
   for an hour of nothing and not being. */

import assert from "node:assert/strict";
import {
  describeCapabilities,
  canUseSource,
  micConstraints,
  systemConstraints,
  checkCapturedAudio,
  pickDevice,
  audioInputs,
  AUDIO_SOURCES,
  AUDIO_INPUT_STORE_KEY,
  ROOM_HIGHPASS_HZ,
} from "../src/audioSources.js";
import { AI_NOTES_COPY } from "../src/aiNotesCopy.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const UA = {
  chromeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
  firefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0",
  safari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  electron:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) UniPlanner/1.0.0 Chrome/128.0.0.0 Electron/43.2.0 Safari/537.36",
  iosCapacitor:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  androidCapacitor:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
};

const env = (userAgent, over = {}) => ({
  userAgent,
  isCapacitor: false,
  hasGetDisplayMedia: true,
  hasEnumerateDevices: true,
  ...over,
});

console.log("\naudio sources");

/* ---------- the platform matrix ---------- */

test("system audio is offered on desktop Chrome and Edge", () => {
  for (const ua of [UA.chromeWindows, UA.edgeWindows]) {
    const caps = describeCapabilities(env(ua));
    assert.equal(caps.system.available, true);
    assert.equal(caps.system.mode, "full");
  }
});

test("macOS Chrome is offered system audio but only in tab mode", () => {
  const caps = describeCapabilities(env(UA.chromeMac));
  assert.equal(caps.system.available, true);
  /* Not cosmetic: "full" here would mean the UI never warns that a
     window share comes back silent, which is the whole trap. */
  assert.equal(caps.system.mode, "tab");
});

test("Firefox and Safari are refused with a reason, not silently omitted", () => {
  for (const ua of [UA.firefox, UA.safari]) {
    const caps = describeCapabilities(env(ua));
    assert.equal(caps.system.available, false);
    assert.equal(caps.system.reason, "unsupported-browser");
    assert.ok(AI_NOTES_COPY.audioSource.unavailable[caps.system.reason]);
  }
});

test("Safari is read as Safari even though its rivals all claim to be it", () => {
  /* Chrome's user agent contains "Safari" and Electron's contains both
     "Chrome" and "Safari". Getting this order wrong would offer system
     audio to Safari, where it returns nothing. */
  assert.equal(describeCapabilities(env(UA.safari)).engine, "safari");
  assert.equal(describeCapabilities(env(UA.chromeMac)).engine, "chromium");
  assert.equal(describeCapabilities(env(UA.electron)).engine, "electron");
});

test("the desktop build gets full system audio, not tab mode, on a Mac", () => {
  /* The Electron UA says Macintosh, so a platform-only rule would put
     the desktop app in tab mode -- and there are no tabs in it. This is
     the case that makes the desktop build worth installing. */
  const caps = describeCapabilities(env(UA.electron));
  assert.equal(caps.platform, "macos");
  assert.equal(caps.system.mode, "full");
});

test("phones and tablets are microphone-only", () => {
  for (const ua of [UA.iosCapacitor, UA.androidCapacitor]) {
    const caps = describeCapabilities(env(ua, { isCapacitor: true }));
    assert.equal(caps.system.available, false);
    assert.equal(caps.system.reason, "mobile-platform");
    assert.equal(caps.microphone.available, true);
  }
});

test("only the phone shells are flagged as degrading in the background", () => {
  /* Android refuses mic capture to a backgrounded app without a
     foreground service; a desktop browser keeps getUserMedia alive in a
     background tab. Warning on desktop too would be noise, and noise is
     how a real warning gets ignored. */
  for (const ua of [UA.iosCapacitor, UA.androidCapacitor]) {
    assert.equal(describeCapabilities(env(ua, { isCapacitor: true })).mobile, true);
  }
  for (const ua of [UA.chromeWindows, UA.chromeMac, UA.electron, UA.firefox]) {
    assert.equal(describeCapabilities(env(ua)).mobile, false, `${ua.slice(0, 30)} flagged as mobile`);
  }
});

test("iOS hides the device picker; Android keeps it", () => {
  assert.equal(describeCapabilities(env(UA.iosCapacitor, { isCapacitor: true })).devicePicker.available, false);
  assert.equal(describeCapabilities(env(UA.androidCapacitor, { isCapacitor: true })).devicePicker.available, true);
});

test("a browser with no getDisplayMedia at all is refused rather than crashed into", () => {
  const caps = describeCapabilities(env(UA.chromeWindows, { hasGetDisplayMedia: false }));
  assert.equal(caps.system.available, false);
  assert.equal(caps.system.reason, "unsupported-browser");
});

test("Both needs the microphone AND system audio", () => {
  const chrome = describeCapabilities(env(UA.chromeWindows));
  const firefox = describeCapabilities(env(UA.firefox));
  assert.equal(canUseSource("both", chrome), true);
  assert.equal(canUseSource("both", firefox), false);
  assert.equal(canUseSource("microphone", firefox), true);
});

test("every source has a label and a hint", () => {
  for (const s of AUDIO_SOURCES) {
    assert.ok(AI_NOTES_COPY.audioSource.options[s], `no label for ${s}`);
    assert.ok(AI_NOTES_COPY.audioSource.hint[s], `no hint for ${s}`);
  }
});

/* ---------- the guard ---------- */

test("a display capture with no audio track is refused", () => {
  const silent = { getAudioTracks: () => [] };
  assert.deepEqual(checkCapturedAudio(silent), { ok: false, code: "no-audio-track" });
});

test("a display capture with audio is accepted", () => {
  assert.equal(checkCapturedAudio({ getAudioTracks: () => [{}] }).ok, true);
});

test("a stream that isn't one at all reads as no audio, not as fine", () => {
  /* Defaulting to ok here would mean an unexpected shape sailed through
     into a silent recording, which is the failure this guard exists for. */
  assert.equal(checkCapturedAudio(null).ok, false);
  assert.equal(checkCapturedAudio({}).ok, false);
});

test("the refusal names a browser tab on a Mac and the audio tickbox on Windows", () => {
  const mac = AI_NOTES_COPY.audioSource.noAudioCaptured("macos");
  const win = AI_NOTES_COPY.audioSource.noAudioCaptured("windows");
  assert.match(mac, /tab/i);
  assert.notEqual(mac, win);
  assert.match(win, /audio/i);
});

test("the refusal says nothing was recorded and nothing was charged", () => {
  /* Same rule as the summary-failure copy: a student who has just been
     stopped mid-flow needs to know whether it cost them anything, and
     the answer here is no. */
  for (const p of ["macos", "windows", "linux", "other"]) {
    assert.match(AI_NOTES_COPY.audioSource.noAudioCaptured(p), /allowance/i);
  }
});

/* ---------- constraints ---------- */

test("the microphone path turns room handling off", () => {
  const c = micConstraints(null);
  assert.equal(c.echoCancellation, false);
  assert.equal(c.noiseSuppression, false);
  assert.equal(c.autoGainControl, false);
});

test("the system path does not carry room handling at all", () => {
  /* Two constraint sets, not one with a flag. Asking a loopback stream
     to disable echo cancellation is meaningless, and a shared object is
     how the two silently become one. */
  const s = systemConstraints();
  assert.equal("echoCancellation" in s, false);
  assert.equal("noiseSuppression" in s, false);
  assert.equal("autoGainControl" in s, false);
});

test("both paths ask for mono", () => {
  assert.equal(micConstraints(null).channelCount, 1);
  assert.equal(systemConstraints().channelCount, 1);
});

test("a chosen device is requested as ideal, never as exact", () => {
  /* exact throws OverconstrainedError on a headset that has been
     unplugged, so a student who took their earphones out would be told
     recording failed instead of falling back to the built-in mic. */
  const c = micConstraints("abc123");
  assert.deepEqual(c.deviceId, { ideal: "abc123" });
  assert.equal("exact" in c.deviceId, false);
});

test("no device chosen means no deviceId constraint at all", () => {
  assert.equal("deviceId" in micConstraints(null), false);
  assert.equal("deviceId" in micConstraints(""), false);
});

test("the high-pass sits below a speaking voice", () => {
  assert.ok(ROOM_HIGHPASS_HZ > 0 && ROOM_HIGHPASS_HZ <= 85);
});

/* ---------- remembering a microphone ---------- */

const DEVICES = [
  { kind: "audioinput", deviceId: "default", label: "Default - MacBook Pro Microphone" },
  { kind: "audioinput", deviceId: "yeti-1", label: "Blue Yeti" },
  { kind: "audiooutput", deviceId: "spk-1", label: "Speakers" },
  { kind: "videoinput", deviceId: "cam-1", label: "FaceTime HD" },
];

test("only audio inputs reach the picker", () => {
  const list = audioInputs(DEVICES);
  assert.equal(list.length, 2);
  assert.ok(list.every((d) => d.kind === "audioinput"));
});

test("a saved microphone is reselected by id", () => {
  assert.equal(pickDevice(DEVICES, { deviceId: "yeti-1", label: "Blue Yeti" }), "yeti-1");
});

test("a rotated deviceId still matches by label", () => {
  /* Safari rotates deviceId every session and Chrome rotates it when
     site data is cleared, so a miss on the id is ordinary rather than
     exceptional. */
  assert.equal(pickDevice(DEVICES, { deviceId: "stale-id-from-last-week", label: "Blue Yeti" }), "yeti-1");
});

test("a microphone that is simply gone falls back to the default, silently", () => {
  /* Null means "no deviceId constraint", which means the system
     default. There is deliberately no warning: a student who once chose
     a desk mic and is now on the train needs it to record, not to be
     told about a device they know they left at home. */
  assert.equal(pickDevice(DEVICES, { deviceId: "gone", label: "Podcast Mic" }), null);
  assert.equal(pickDevice([], { deviceId: "yeti-1", label: "Blue Yeti" }), null);
  assert.equal(pickDevice(DEVICES, null), null);
});

test("an empty label never matches an unlabelled device", () => {
  /* Before permission is granted every label is "", so a naive label
     match would pick an arbitrary microphone and look deliberate. */
  const unlabelled = [{ kind: "audioinput", deviceId: "a", label: "" }, { kind: "audioinput", deviceId: "b", label: "" }];
  assert.equal(pickDevice(unlabelled, { deviceId: "z", label: "" }), null);
});

test("the device preference is stored outside the synced blob", () => {
  /* A deviceId means nothing on another machine, so syncing it is at
     best a no-op and at worst two devices overwriting each other
     through last-write-wins. The name is declared in test-legal.mjs
     with the other on-device stores. */
  assert.match(AUDIO_INPUT_STORE_KEY, /^uni-planner-/);
});

console.log(`\n${passed} audio source tests passed\n`);
