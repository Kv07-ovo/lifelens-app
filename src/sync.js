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

/** 仓库是不是停在一次没完成的 rebase 中途 */
const midRebase = (dir) => fs.existsSync(path.join(dir, '.git', 'rebase-merge')) || fs.existsSync(path.join(dir, '.git', 'rebase-apply'));
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

/**
 * 这个仓库是不是任何人都能读的公开仓库？
 * 做法：关掉所有登录凭据，匿名去读一次。读得到 = 公开；读不到 = 私有（或不存在）。
 * 只对 http(s) 地址做判断；SSH 地址、本地路径没法匿名访问，返回 false 照常放行。
 * 网络不通时也读不到，同样返回 false，由后面真正的同步去报网络错误。
 */
function isPublicRepo(repo) {
  if (!/^https?:\/\//i.test(repo)) return Promise.resolve(false);
  // 地址里可能自带账号或令牌（https://用户:令牌@主机/...），要去掉才算真正的匿名访问，
  // 否则私有仓库会因为令牌生效而被误判成公开
  let anonymous;
  try {
    const url = new URL(repo);
    url.username = '';
    url.password = '';
    anonymous = url.href;
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'credential.helper=', '-c', 'http.extraHeader=', 'ls-remote', '--heads', anonymous],
      {
        timeout: 30000,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' },
      },
      (err) => resolve(!err)
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
    // 用户删掉的文件（见 forget）：从同步文件夹里也删掉，这样远程仓库和其他设备上也会消失。
    // 只删明确登记过的，不做“本地没有就删”的镜像：否则重装系统后本地是空的，会把仓库里自己的历史全删光。
    const forgotten = await readForgotten();
    for (const rel of forgotten) {
      // 登记之后这个文件又在本机重新生成了（比如日记按剩下的记录重写了）：上面已经复制了新版本，不能再删
      if (fs.existsSync(path.join(dataDir, rel))) continue;
      await fsp.unlink(path.join(target, rel)).then(() => { copied += 1; }, () => {});
    }
    if (forgotten.length) await fsp.unlink(forgetFile()).catch(() => {});
    return copied;
  }

  const forgetFile = () => path.join(getConfig().dataDir, 'sync-forget.json');
  const readForgotten = () => fsp.readFile(forgetFile(), 'utf8').then(JSON.parse).then((list) => (Array.isArray(list) ? list : []), () => []);

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
    // 上次同步如果卡在合并中途（旧版本可能留下这种状态），先撤销它
    if (midRebase(dir)) {
      await git(dir, ['rebase', '--abort']).catch(() => {});
    }
    return cloned;
  }

  const head = (dir) => git(dir, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '');

  /** 拉取。万一冲突（通常是两台电脑用了同一个名字），撤销这次合并，让仓库回到可用状态，而不是卡在半途 */
  async function pull(dir) {
    try {
      await git(dir, ['pull', '--rebase', '--autostash', 'origin', BRANCH], 300000);
    } catch (err) {
      const stuck = midRebase(dir);
      if (!stuck) throw err;
      await git(dir, ['rebase', '--abort']).catch(() => {});
      throw new Error('和另一台设备的文件冲突，已撤销这次合并。请确认每台电脑填的名字都不一样。');
    }
  }

  async function sync() {
    const config = getConfig();
    const dir = syncDir();
    if (!config.syncRepo) throw new Error('还没有填写同步仓库地址');
    if (!device()) throw new Error('还没有填写设备名');
    // 每次同步前都查：防止把记忆推到公开仓库（GitHub 网页上新建仓库默认就是公开的），也防止仓库后来被改成公开
    if (await isPublicRepo(config.syncRepo)) {
      throw new Error('这个仓库是公开的，任何人都能看到里面的内容。为了保护你的记录，已停止同步。请先把仓库改成私有（Private）。');
    }

    const cloned = await prepareRepo(dir, config.syncRepo); // 刚克隆下来时，里面可能已经有其他设备的数据
    const remoteHasBranch = !!(await git(dir, ['ls-remote', '--heads', 'origin', BRANCH]));
    if (!(await head(dir))) await git(dir, ['checkout', '-B', BRANCH]).catch(() => {});

    // 1. 拉取其他设备的更新
    const before = await head(dir);
    if (remoteHasBranch) await pull(dir);
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
        await pull(dir);
        importedLate = (await head(dir)) !== mid;
        await git(dir, ['push', '-u', 'origin', `HEAD:${BRANCH}`], 300000);
      }
    }
    return { copied, imported: cloned || imported || importedLate };
  }

  return {
    extraRoots,
    status: () => ({ ...status }),

    /**
     * 登记本机已经删掉的文件（相对数据目录的路径，如 2026-11/diary/2026-11-10.json），
     * 下次同步时从仓库里一并删除。登记写在磁盘上，应用中途退出也不会丢。
     */
    async forget(absoluteFiles) {
      if (!getConfig().syncEnabled || !absoluteFiles.length) return;
      const dataDir = getConfig().dataDir;
      const list = await readForgotten();
      for (const file of absoluteFiles) {
        const rel = path.relative(dataDir, file);
        if (!rel.startsWith('..') && !list.includes(rel)) list.push(rel);
      }
      await fsp.writeFile(forgetFile(), JSON.stringify(list), 'utf8');
    },

    /** 同步一次。同一时间只跑一个，重复调用会等同一次结果 */
    run(fresh = false) {
      const config = getConfig();
      if (!config.syncEnabled) return Promise.resolve(this.status());
      // fresh：调用方刚改了数据（比如删除了一段记录），正在进行的那次同步可能已经导出过了，等它结束后必须再跑一次
      if (running) return fresh ? running.then(() => this.run()) : running;
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

module.exports = { createSync, safeDevice, isPublicRepo };
