const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('node:path');

const target = new URL(process.env.RENGINE_UI_URL);
if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !/^[0-9a-f]{64}$/.test(target.hash.slice(1))) {
  throw new Error('RENGINE_UI_URL must identify an authenticated local rEngine sidecar.');
}
if (process.env.RENGINE_DESKTOP_STATE) app.setPath('userData', process.env.RENGINE_DESKTOP_STATE);
app.setName('rEngine');
let window;
let closeReady = false;
let closing = false;

app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 1440, height: 960, minWidth: 880, minHeight: 560, title: 'rEngine', backgroundColor: '#12161b',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== target.origin) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'pointerLock'));
  ipcMain.handle('choose-project', async event => {
    if (event.sender !== window.webContents) throw new Error('Unknown window');
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'], title: 'Open project or worktree' });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.on('finish-close', event => { if (event.sender === window.webContents) { closeReady = true; window.close(); } });
  ipcMain.on('cancel-close', event => { if (event.sender === window.webContents) closing = false; });
  window.on('close', event => {
    if (closeReady || window.webContents.isCrashed()) return;
    event.preventDefault();
    if (!closing) { closing = true; window.webContents.send('prepare-close'); }
  });
  await window.loadURL(target.href);
});
app.on('window-all-closed', () => app.quit());
