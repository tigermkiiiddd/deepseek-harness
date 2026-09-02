// Electron shell for the DeepSeek Harness Web UI.
//
// Boot sequence: find a free port -> spawn `dsh web` from a repo checkout
// with the system Node -> poll until the server answers -> load it in the
// window. On quit, the server process tree is killed.
//
// The server always runs from a deepseek-harness repo checkout. Resolution
// order: $DSH_REPO_DIR -> saved config in userData -> ../../ relative to this
// file (monorepo dev layout). If none match, the user is asked to pick the
// repo folder once and the choice is persisted.

const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const HOST = '127.0.0.1';
const CONFIG_FILE = () => path.join(app.getPath('userData'), 'dsh-desktop-config.json');

// Renderer diagnostics. In the packaged app the renderer has no reachable
// console, and its failures are otherwise silent: a crashed slot boundary
// only `console.error`s, and an OOM-killed renderer leaves nothing behind.
// Mirror renderer warnings/errors, process-gone events, and a per-minute
// memory sample into userData/logs/renderer.log so a rare, non-reproducible
// failure still leaves evidence. Rotates to renderer.old.log at 4 MB.
const LOG_DIR = () => path.join(app.getPath('userData'), 'logs');
const LOG_FILE = () => path.join(LOG_DIR(), 'renderer.log');
const LOG_MAX_BYTES = 4 * 1024 * 1024;

function logRenderer(line) {
  try {
    fs.mkdirSync(LOG_DIR(), { recursive: true });
    const file = LOG_FILE();
    if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX_BYTES) {
      fs.renameSync(file, path.join(LOG_DIR(), 'renderer.old.log'));
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Swallows only filesystem errors from the writes above; diagnostics
    // logging must never take down the shell it observes.
  }
}

function wireRendererDiagnostics(win) {
  const wc = win.webContents;
  logRenderer(`[boot] electron=${process.versions.electron} chrome=${process.versions.chrome} node=${process.versions.node}`);
  wc.on('console-message', (event) => {
    if (event.level !== 'warning' && event.level !== 'error') return;
    const loc = event.sourceId ? ` (${path.basename(event.sourceId)}:${event.lineNumber})` : '';
    logRenderer(`[console:${event.level}]${loc} ${event.message}`);
  });
  wc.on('render-process-gone', (_event, details) => {
    logRenderer(`[render-process-gone] reason=${details.reason} exitCode=${details.exitCode}`);
  });
  wc.on('unresponsive', () => logRenderer('[unresponsive] renderer stopped responding'));
  wc.on('did-fail-load', (_event, code, desc, url) => {
    logRenderer(`[did-fail-load] errorCode=${code} ${desc} ${url}`);
  });
  const memTimer = setInterval(() => {
    if (win.isDestroyed()) return;
    const pid = wc.getOSProcessId();
    for (const metric of app.getAppMetrics()) {
      if (metric.pid === pid && metric.memory) {
        const mb = (kb) => Math.round(kb / 1024);
        logRenderer(`[memory] workingSet=${mb(metric.memory.workingSetSize)}MB peak=${mb(metric.memory.peakWorkingSetSize ?? 0)}MB`);
      }
    }
  }, 60_000);
  win.on('closed', () => clearInterval(memTimer));
}

function isRepoDir(dir) {
  return !!dir && fs.existsSync(path.join(dir, 'apps/cli/src/bin.ts'));
}

function loadSavedRepoDir() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8'));
    return cfg.repoDir || null;
  } catch {
    return null;
  }
}

function saveRepoDir(dir) {
  fs.mkdirSync(path.dirname(CONFIG_FILE()), { recursive: true });
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify({ repoDir: dir }, null, 2));
}

function resolveRepoDir() {
  const candidates = [
    process.env.DSH_REPO_DIR,
    loadSavedRepoDir(),
    path.resolve(__dirname, '..', '..'),
  ];
  return candidates.find(isRepoDir) || null;
}

// Ask the user to locate the repo checkout; persists a valid choice.
// Returns null if the user cancels.
async function promptForRepoDir() {
  for (;;) {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'DeepSeek Harness',
      message: 'Select your deepseek-harness repo checkout',
      detail:
        'The desktop shell runs the server from a local deepseek-harness repo ' +
        '(with pnpm install + pnpm run build done). Pick that folder once; ' +
        'the choice is remembered.',
      buttons: ['Choose folder', 'Quit'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return null;
    const picked = await dialog.showOpenDialog({
      title: 'Select the deepseek-harness repo folder',
      properties: ['openDirectory'],
    });
    if (picked.canceled || picked.filePaths.length === 0) return null;
    const dir = picked.filePaths[0];
    if (isRepoDir(dir)) {
      saveRepoDir(dir);
      return dir;
    }
    await dialog.showMessageBox({
      type: 'error',
      title: 'DeepSeek Harness',
      message: 'Not a deepseek-harness repo checkout',
      detail: `${dir} does not contain apps/cli/src/bin.ts`,
      buttons: ['OK'],
    });
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, HOST, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        req.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`server did not come up within ${timeoutMs}ms: ${url}`));
        } else {
          setTimeout(attempt, 300);
        }
      });
    };
    attempt();
  });
}

function killTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

const LOADING_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; height: 100vh; display: flex; flex-direction: column; gap: 12px;
         align-items: center; justify-content: center; background: #0f1115; color: #9aa4b2;
         font: 14px/1.5 system-ui, sans-serif; }
  .spin { width: 28px; height: 28px; border: 3px solid #2a2f3a; border-top-color: #4d7cfe;
          border-radius: 50%; animation: r 0.8s linear infinite; }
  @keyframes r { to { transform: rotate(360deg); } }
</style></head><body>
  <div class="spin"></div>
  <div>Starting DeepSeek Harness…</div>
</body></html>`)}`;

let server = null;
let mainWindow = null;

async function boot() {
  let repoDir = resolveRepoDir();
  if (!repoDir) repoDir = await promptForRepoDir();
  if (!repoDir) {
    app.quit();
    return;
  }

  const port = await getFreePort();
  const url = `http://${HOST}:${port}`;

  // Spawn with the system Node, not ELECTRON_RUN_AS_NODE: dsh's plugin loader
  // detects Electron and swaps in native-only plugins that are not installed.
  const nodeBin = process.env.DSH_NODE || (process.platform === 'win32' ? 'node.exe' : 'node');
  server = spawn(
    nodeBin,
    ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--host', HOST, '--port', String(port)],
    {
      cwd: repoDir,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  server.stdout.on('data', (d) => process.stdout.write(`[dsh] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[dsh] ${d}`));
  server.on('exit', (code) => {
    console.log(`[dsh] server exited with code ${code}`);
    if (!mainWindow || mainWindow.isDestroyed()) app.quit();
  });

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    title: 'DeepSeek Harness',
  });
  wireRendererDiagnostics(mainWindow);
  mainWindow.loadURL(LOADING_PAGE);

  try {
    await waitForServer(url);
    await mainWindow.loadURL(url);
  } catch (err) {
    dialog.showErrorBox('DeepSeek Harness', String(err));
    app.quit();
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(boot);

  app.on('window-all-closed', () => {
    killTree(server);
    app.quit();
  });

  app.on('before-quit', () => killTree(server));
}
