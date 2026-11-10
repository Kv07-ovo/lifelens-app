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

  if (!state.capturing) setChip($('chip-capture'), '截屏：已暂停', '');
  else if (state.locked && config.skipWhenLocked) setChip($('chip-capture'), '截屏：锁屏中，暂不截', 'warn');
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

  $('btn-toggle').textContent = state.capturing ? '暂停截屏' : '开始截屏';

  let notice = '';
  if (state.lastCaptureError) {
    notice = `截屏出错：${state.lastCaptureError}`;
  } else if (config.analysisEnabled && !model.online) {
    notice = `连不上本地模型服务 ${config.baseUrl}。截图会照常保存并标记为“等待分析”，Strata 启动并加载模型后会自动补上总结。`;
  } else if (config.analysisEnabled && model.vision === false) {
    notice = 'Strata 当前没有开启读图（图片读取），模型看不到截图。请在 Strata 里打开读取图片后重新加载模型。';
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
  flash('已保存');
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
    else if (model.vision === false) flash('已连接，但 Strata 没有开启读图');
    else flash(`已连接${model.model ? `：${model.model}` : ''}`);
  } finally {
    $('btn-test').disabled = false;
  }
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
