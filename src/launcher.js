// 启动用户自己的本地模型：运行用户在设置里选的那个启动脚本。
// LifeLens 不管模型怎么加载，只负责“把脚本跑起来，然后等服务上线”。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ALLOWED = ['.ps1', '.cmd', '.bat', '.exe'];

// 按扩展名决定怎么运行。参数都以数组传递，不拼命令行字符串
function commandFor(script) {
  const ext = path.extname(script).toLowerCase();
  if (ext === '.ps1') {
    return { file: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', script] };
  }
  if (ext === '.cmd' || ext === '.bat') {
    // cmd 对带空格和引号的路径有自己的规则：整条命令再包一层引号，并且不让 Node 改写
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', `""${script}""`], verbatim: true };
  }
  return { file: script, args: [] };
}

// 检查脚本能不能用。返回 null 表示可以，否则返回给用户看的原因
function check(script) {
  const target = String(script || '').trim();
  if (!target) return '还没有选择启动脚本';
  if (!path.isAbsolute(target)) return '启动脚本要填完整路径';
  if (!ALLOWED.includes(path.extname(target).toLowerCase())) return `启动脚本只支持 ${ALLOWED.join('、')} 文件`;
  try {
    if (!fs.statSync(target).isFile()) return '启动脚本不是一个文件';
  } catch {
    return '找不到启动脚本，文件可能被移动或删除了';
  }
  return null;
}

// 运行脚本，不等它结束（模型服务会一直开着）。脚本和它启动的服务不随 LifeLens 退出
function launch(script) {
  const problem = check(script);
  if (problem) return Promise.resolve({ ok: false, error: problem });
  const target = String(script).trim();
  const { file, args, verbatim } = commandFor(target);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd: path.dirname(target),
        // 不用 detached：那样脚本没有控制台，PowerShell 脚本里再 Start-Process 出来的服务起不来。
        // Windows 上子进程本来就不会跟着父进程退出
        stdio: 'ignore',
        windowsHide: true,
        windowsVerbatimArguments: !!verbatim,
      });
    } catch (err) {
      resolve({ ok: false, error: `启动脚本运行不了：${err.message}` });
      return;
    }
    child.once('error', (err) => resolve({ ok: false, error: `启动脚本运行不了：${err.message}` }));
    child.once('spawn', () => {
      child.unref();
      resolve({ ok: true, child }); // 调用方可以监听 exit：脚本报错退出时不用干等
    });
  });
}

module.exports = { launch, check, commandFor, ALLOWED };
