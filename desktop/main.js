// Electron main process — opens the University Planner in a native desktop window.
const { app, BrowserWindow, shell } = require("electron");
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

app.whenReady().then(() => {
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
