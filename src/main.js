const {
  app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, powerMonitor, protocol, net, globalShortcut,
} = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

const configStore = require('./config');
const storage = require('./storage');
const analyzer = require('./analyzer');
const { captureScreens, sameScreens } = require('./capture');
const { renderIcon } = require('./icon');
const { createSummarizer, slotStart, SLOT_MS } = require('./summarizer');
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
const PAUSE_SHORTCUT = 'Ctrl+Alt+P'; // 全局快捷键：不用切到 LifeLens 窗口就能停止 / 恢复记录
const SYNC_INTERVAL_MS =10 * 60 * 1000;
const HEATMAP_HOURS = 12; // 热力图显示最近 12 小时 = 72 个点

let config;
let win = null;
let tray = null;
let quitting = false;

let captureTimer = null;
let capturingNow = false;
let analyzing = false;
let lastPrints = null; // 上一次保存的截屏的画面指纹
const queue = []; // 待分析：{ file, id, images: [{ path, active }], attempts }

const state = {
  capturing: false,
  locked: false,
  lastCaptureAt: null,
  lastCaptureError: null,
  captureCount: 0,
  pausedUntil: null, // 定时暂停到这个时间（毫秒），null = 没有定时暂停
  idle: false, // 人不在电脑前（无操作且画面没变），暂不记录
  idleSkipped: 0,
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
    if (state.pausedUntil) {
      if (Date.now() < state.pausedUntil) return; // 定时暂停中
      state.pausedUntil = null; // 到点自动恢复
      broadcastState();
    }
    captureOnce();
  }, delay);
}

