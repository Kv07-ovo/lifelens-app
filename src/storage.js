/**
 * 目录结构：
 *   <dataDir>/
 *     2026-11/                          ← 每月一个文件夹
 *       2026-11-10_18.json              ← 每小时一个 JSON 文件
 *       screenshots/2026-11-10/18-24-20.jpg              ← 单屏
 *       screenshots/2026-11-10/18-24-20-screen1.jpg      ← 多屏：每块屏幕一张
 *       screenshots/2026-11-10/18-24-20-screen2.jpg
 */
const fs = require('fs/promises');
const path = require('path');

const MONTH_RE = /^\d{4}-\d{2}$/;
const HOUR_FILE_RE = /^\d{4}-\d{2}-\d{2}_\d{2}\.json$/;

const pad = (n, len = 2) => String(n).padStart(len, '0');

function parts(d) {
  const Y = d.getFullYear();
  const M = pad(d.getMonth() + 1);
  const D = pad(d.getDate());
  const h = pad(d.getHours());
  const m = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  return {
    month: `${Y}-${M}`,
    date: `${Y}-${M}-${D}`,
    hour: h,
    clock: `${h}:${m}:${s}`,
    fileClock: `${h}-${m}-${s}`,
    ms: pad(d.getMilliseconds(), 3),
  };
}

