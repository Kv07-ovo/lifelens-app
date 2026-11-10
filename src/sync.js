/**
 * 多设备记忆同步：用一个私有 Git 仓库在几台电脑之间同步文字记忆。
 *
 * 同步的内容：10 分钟汇总、日记（都是很小的 JSON）。
 * 不同步的内容：截图、每 20 秒的原始记录（体积大，只留在各自电脑上）。
 *
 * <dataDir>/sync/ 是仓库的本地副本，里面每台设备一个文件夹：
 *   sync/台式机/2026-11/summaries/2026-11-10.json
 *   sync/笔记本/2026-11/diary/2026-11-10.json
 * 每台设备只写自己的文件夹，所以两边永远不会改同一个文件，合并不会冲突。
 * 其他设备的文件夹由汇总、日记模块只读地合并进来。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

const BRANCH = 'main';
const KINDS = ['summaries', 'diary'];

function git(cwd, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        // 需要登录时直接失败，而不是弹出输入框把应用卡住
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || stdout || err.message).trim().split('\n').slice(-3).join(' ');
          reject(new Error(err.code === 'ENOENT' ? '没有找到 git，请先安装 Git' : detail));
        } else {
          resolve(String(stdout).trim());
        }
      }
    );
  });
}

/** 设备名要当文件夹名用，去掉不能出现在路径里的字符 */
function safeDevice(name) {
  return String(name || '').trim().replace(/[\\/:*?"<>|.\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function createSync({ getConfig, onChange, onImported }) {
  let running = null;
  const status = { state: 'idle', lastAt: null, message: '', devices: [], uploaded: 0, imported: false };

  const syncDir = () => path.join(getConfig().dataDir, 'sync');
  const device = () => safeDevice(getConfig().deviceName);

  /** 其他设备的数据目录（本机副本），给汇总、日记模块合并读取 */
  function extraRoots() {
    const config = getConfig();
    if (!config.syncEnabled) return [];
    let names = [];
    try {
      names = fs.readdirSync(syncDir(), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== '.git').map((d) => d.name);
    } catch {
      return [];
    }
    return names.filter((name) => name !== device()).map((name) => ({ dir: path.join(syncDir(), name), device: name }));
  }

  /** 把本机的汇总和日记复制到 sync/<本机设备名>/ 下，只复制有变化的文件 */
  async function exportLocal() {
    const dataDir = getConfig().dataDir;
    const target = path.join(syncDir(), device());
    let copied = 0;
    const months = (await fsp.readdir(dataDir).catch(() => [])).filter((n) => /^\d{4}-\d{2}$/.test(n));
    for (const month of months) {
      for (const kind of KINDS) {
        const from = path.join(dataDir, month, kind);
        const names = (await fsp.readdir(from).catch(() => [])).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n));
        for (const name of names) {
          const src = path.join(from, name);
          const dst = path.join(target, month, kind, name);
          const [a, b] = await Promise.all([fsp.stat(src), fsp.stat(dst).catch(() => null)]);
          if (b && b.size === a.size && b.mtimeMs >= a.mtimeMs) continue;
          await fsp.mkdir(path.dirname(dst), { recursive: true });
          await fsp.copyFile(src, dst);
          copied += 1;
        }
      }
    }
    return copied;
  }

  async function prepareRepo(dir, repo) {
    let cloned = false;
    if (!fs.existsSync(path.join(dir, '.git'))) {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} 已经存在且不是 Git 仓库，请先移走它`);
      await fsp.mkdir(path.dirname(dir), { recursive: true });
      await git(path.dirname(dir), ['clone', repo, dir], 300000);
      cloned = true;
    } else {
      const current = await git(dir, ['remote', 'get-url', 'origin']).catch(() => '');
      if (current !== repo) await git(dir, ['remote', 'set-url', 'origin', repo]).catch(() => git(dir, ['remote', 'add', 'origin', repo]));
    }
    await git(dir, ['config', 'user.name', device()]);
    await git(dir, ['config', 'user.email', `${device()}@lifelens.local`]);
    await git(dir, ['config', 'core.autocrlf', 'false']);
    return cloned;
  }

  const head = (dir) => git(dir, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '');

  async function sync() {
    const config = getConfig();
    const dir = syncDir();
    if (!config.syncRepo) throw new Error('还没有填写同步仓库地址');
    if (!device()) throw new Error('还没有填写设备名');

    const cloned = await prepareRepo(dir, config.syncRepo); // 刚克隆下来时，里面可能已经有其他设备的数据
    const remoteHasBranch = !!(await git(dir, ['ls-remote', '--heads', 'origin', BRANCH]));
    if (!(await head(dir))) await git(dir, ['checkout', '-B', BRANCH]).catch(() => {});

    // 1. 拉取其他设备的更新
    const before = await head(dir);
    if (remoteHasBranch) await git(dir, ['pull', '--rebase', '--autostash', 'origin', BRANCH], 300000);
    const imported = (await head(dir)) !== before;

    // 2. 导出本机的更新并提交
    const copied = await exportLocal();
    await git(dir, ['add', '-A']);
    const dirty = await git(dir, ['status', '--porcelain']);
    if (dirty) await git(dir, ['commit', '-m', `${device()} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`]);

    // 3. 推送；如果期间另一台设备也推了，就再拉一次后重推
    const ahead = !remoteHasBranch || (await git(dir, ['rev-list', '--count', `origin/${BRANCH}..HEAD`]).catch(() => '1')) !== '0';
    let importedLate = false;
    if (ahead && (await head(dir))) {
      try {
        await git(dir, ['push', '-u', 'origin', `HEAD:${BRANCH}`], 300000);
      } catch {
        const mid = await head(dir);
        await git(dir, ['pull', '--rebase', '--autostash', 'origin', BRANCH], 300000);
        importedLate = (await head(dir)) !== mid;
        await git(dir, ['push', '-u', 'origin', `HEAD:${BRANCH}`], 300000);
      }
    }
    return { copied, imported: cloned || imported || importedLate };
  }

  return {
    extraRoots,
    status: () => ({ ...status }),

    /** 同步一次。同一时间只跑一个，重复调用会等同一次结果 */
    run() {
      const config = getConfig();
      if (!config.syncEnabled) return Promise.resolve(this.status());
      if (running) return running;
      status.state = 'syncing';
      onChange();
      running = sync()
        .then(async (result) => {
          status.state = 'ok';
          status.uploaded = result.copied;
          status.imported = result.imported;
          status.message = '';
          status.devices = [device(), ...extraRoots().map((r) => r.device)];
          if (result.imported) await onImported();
        })
        .catch((err) => {
          status.state = 'error';
          status.message = err.message;
        })
        .then(() => {
          status.lastAt = Date.now();
          running = null;
          onChange();
          return this.status();
        });
      return running;
    },
  };
}

module.exports = { createSync, safeDevice };
