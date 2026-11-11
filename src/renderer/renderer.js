const api = window.lifelens;
const MAX_RECORDS = 40;

const $ = (id) => document.getElementById(id);
const form = $('form');
const records = new Map(); // id -> record
let formLoaded = false;
let cleanNote = null; // { text, until }：清理截图后的结果提示

const STATUS_LABEL = {
  pending: ['等待分析', 'warn'],
  done: ['已分析', 'ok'],
  error: ['分析失败', 'bad'],
  skipped: ['未分析', ''],
};

/** 分钟数 -> “45 分钟” / “2 小时” / “2 小时 5 分”。各个页面都用这一个，保证同一个时长到处写法一样 */
function formatMinutes(minutes) {
  const m = Math.round(minutes || 0);
  if (m < 60) return `${m} 分钟`;
  return m % 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m / 60} 小时`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setChip(node, text, tone) {
  node.textContent = text;
  node.className = `chip ${tone || ''}`.trim();
}

/* ---------- 状态 ---------- */

function renderState(state) {
  const { config, model } = state;

  const pausedNow = state.pausedUntil && Date.now() < state.pausedUntil;
  if (!state.capturing) setChip($('chip-capture'), '截屏：已停止', '');
  else if (pausedNow) {
    const until = new Date(state.pausedUntil);
    setChip($('chip-capture'), `截屏：暂停到 ${String(until.getHours()).padStart(2, '0')}:${String(until.getMinutes()).padStart(2, '0')}`, 'warn');
  }
  else if (state.locked && config.skipWhenLocked) setChip($('chip-capture'), '截屏：锁屏中，暂不截', 'warn');
  else if (state.idle) setChip($('chip-capture'), '截屏：无操作且画面未变，暂不记录', 'warn');
  else setChip($('chip-capture'), `截屏：每 ${config.intervalSec} 秒一次`, 'ok');

  if (!config.analysisEnabled) setChip($('chip-model'), '模型：已关闭分析', '');
  else if (model.online) setChip($('chip-model'), `模型：在线${model.model ? `（${model.model}）` : ''}`, 'ok');
  else setChip($('chip-model'), '模型：未连接', 'bad');

  setChip(
    $('chip-queue'),
    `待分析：${state.queueLength}${state.currentId ? '（分析中）' : ''}`,
    state.queueLength > 20 ? 'warn' : ''
  );

  // 10 分钟汇总的进度：有时间段在排队或正在汇总时显示“汇总中”
  const summary = state.summary || { queued: 0, waiting: 0, runningId: null };
  const busy = summary.queued + summary.waiting;
  let busyText = '';
  if (summary.runningId) busyText = `汇总中${summary.queued > 1 ? `，还有 ${summary.queued - 1} 段排队` : ''}`;
  else if (summary.queued) busyText = `${summary.queued} 段待汇总${model.online ? '' : '（等模型上线）'}`;
  else if (summary.waiting) busyText = `${summary.waiting} 段等截图分析完再汇总`;
  $('chip-summary').hidden = !busy;
  $('chip-summary-text').textContent = busyText;
  $('heat-busy').hidden = !busy;
  $('heat-busy-text').textContent = busyText;

  // 全局快捷键被别的程序占用时注册不上，在暂停菜单的提示里说明
  $('pause-for').title = state.shortcutOk === false
    ? '暂停期间不截屏，到点自动恢复。快捷键 Ctrl+Alt+P 被其他程序占用，暂时不可用'
    : '暂停期间不截屏，到点自动恢复。快捷键 Ctrl+Alt+P 可随时停止或恢复';

  // 多设备同步的状态
  const sync = state.sync || { state: 'idle' };
  let syncText = '只同步 10 分钟汇总和日记，截图和 20 秒记录留在本机。';
  if (!config.syncEnabled) syncText = `未开启。${syncText}`;
  else if (sync.state === 'syncing') syncText = '正在同步…';
  else if (sync.state === 'error') syncText = `同步失败：${sync.message}`;
  else if (sync.state === 'ok') {
    const at = new Date(sync.lastAt);
    syncText = `上次同步 ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}，已有设备：${sync.devices.join('、')}。每 10 分钟自动同步一次。`;
  }
  $('sync-status').textContent = syncText;
  $('btn-sync').disabled = !config.syncEnabled || sync.state === 'syncing';

  const recording = state.capturing && !pausedNow;
  $('btn-toggle').textContent = recording ? '停止记录' : '恢复记录';
  $('btn-toggle').classList.toggle('attention', !recording); // 没在记录时用提示色标出来；它不是页面的主操作

  // 顶部那一个合并的状态指示：一句话说清“在不在记录、模型在不在”，细节点开再看
  const modelOff = config.analysisEnabled && !model.online;
  let captureWord = '记录中';
  let tone = 'ok';
  if (!state.capturing) { captureWord = '已停止'; tone = 'off'; }
  else if (pausedNow) { captureWord = '已暂停'; tone = 'warn'; }
  else if ((state.locked && config.skipWhenLocked) || state.idle) { captureWord = '待机中'; tone = 'warn'; }
  let statusText = captureWord;
  const launch = state.modelLaunch || { status: 'idle' };
  const launching = modelOff && launch.status === 'starting';
  // 服务已经连上，但模型还没加载完（刚启动的一两分钟）
  const modelLoading = config.analysisEnabled && model.online && model.loaded === false;
  if (launching) { statusText += ' · 模型启动中'; tone = 'warn'; }
  else if (modelOff) { statusText += ' · 模型离线'; tone = 'bad'; }
  else if (modelLoading) { statusText += ' · 模型加载中'; tone = 'warn'; }
  else if (busy) statusText += ' · 汇总中';
  else if (state.queueLength > 20) statusText += ` · ${state.queueLength} 张待分析`;
  $('status-text').textContent = statusText;
  $('status-pill').className = `tone-${tone}`;

  // 模型离线不是需要立刻处理的错误，不再占一整行横幅，只在状态详情里说明
  $('status-hint').hidden = !modelOff && !modelLoading;
  let hint = '';
  if (launching) hint = '已经运行启动脚本，正在等模型加载。大模型可能要一两分钟，截图照常保存。';
  else if (modelOff && launch.status === 'failed') hint = `模型没能启动：${launch.error}。截图照常保存，模型上线后会自动补上分析和汇总。`;
  else if (modelOff) hint = `连不上 ${config.baseUrl}。截图照常保存，模型上线后会自动补上分析和汇总。`;
  else if (modelLoading) hint = '模型服务已经连上，模型还在加载。加载完会自动开始分析，截图照常保存。';
  $('status-hint').textContent = hint;
  $('btn-start-model').disabled = launch.status === 'starting';

  let notice = '';
  if (state.lastCaptureError) {
    notice = `截屏出错：${state.lastCaptureError}`;
  } else if (config.analysisEnabled && model.online && model.vision === false) {
    notice = '当前加载的模型没有开启读图，看不到截图。请加载带视觉能力的模型，或在模型服务里打开图片读取。';
  }
  // 清理截图的结果提示保留一会儿
  if (!notice && cleanNote && Date.now() < cleanNote.until) notice = cleanNote.text;
  $('notice').textContent = notice;
  $('notice').hidden = !notice;

  $('summary').textContent = `本次运行已截屏 ${state.captureCount} 次，已分析 ${state.analyzedCount} 次`;

  if (!formLoaded) {
    fillForm(config);
    formLoaded = true;
  }
}

/* ---------- 记录列表 ---------- */

function renderRecord(record) {
  const item = el('li', 'record');
  item.dataset.id = record.id;

  // 每块屏幕一张缩略图
  const screens = record.screens || [];
  const thumbs = el('div', 'thumbs');
  for (const screen of screens) {
    const name = screens.length > 1 ? `屏幕 ${screen.index}` : '屏幕';
    if (record.imagesDeleted) {
      // 截图已经清理掉了：只留一个占位，文字总结还在
      const gone = el('div', 'thumb gone', '截图已清理');
      gone.style.aspectRatio = `${screen.width} / ${screen.height}`;
      thumbs.append(gone);
      continue;
    }
    const thumb = el('button', 'thumb');
    thumb.type = 'button';
    thumb.title = `${name}${screen.active ? '（鼠标所在）' : ''}，点击查看原图`;
    thumb.style.aspectRatio = `${screen.width} / ${screen.height}`;
    const img = document.createElement('img');
    img.alt = `${record.time} ${name}的截图`;
    img.src = screen.imageUrl;
    thumb.append(img);
    if (screens.length > 1) thumb.append(el('span', 'tag', `${name}${screen.active ? ' · 当前' : ''}`));
    thumb.addEventListener('click', () => api.openPath(screen.imagePath));
    thumbs.append(thumb);
  }

  const body = el('div', 'body');
  const meta = el('div', 'meta');
  const time = el('time', '', record.time);
  time.dateTime = record.timestamp;
  const [label, tone] = STATUS_LABEL[record.status] || [record.status, ''];
  meta.append(time, el('span', `chip ${tone}`.trim(), label));
  if (record.analysisMs) meta.append(el('span', 'muted', `用时 ${(record.analysisMs / 1000).toFixed(1)} 秒`));
  body.append(meta);

  if (record.sentences && record.sentences.length) {
    const list = el('ol', 'sentences');
    for (const sentence of record.sentences) list.append(el('li', '', sentence));
    body.append(list);
  } else if (record.status === 'pending') {
    body.append(el('p', 'placeholder', '等待本地模型分析…'));
  } else if (record.error) {
    body.append(el('p', 'placeholder', record.error));
  }
  if (!record.imagesDeleted) for (const screen of screens) body.append(el('p', 'path', screen.imagePath));

  item.append(thumbs, body);
  return item;
}

function renderRecords() {
  const sorted = [...records.values()].sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, MAX_RECORDS);
  for (const id of [...records.keys()]) {
    if (!sorted.some((r) => r.id === id)) records.delete(id);
  }
  $('records').replaceChildren(...sorted.map(renderRecord));
  $('empty').hidden = sorted.length > 0;
}

function upsertRecord(record) {
  records.set(record.id, record);
  const existing = $('records').querySelector(`[data-id="${record.id}"]`);
  if (existing) existing.replaceWith(renderRecord(record));
  else renderRecords();
}

/* ---------- 设置表单 ---------- */

function fillForm(config) {
  for (const field of form.elements) {
    if (!field.name || !(field.name in config)) continue;
    if (field.type === 'checkbox') field.checked = !!config[field.name];
    else field.value = config[field.name];
  }
}

function readForm() {
  const out = {};
  for (const field of form.elements) {
    if (!field.name) continue;
    if (field.type === 'checkbox') out[field.name] = field.checked;
    else if (field.type === 'number') out[field.name] = Number(field.value);
    else out[field.name] = field.value;
  }
  return out;
}

function flash(text) {
  $('form-msg').textContent = text;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => { $('form-msg').textContent = ''; }, 5000);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const state = await api.saveConfig(readForm());
  fillForm(state.config);
  renderState(state);
  $('save-msg').textContent = '已保存';
  setTimeout(() => { $('save-msg').textContent = ''; }, 4000);
  loadRecords();
});

$('btn-test').addEventListener('click', async () => {
  $('btn-test').disabled = true;
  flash('正在连接…');
  try {
    const state = await api.saveConfig(readForm());
    renderState(state);
    const { model } = state;
    if (!model.online) flash(`连接失败：${model.error || '未知错误'}`);
    else if (model.loaded === false) flash('已连接，模型还在加载');
    else if (model.vision === false) flash('已连接，但 Strata 没有开启读图');
    else flash(`已连接${model.model ? `：${model.model}` : ''}`);
  } finally {
    $('btn-test').disabled = false;
  }
});

// 启动模型：先保存表单（脚本路径可能刚改过），再运行脚本。结果在右上角的状态里持续显示
$('btn-start-model').addEventListener('click', async () => {
  renderState(await api.saveConfig(readForm()));
  const state = await api.startModel();
  renderState(state);
  const { model, modelLaunch } = state;
  if (model.online) flash(`模型已经在线${model.model ? `：${model.model}` : ''}`);
  else if (modelLaunch.status === 'failed') flash(`没能启动：${modelLaunch.error}`);
  else flash('已经运行启动脚本，正在等模型加载…');
});

$('btn-choose-script').addEventListener('click', async () => {
  const file = await api.chooseModelScript();
  if (file) form.elements.modelStartScript.value = file;
});

$('btn-sync').addEventListener('click', async () => renderState(await api.syncNow()));

$('btn-choose').addEventListener('click', async () => {
  const dir = await api.chooseFolder();
  if (dir) form.elements.dataDir.value = dir;
});

/* ---------- 顶栏按钮 ---------- */

$('btn-toggle').addEventListener('click', async () => renderState(await api.toggleCapture()));
$('btn-folder').addEventListener('click', () => api.openFolder());
$('btn-now').addEventListener('click', async () => {
  $('btn-now').disabled = true;
  try {
    renderState(await api.captureNow());
  } finally {
    $('btn-now').disabled = false;
  }
});

/* ---------- 清理截图 ---------- */

function sizeText(bytes) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

// 按钮上直接显示今天截图占了多少空间
async function refreshUsage() {
  const usage = await api.screenshotUsage();
  $('btn-clean').textContent = usage.totalFiles ? `清理截图（今天 ${sizeText(usage.dayBytes)}）` : '清理截图';
  $('btn-clean').title = `今天 ${usage.dayFiles} 张，${sizeText(usage.dayBytes)}；全部 ${usage.totalFiles} 张，${sizeText(usage.totalBytes)}。只删图片，保留文字记录。`;
  $('btn-clean').disabled = !usage.totalFiles;
}

$('btn-clean').addEventListener('click', async () => {
  $('btn-clean').disabled = true;
  const result = await api.cleanScreenshots();
  if (!result.cancelled) {
    let text = `已删除 ${result.deletedFiles} 张截图，腾出 ${sizeText(result.freedBytes)}。`;
    if (result.keptPending) text += `另有 ${result.keptPending} 张还没分析完，先保留了。`;
    cleanNote = { text, until: Date.now() + 30000 };
    $('notice').textContent = text;
    $('notice').hidden = false;
    loadRecords();
  }
  refreshUsage();
});
// 状态详情：点别处就收起
document.addEventListener('click', (event) => {
  if (!$('status').contains(event.target)) $('status').open = false;
});

/* ---------- 暂停一会儿、删除一段记录 ---------- */

function showNote(text) {
  cleanNote = { text, until: Date.now() + 30000 };
  $('notice').textContent = text;
  $('notice').hidden = false;
}

$('pause-for').addEventListener('change', async () => {
  const minutes = Number($('pause-for').value);
  $('pause-for').value = '';
  if (minutes) renderState(await api.pauseFor(minutes));
});

// 删除一段时间的全部记录。主进程会弹确认框，这里只负责发起和显示结果。别的页面（动态）也会调用它
async function deleteRecords(from, to) {
  const result = await api.deleteRange(from, to);
  if (result.error) {
    showNote(`删除没有完成：${result.error}。这段记录可能只删掉了一部分，请再删一次。`);
    return false;
  }
  if (result.empty) showNote('这段时间没有可删除的记录。');
  if (result.cancelled) return false;
  showNote(
    `已删除 ${result.records} 条截屏记录、${result.images} 张截图、${result.slots} 段汇总` +
    `${result.diaries ? `，以及 ${result.diaries} 篇日记（会按剩下的记录重新生成）` : ''}。` +
    `${result.synced ? '删除正在同步到远程仓库。' : ''}`
  );
  loadRecords();
  refreshUsage();
  return true;
}

$('delete-recent').addEventListener('change', async () => {
  const minutes = Number($('delete-recent').value);
  $('delete-recent').value = '';
  if (minutes) await deleteRecords(Date.now() - minutes * 60000, Date.now());
});

$('btn-retry').addEventListener('click', async () => {
  $('btn-retry').disabled = true;
  const result = await api.retryFailed();
  const text = result.records || result.slots
    ? `已重新排队：${result.records} 张分析失败的截图，${result.slots} 个汇总失败或被跳过的时间段。截图已被清理的记录无法重试。`
    : '没有可以重试的失败项（截图已被清理的记录无法重试）。';
  cleanNote = { text, until: Date.now() + 30000 };
  $('notice').textContent = text;
  $('notice').hidden = false;
  $('btn-retry').disabled = false;
  loadRecords();
});

setInterval(refreshUsage, 60000);
refreshUsage();

/* ---------- 启动 ---------- */

async function loadRecords() {
  const list = await api.recentRecords(MAX_RECORDS);
  records.clear();
  for (const record of list) records.set(record.id, record);
  renderRecords();
}

api.onState(renderState);
api.onRecord(upsertRecord);
api.getState().then(renderState);
loadRecords();