function tzOffset(d) {
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  return `${off >= 0 ? '+' : '-'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** 带时区的本地 ISO 时间，例如 2026-11-10T18:24:20.012+08:00 */
function localIso(d) {
  const p = parts(d);
  return `${p.date}T${p.clock}.${p.ms}${tzOffset(d)}`;
}

function monthDir(dataDir, d) {
  return path.join(dataDir, parts(d).month);
}

function hourFile(dataDir, d) {
  const p = parts(d);
  return path.join(monthDir(dataDir, d), `${p.date}_${p.hour}.json`);
}

// 所有 JSON 读改写串行执行，避免截屏写入和分析结果回写互相覆盖
let chain = Promise.resolve();
function locked(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function readJson(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const data = JSON.parse(text);
    if (data && Array.isArray(data.records)) return data;
  } catch {
    /* 落到下面按损坏处理 */
  }
  // 文件损坏：改名保留，不丢数据，然后重新建一个
  await fs.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
  return null;
}

async function writeJson(file, data) {
  data.updatedAt = localIso(new Date());
  data.count = data.records.length;
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

/** 保存截图，返回图片的绝对路径。suffix 用来区分多块屏幕，例如 "-screen2" */
async function saveScreenshot(dataDir, d, buffer, suffix = '') {
  const p = parts(d);
  const dir = path.join(monthDir(dataDir, d), 'screenshots', p.date);
  await fs.mkdir(dir, { recursive: true });
  let file = path.join(dir, `${p.fileClock}${suffix}.jpg`);
  try {
    await fs.writeFile(file, buffer, { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    file = path.join(dir, `${p.fileClock}-${p.ms}${suffix}.jpg`);
    await fs.writeFile(file, buffer);
  }
  return file;
}

/** 往对应小时的 JSON 文件里追加一条记录，返回该 JSON 文件路径 */
function appendRecord(dataDir, d, record) {
  const file = hourFile(dataDir, d);
  return locked(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const p = parts(d);
    const data = (await readJson(file)) || {
      version: 1,
      date: p.date,
      hour: Number(p.hour),
      timezone: tzOffset(d),
      updatedAt: null,
      count: 0,
      records: [],
    };
    data.records.push(record);
    await writeJson(file, data);
    return file;
  });
}

/** 更新某条记录（写回分析结果），返回更新后的记录；找不到返回 null */
function updateRecord(file, id, patch) {
  return locked(async () => {
    const data = await readJson(file);
    if (!data) return null;
    const record = data.records.find((r) => r.id === id);
    if (!record) return null;
    Object.assign(record, patch);
    await writeJson(file, data);
    return record;
  });
}

/** 所有小时文件，按时间从新到旧 */
async function listHourFiles(dataDir) {
  let months;
  try {
    months = (await fs.readdir(dataDir)).filter((n) => MONTH_RE.test(n));
  } catch {
    return [];
  }
  months.sort().reverse();
  const files = [];
  for (const month of months) {
    const dir = path.join(dataDir, month);
    const names = (await fs.readdir(dir).catch(() => [])).filter((n) => HOUR_FILE_RE.test(n));
    names.sort().reverse();
    for (const name of names) files.push(path.join(dir, name));
  }
  return files;
}

/** 最近的 limit 条记录，从新到旧，每条附带所在的 JSON 文件路径 */
async function listRecent(dataDir, limit) {
  const out = [];
  for (const file of await listHourFiles(dataDir)) {
    const data = await locked(() => readJson(file));
    if (!data) continue;
    for (let i = data.records.length - 1; i >= 0 && out.length < limit; i--) {
      out.push({ ...data.records[i], file });
    }
    if (out.length >= limit) break;
  }
  return out;
}

/** 最近 maxFiles 个小时文件里尚未分析的记录，从旧到新，最多 limit 条（取最新的那些） */
async function listPending(dataDir, limit, maxFiles = 48) {
  const out = [];
  const files = (await listHourFiles(dataDir)).slice(0, maxFiles);
  for (const file of files) {
    const data = await locked(() => readJson(file));
    if (!data) continue;
    for (let i = data.records.length - 1; i >= 0 && out.length < limit; i--) {
      const r = data.records[i];
      if (r.status === 'pending' && Array.isArray(r.screens) && r.screens.length) {
        out.push({ file, id: r.id, images: r.screens.map((s) => ({ path: s.imagePath, active: !!s.active })) });
      }
    }
    if (out.length >= limit) break;
  }
  return out.reverse();
}

/** 截图占用的磁盘空间：date（YYYY-MM-DD）那一天的，以及全部的 */
async function screenshotUsage(dataDir, date) {
  const usage = { dayBytes: 0, dayFiles: 0, totalBytes: 0, totalFiles: 0 };
  const months = (await fs.readdir(dataDir).catch(() => [])).filter((n) => MONTH_RE.test(n));
  for (const month of months) {
    const root = path.join(dataDir, month, 'screenshots');
    for (const day of await fs.readdir(root).catch(() => [])) {
      for (const name of await fs.readdir(path.join(root, day)).catch(() => [])) {
        const stat = await fs.stat(path.join(root, day, name)).catch(() => null);
        if (!stat || !stat.isFile()) continue;
        usage.totalBytes += stat.size;
        usage.totalFiles += 1;
        if (day === date) {
          usage.dayBytes += stat.size;
          usage.dayFiles += 1;
        }
      }
    }
  }
  return usage;
}

/**
 * 删除截图文件，只删图片，记录里的文字（时间、活动总结）全部保留。
 * date 为 YYYY-MM-DD 时只删那一天的，为 null 时删全部。
 * 还在等待分析的截图不删（删了就没法分析了），返回里会报告保留了多少张。
 */
async function deleteScreenshots(dataDir, date) {
  const root = path.resolve(dataDir) + path.sep;
  const result = { deletedFiles: 0, freedBytes: 0, keptPending: 0 };
  const files = (await listHourFiles(dataDir)).filter((file) => !date || path.basename(file).startsWith(`${date}_`));
  for (const file of files) {
    await locked(async () => {
      const data = await readJson(file);
      if (!data) return;
      let changed = false;
      for (const record of data.records) {
        const images = record.imagePaths || [];
        if (record.imagesDeleted || !images.length) continue;
        if (record.status === 'pending') {
          result.keptPending += images.length;
          continue;
        }
        for (const image of images) {
          const target = path.resolve(image);
          if (!target.startsWith(root)) continue; // 只动数据目录里的文件
          const stat = await fs.stat(target).catch(() => null);
          if (!stat) continue;
          await fs.unlink(target).then(() => {
            result.deletedFiles += 1;
            result.freedBytes += stat.size;
          }, () => {});
        }
        record.imagesDeleted = true;
        record.imagesDeletedAt = localIso(new Date());
        changed = true;
      }
      if (changed) await writeJson(file, data);
    });
  }
  // 顺手删掉已经空了的日期文件夹
  for (const month of (await fs.readdir(dataDir).catch(() => [])).filter((n) => MONTH_RE.test(n))) {
    const shots = path.join(dataDir, month, 'screenshots');
    for (const day of await fs.readdir(shots).catch(() => [])) await fs.rmdir(path.join(shots, day)).catch(() => {});
  }
  return result;
}

/** 读一个小时文件（与写入串行，不会读到写了一半的内容） */
function readHourFile(file) {
  return locked(() => readJson(file));
}

/** 从 2026-11-10_18.json 这样的文件名得到该小时的起始时间（毫秒） */
function hourFileStart(file) {
  const m = /(\d{4})-(\d{2})-(\d{2})_(\d{2})\.json$/.exec(file);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4]).getTime() : NaN;
}

module.exports = {
  parts,
  localIso,
  hourFile,
  readHourFile,
  hourFileStart,
  screenshotUsage,
  deleteScreenshots,
  listHourFiles,
  saveScreenshot,
  appendRecord,
  updateRecord,
  listRecent,
  listPending,
};
