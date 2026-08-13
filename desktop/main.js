// Electron main process — opens the University Planner in a native desktop window.
const { app, BrowserWindow, shell, session, desktopCapturer } = require("electron");
const path = require("path");

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 820,
    minWidth: 380,
    minHeight: 520,
    title: "University Planner",
    backgroundColor: "#f5f5f4",
    // Mac-style inset traffic lights; ignored on Windows/Linux.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "www", "index.html"));

  // Avoid a white flash while the app boots.
  mainWindow.once("ready-to-show", () => mainWindow.show());

  // Any external link opens in the real browser, not inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/* getDisplayMedia in a renderer does nothing until the main process
   answers the request — there is no built-in picker. This is what makes
   "record this computer's audio" work in the desktop build, and it is
   the one thing the desktop app can do that the website cannot: browsers
   only ever offer loopback alongside a screen or tab share, and on macOS
   Chrome only alongside a TAB.

   `audio: "loopback"` asks the OS for the system output. Whether it
   arrives is the OS's decision — macOS needs ScreenCaptureKit and a
   screen-recording permission — so nothing here assumes it worked. The
   renderer checks the returned stream for an audio track before it
   starts recording (checkCapturedAudio in src/audioSources.js) and
   aborts if there is none, which is the same guard that catches a
   browser share with the audio box unticked. */
function enableSystemAudioCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen"] })
        .then((sources) => {
          if (!sources.length) return callback({});
          callback({ video: sources[0], audio: "loopback" });
        })
        .catch(() => callback({}));
    },
    // We never show the captured video and the student has already
    // chosen to record, so there is no second picker to put in front of
    // them. useSystemPicker:false keeps that true on every platform.
    { useSystemPicker: false }
  );
}

app.whenReady().then(() => {
  try {
    enableSystemAudioCapture();
  } catch (e) {
    // An Electron without the handler simply has no system audio; the
    // microphone path is untouched and must not be taken down with it.
  }
  createWindow();

  // Standard Mac behaviour: clicking the dock icon reopens the window.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// On Mac, apps normally stay running when all windows are closed.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