// manual = 用户点了“立即截一张”，这时不管是否空闲都保存
async function captureOnce(manual = false) {
  if (capturingNow) return;
  capturingNow = true;
  try {
    const now = new Date();
    const { shots, displayCount } = await captureScreens(config);

    // 空闲检测：一段时间没有键鼠操作、而且画面和上一次保存时相比没变，说明人不在电脑前，
    // 这一张就不保存、不分析、不计时。画面在变（比如在看视频）则照常记录。
    const prints = shots.map((shot) => shot.fingerprint);
    const idleFor = powerMonitor.getSystemIdleTime();
    if (!manual && config.idleSkipSec > 0 && idleFor >= config.idleSkipSec && sameScreens(lastPrints, prints)) {
      state.idle = true;
      state.idleSkipped += 1;
      return;
    }
    state.idle = false;
    lastPrints = prints;

    const screens = [];
    for (const shot of shots) {
      // 单屏：18-24-20.jpg；多屏：18-24-20-screen1.jpg、18-24-20-screen2.jpg ...
      const suffix = displayCount > 1 ? `-screen${shot.index}` : '';
      const { buffer, fingerprint, ...info } = shot;
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
  state.pausedUntil = null;
  scheduleNext();
  broadcastState();
}

/** 暂停记录若干分钟，到点自动恢复。暂停期间不截屏，不产生任何记录 */
function pauseFor(minutes) {
  state.pausedUntil = minutes > 0 ? Date.now() + minutes * 60000 : null;
  if (minutes > 0 && !state.capturing) state.capturing = true; // 之前是手动停止状态时，定时暂停到点后要能恢复
  scheduleNext();
  broadcastState();
}

const isRecording = () => state.capturing && !(state.pausedUntil && Date.now() < state.pausedUntil);

/** 全局快捷键：正在记录就停下（直到手动恢复），已停下或定时暂停中就恢复 */
function toggleRecording() {
  setCapturing(!isRecording());
}

/* ---------- 删除一段时间的记录 ---------- */

/**
 * 删除 [from, to) 这段时间在本机留下的全部痕迹：截图、20 秒记录、10 分钟汇总，涉及到的日记也删掉待重写。
 * 范围会对齐到 10 分钟边界，这样不会留下“只删了一半”的时间段。
 * 开启了同步时，删除会作为一次普通提交推送到仓库，其他设备同步后也会消失。
 */
async function deleteRange(fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return { cancelled: true };
  const from = slotStart(fromMs);
  const to = Math.min(Date.now() + 1000, slotStart(toMs - 1) + SLOT_MS);

  const records = await storage.deleteRange(config.dataDir, from, to, true);
  const summaries = await summarizer.deleteRange(from, to, true);
  if (!records.records && !summaries.slots) return { cancelled: true, empty: true };

  const label = (ms) => {
    const p = storage.parts(new Date(ms));
    return `${p.date} ${p.clock.slice(0, 5)}`;
  };
  const choice = await dialog.showMessageBox(win, {
    type: 'warning',
    title: '删除这段记录',
    message: `删除 ${label(from)} 到 ${label(to)} 的全部记录？`,
    detail:
      `将删除：${records.records} 条截屏记录、${records.images} 张截图、${summaries.slots} 段 10 分钟汇总` +
      `${summaries.dates.length ? `，以及 ${summaries.dates.join('、')} 的日记（之后会按剩下的记录重新生成）` : ''}。\n` +
      `${summaries.others ? `这段时间里另有 ${summaries.others} 段来自其他设备的汇总，需要到那台电脑上删除。\n` : ''}` +
      `${config.syncEnabled ? '删除会同步到你的远程仓库，其他设备同步后也会消失；仓库的历史提交里仍能找到旧内容。\n' : ''}` +
      '删除后无法恢复。如果这段时间里出现过密码，请同时去修改那个密码。',
    buttons: ['删除', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (choice.response !== 0) return { cancelled: true };

  // 先删会被同步出去的文字（汇总、日记），再删本机的记录和截图。
  // 这样万一第一步就失败（比如文件被占用），什么都还没删，用户重试即可；不会出现“截图删了、汇总文字还在往外同步”的情况。
  const result = await summarizer.deleteRange(from, to, false);
  const diaries = await diary.invalidate(result.dates);
  await sync.forget(diaries);
  const removed = await storage.deleteRange(config.dataDir, from, to, false);
  const gone = new Set(removed.ids);
  for (let i = queue.length - 1; i >= 0; i--) if (gone.has(queue[i].id)) queue.splice(i, 1); // 还没分析的也不用分析了
  if (config.syncEnabled) sync.run(true); // true：就算有一次同步正在进行，也要在它之后再同步一次，把删除推出去
  broadcastState();
  send('summaries-changed');
  send('diary-changed');
  return { records: removed.records, images: removed.images, slots: result.slots, diaries: diaries.length, synced: config.syncEnabled };
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
        if (err instanceof analyzer.TimeoutError && (job.timeouts = (job.timeouts || 0) + 1) < 5) {
          // 模型太忙（比如显卡被别的程序占满）导致超时：不算失败，放回队列，等下一轮再试
          queue.unshift(job);
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
  tray.setImage(makeIcon(32, isRecording()));
  tray.setToolTip(`LifeLens - ${isRecording() ? '正在截屏' : '已暂停'}${queue.length ? `，${queue.length} 张待分析` : ''}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 LifeLens', click: showWindow },
      { label: isRecording() ? `停止截屏（${PAUSE_SHORTCUT}）` : `恢复截屏（${PAUSE_SHORTCUT}）`, click: toggleRecording },
      { label: '暂停 15 分钟', click: () => pauseFor(15) },
      { label: '暂停 1 小时', click: () => pauseFor(60) },
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
    toggleRecording(); // 定时暂停中点这个按钮应该是恢复，而不是变成停止
    return snapshot();
  });
  ipcMain.handle('capture:now', async () => {
    await captureOnce(true);
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
  ipcMain.handle('capture:pause', (_event, minutes) => {
    pauseFor(Math.min(24 * 60, Math.max(0, Number(minutes) || 0)));
    return snapshot();
  });
  ipcMain.handle('range:delete', async (_event, fromMs, toMs) => {
    try {
      return await deleteRange(Number(fromMs), Number(toMs));
    } catch (err) {
      return { error: err.message }; // 让界面明确告诉用户“没删完”，而不是悄悄失败
    }
  });
  ipcMain.handle('retry:failed',async () => {
    // 1. 分析失败的截图重新排队  2. 失败或被跳过的 10 分钟时间段重新排队（等截图分析完后再汇总）
    const jobs = await storage.requeueFailed(config.dataDir, config.maxQueue);
    const known = new Set(queue.map((job) => job.id));
    for (const job of jobs) if (!known.has(job.id)) queue.push({ ...job, attempts: 0 });
    queue.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const slots = await summarizer.retryFailed();
    pump();
    broadcastState();
    return { records: jobs.length, slots };
  });
  ipcMain.handle('screenshots:usage',() => storage.screenshotUsage(config.dataDir, storage.parts(new Date()).date));
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
    state.shortcutOk = globalShortcut.register(PAUSE_SHORTCUT, toggleRecording); // 被别的程序占用时返回 false

    await restorePending();
    if (config.autoStart) setCapturing(true);
    refreshModel();
    setInterval(refreshModel, PROBE_INTERVAL_MS);
    await summarizer.reload(); // 补上应用没开时漏掉的 10 分钟汇总
    await diary.reload();
    setInterval(() => summarizer.tick(), SUMMARY_TICK_MS);
    sync.run(); // 启动时同步一次，之后每 10 分钟一次
    setInterval(() => sync.run(), SYNC_INTERVAL_MS);
    // 截图自动保留策略：启动后跑一次，之后每小时检查一次（跨过零点后会删掉刚过期的那一天）
    const isQueued = (id) => state.currentId === id || queue.some((job) => job.id === id);
    const prune = () => storage.pruneScreenshots(config.dataDir, config.keepScreenshotDays, isQueued).catch(() => {});
    setTimeout(prune, 30000);
    setInterval(prune, 60 * 60 * 1000);
    // 日记不依赖用户打开“日记”页：启动后和之后每 10 分钟检查一次有没有该生成或该补全的
    setTimeout(() => diary.ensure(), 60000);
    setInterval(() => diary.ensure(), SYNC_INTERVAL_MS);
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('window-all-closed', () => {
    /* 留在托盘里继续运行 */
  });
}
