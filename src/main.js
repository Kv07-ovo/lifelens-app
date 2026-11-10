const {
  app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, powerMonitor, protocol, net,
} = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

const configStore = require('./config');
const storage = require('./storage');
const analyzer = require('./analyzer');
const { captureScreens } = require('./capture');
const { renderIcon } = require('./icon');
const { createSummarizer } = require('./summarizer');
const { createDiary } = require('./diary');
const { buildDashboard } = require('./dashboard');
const { createQa } = require('./qa');
const { createSync } = require('./sync');

// 界面通过 lifelens://image/?path=... 读取截图，由主进程校验后再给，只放行数据目录里的 jpg
protocol.registerSchemesAsPrivileged([
  { scheme: 'lifelens', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const PROBE_INTERVAL_MS = 15000;
const SUMMARY_TICK_MS = 30000; // 每 30 秒看一次有没有新结束的 10 分钟时间段
const SYNC_INTERVAL_MS = 10 * 60 * 1000;
const HEATMAP_HOURS = 12; // 热力图显示最近 12 小时 = 72 个点

let config;
let win = null;
let tray = null;
let quitting = false;

let captureTimer = null;
let capturingNow = false;
let analyzing = false;
const queue = []; // 待分析：{ file, id, images: [{ path, active }], attempts }

const state = {
  capturing: false,
  locked: false,
  lastCaptureAt: null,
  lastCaptureError: null,
  captureCount: 0,
  analyzedCount: 0,
  currentId: null,
  model: { online: false, model: null, vision: null, loaded: null, error: null },
};

// 本地模型一次只处理一个请求：截图分析和 10 分钟汇总共用这把锁
let modelChain = Promise.resolve();
function withModel(fn) {
  const run = modelChain.then(fn, fn);
  modelChain = run.catch(() => {});
  return run;
}

const sync = createSync({
  getConfig: () => config,
  onChange: () => broadcastState(),
  // 拉到了其他设备的新数据：重新读索引，让动态、日记、看板、问答都能看到
  onImported: async () => {
    await summarizer.load();
    await diary.load();
    send('summaries-changed');
    send('diary-changed');
  },
});

const summarizer = createSummarizer({
  getExtraRoots: () => sync.extraRoots(),
  getConfig: () => config,
  getModelName: () => state.model.model,
  withModel,
  isAnalysisQueued: (id) => state.currentId === id || queue.some((job) => job.id === id),
  onChange: () => {
    broadcastState();
    send('summaries-changed');
  },
});

const diary = createDiary({
  getExtraRoots: () => sync.extraRoots(),
  getConfig: () => config,
  getModelName: () => state.model.model,
  withModel,
  summarizer,
  onChange: () => {
    broadcastState();
    send('diary-changed');
  },
});

const qa = createQa({
  getConfig: () => config,
  getModelName: () => state.model.model,
  withModel,
  summarizer,
  diary,
  onProgress: (text) => send('qa-progress', text),
});

/* ---------- 与界面通信 ---------- */

function snapshot() {
  return { ...state, queueLength: queue.length, summary: summarizer.status(), diary: diary.status(), sync: sync.status(), config };
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function broadcastState() {
  send('state', snapshot());
  updateTray();
}

function insideDataDir(target) {
  const resolved = path.resolve(String(target || ''));
  return resolved.startsWith(path.resolve(config.dataDir) + path.sep) ? resolved : null;
}

function decorate(record, file) {
  const screens = (record.screens || []).map((s) => ({
    ...s,
    imageUrl: `lifelens://image/?path=${encodeURIComponent(s.imagePath)}`,
  }));
  return { ...record, screens, file };
}

/* ---------- 定时截屏 ---------- */

function scheduleNext() {
  clearTimeout(captureTimer);
  if (!state.capturing) return;
  const ms = config.intervalSec * 1000;
  let delay = ms - (Date.now() % ms); // 对齐到整点：:00 / :20 / :40
  if (delay < 500) delay += ms;
  captureTimer = setTimeout(() => {
    scheduleNext();
    if (state.locked && config.skipWhenLocked) return;
    captureOnce();
  }, delay);
}

async function captureOnce() {
  if (capturingNow) return;
  capturingNow = true;
  try {
    const now = new Date();
    const { shots, displayCount } = await captureScreens(config);
    const screens = [];
    for (const shot of shots) {
      // 单屏：18-24-20.jpg；多屏：18-24-20-screen1.jpg、18-24-20-screen2.jpg ...
      const suffix = displayCount > 1 ? `-screen${shot.index}` : '';
      const { buffer, ...info } = shot;
      screens.push({ ...info, imagePath: await storage.saveScreenshot(config.dataDir, now, buffer, suffix) });
    }
    const p = storage.parts(now);
    const record = {
      id: `${p.date.replace(/-/g, '')}-${p.fileClock.replace(/-/g, '')}-${p.ms}`,
      timestamp: storage.localIso(now),
      time: `${p.date} ${p.clock}`,
      imagePaths: screens.map((s) => s.imagePath), // 所有屏幕的截图路径，按屏幕位置从左到右、从上到下
      screenCount: screens.length,
      screens, // 每块屏幕的详情：序号、是否主屏、鼠标是否在上面、分辨率、图片路径
      activity: '',
      sentences: [],
      status: config.analysisEnabled ? 'pending' : 'skipped',
      model: null,
      analyzedAt: null,
      analysisMs: null,
      error: null,
    };
    const file = await storage.appendRecord(config.dataDir, now, record);

    state.captureCount += 1;
    state.lastCaptureAt = record.timestamp;
    state.lastCaptureError = null;
    send('record', decorate(record, file));

    if (config.analysisEnabled) {
      const images = screens.map((s) => ({ path: s.imagePath, active: s.active }));
      queue.push({ file, id: record.id, images, attempts: 0 });
      await trimQueue();
      pump();
    }
  } catch (err) {
    state.lastCaptureError = err.message;
  } finally {
    capturingNow = false;
    broadcastState();
  }
}

function setCapturing(on) {
  state.capturing = !!on;
  scheduleNext();
  broadcastState();
}

/* ---------- 分析队列 ---------- */

async function finish(job, patch) {
  const record = await storage.updateRecord(job.file, job.id, patch).catch(() => null);
  if (record) send('record', decorate(record, job.file));
}

// 模型处理不过来时，队列超过上限就放弃最旧的，保证不会无限堆积
async function trimQueue() {
  while (queue.length > config.maxQueue) {
    await finish(queue.shift(), { status: 'skipped', error: '待分析队列已满，已跳过这张' });
  }
}

async function pump() {
  if (analyzing || !config.analysisEnabled) return;
  analyzing = true;
  try {
    while (queue.length && config.analysisEnabled) {
      const job = queue.shift();
      state.currentId = job.id;
      broadcastState();
      try {
        const result = await withModel(() => analyzer.analyze(config, job.images, state.model.model));
        state.model = { ...state.model, online: true, error: null, model: result.model || state.model.model };
        state.analyzedCount += 1;
        await finish(job, {
          activity: result.activity,
          sentences: result.sentences,
          status: 'done',
          model: result.model,
          analyzedAt: storage.localIso(new Date()),
          analysisMs: result.ms,
          error: null,
        });
      } catch (err) {
        if (err instanceof analyzer.OfflineError) {
          // 服务没起来（比如模型还在下载）：记录保持 pending，等服务上线后自动补分析
          queue.unshift(job);
          state.model = { ...state.model, online: false, error: err.message };
          break;
        }
        job.attempts += 1;
        if (err.code === 'ENOENT' || job.attempts >= 2) {
          await finish(job, { status: 'error', error: err.message, analyzedAt: storage.localIso(new Date()) });
        } else {
          queue.unshift(job);
        }
      }
    }
  } finally {
    analyzing = false;
    state.currentId = null;
    broadcastState();
  }
}

async function refreshModel() {
  if (analyzing) return; // 正在分析说明服务在线，不用打扰它
  state.model = await analyzer.probe(config);
  broadcastState();
  if (state.model.online && queue.length) pump();
}

async function restorePending() {
  if (!config.analysisEnabled) return;
  const pending = await storage.listPending(config.dataDir, config.maxQueue).catch(() => []);
  const known = new Set(queue.map((job) => job.id));
  for (const job of pending) {
    if (!known.has(job.id)) queue.push({ ...job, attempts: 0 });
  }
  queue.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  await trimQueue();
  broadcastState();
}

/* ---------- 窗口与托盘 ---------- */

// 托盘和窗口图标：蓝色 = 正在截屏，灰色 = 已暂停
function makeIcon(size, active) {
  return nativeImage.createFromBitmap(renderIcon(size, active, 'bgra'), { width: size, height: size });
}

function showWindow() {
  if (!win || win.isDestroyed()) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    title: 'LifeLens',
    icon: makeIcon(64, true),
    autoHideMenuBar: true,
    backgroundColor: '#0b4a4d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  // 关窗口只是收进托盘，截屏继续；从托盘菜单“退出”才真正退出
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
}

function updateTray() {
  if (!tray) return;
  tray.setImage(makeIcon(32, state.capturing));
  tray.setToolTip(`LifeLens - ${state.capturing ? '正在截屏' : '已暂停'}${queue.length ? `，${queue.length} 张待分析` : ''}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 LifeLens', click: showWindow },
      { label: state.capturing ? '暂停截屏' : '开始截屏', click: () => setCapturing(!state.capturing) },
      { label: '打开数据目录', click: () => shell.openPath(config.dataDir) },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
}

function createTray() {
  tray = new Tray(makeIcon(32, state.capturing));
  tray.on('click', showWindow);
  updateTray();
}

/* ---------- IPC ---------- */

function registerIpc() {
  ipcMain.handle('state:get', () => snapshot());
  ipcMain.handle('records:recent', async (_event, limit) => {
    const n = Math.min(200, Math.max(1, Number(limit) || 30));
    const records = await storage.listRecent(config.dataDir, n);
    return records.map((r) => decorate(r, r.file));
  });
  ipcMain.handle('capture:toggle', () => {
    setCapturing(!state.capturing);
    return snapshot();
  });
  ipcMain.handle('capture:now', async () => {
    await captureOnce();
    return snapshot();
  });
  ipcMain.handle('config:save', async (_event, next) => {
    config = configStore.save({ ...config, ...next });
    scheduleNext();
    await restorePending();
    await refreshModel();
    await summarizer.reload();
    await diary.reload();
    sync.run();
    return snapshot();
  });
  ipcMain.handle('sync:run', async () => {
    await sync.run();
    return snapshot();
  });
  ipcMain.handle('diary:ensure', () => diary.ensure());
  ipcMain.handle('diary:month', (_event, year, month) => diary.month(Number(year), Number(month)));
  ipcMain.handle('diary:get', (_event, date) => diary.get(String(date)));
  ipcMain.handle('diary:generate', (_event, date) => diary.request(String(date)));
  ipcMain.handle('screenshots:usage', () => storage.screenshotUsage(config.dataDir, storage.parts(new Date()).date));
  ipcMain.handle('screenshots:clean', async () => {
    const today = storage.parts(new Date()).date;
    const usage = await storage.screenshotUsage(config.dataDir, today);
    if (!usage.totalFiles) return { cancelled: true, empty: true };
    const size = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`);
    const choice = await dialog.showMessageBox(win, {
      type: 'warning',
      title: '清理截图',
      message: '要删除哪些截图？',
      detail:
        `今天（${today}）：${usage.dayFiles} 张，${size(usage.dayBytes)}\n` +
        `全部：${usage.totalFiles} 张，${size(usage.totalBytes)}\n\n` +
        '只删除图片文件，删除后无法恢复。每条记录的文字总结、10 分钟汇总、日记都会保留。\n还没分析完的截图不会被删。',
      buttons: ['只删今天的', '删除全部', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (choice.response === 2) return { cancelled: true };
    const result = await storage.deleteScreenshots(config.dataDir, choice.response === 0 ? today : null);
    return { ...result, scope: choice.response === 0 ? 'today' : 'all' };
  });
  ipcMain.handle('qa:ask',async (_event, question, history) => {
    try {
      return await qa.ask(question, history);
    } catch (err) {
      return { error: err.message };
    }
  });
  ipcMain.handle('dashboard:get',(_event, period, anchor) => {
    const kind = ['day', 'week', 'month', 'year'].includes(period) ? period : 'day';
    return buildDashboard((from, to) => summarizer.lightRange(from, to), kind, Number(anchor) || Date.now());
  });
  ipcMain.handle('summaries:heatmap', () => summarizer.heatmap(HEATMAP_HOURS));
  ipcMain.handle('summaries:get', (_event, id) => summarizer.get(String(id)));
  ipcMain.handle('summaries:query', (_event, filter) => summarizer.query(filter || {}));
  ipcMain.handle('summaries:facets', () => summarizer.facets());
  ipcMain.handle('model:test', async () => {
    await refreshModel();
    return snapshot();
  });
  ipcMain.handle('folder:choose', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择数据目录',
      defaultPath: config.dataDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('folder:open', async () => {
    await require('fs/promises').mkdir(config.dataDir, { recursive: true });
    return shell.openPath(config.dataDir);
  });
  ipcMain.handle('path:open', (_event, target) => {
    // 只允许打开数据目录里的文件
    const resolved = insideDataDir(target);
    return resolved ? shell.openPath(resolved) : '路径不在数据目录内';
  });
}

/* ---------- 启动 ---------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.lifelens.app');
    Menu.setApplicationMenu(null); // 不要 Electron 默认的 File/Edit/View 菜单
    config = configStore.load();
    protocol.handle('lifelens', async (request) => {
      const target = insideDataDir(new URL(request.url).searchParams.get('path'));
      if (!target || !/\.jpe?g$/i.test(target)) return new Response('forbidden', { status: 403 });
      try {
        // 列表里只需要小图，用系统缩略图，省内存
        const thumb = await nativeImage.createThumbnailFromPath(target, { width: 480, height: 480 });
        return new Response(thumb.toJPEG(80), { headers: { 'Content-Type': 'image/jpeg' } });
      } catch {
        return net.fetch(pathToFileURL(target).href);
      }
    });
    registerIpc();
    createWindow();
    createTray();

    powerMonitor.on('lock-screen', () => {
      state.locked = true;
      broadcastState();
    });
    powerMonitor.on('unlock-screen', () => {
      state.locked = false;
      broadcastState();
    });
    powerMonitor.on('resume', scheduleNext);

    await restorePending();
    if (config.autoStart) setCapturing(true);
    refreshModel();
    setInterval(refreshModel, PROBE_INTERVAL_MS);
    await summarizer.reload(); // 补上应用没开时漏掉的 10 分钟汇总
    await diary.reload();
    setInterval(() => summarizer.tick(), SUMMARY_TICK_MS);
    sync.run(); // 启动时同步一次，之后每 10 分钟一次
    setInterval(() => sync.run(), SYNC_INTERVAL_MS);
  });

  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('window-all-closed', () => {
    /* 留在托盘里继续运行 */
  });
}
