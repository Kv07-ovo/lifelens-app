// 把应用打包成独立的 dist/LifeLens-win32-x64/LifeLens.exe（自带运行时，不需要 Node）
const path = require('path');
const pkg = require('../package.json');

(async () => {
  const mod = await import('@electron/packager');
  const packager = mod.packager || mod.default;
  const root = path.join(__dirname, '..');
  const [out] = await packager({
    dir: root,
    name: 'LifeLens',
    platform: 'win32',
    arch: 'x64',
    out: path.join(root, 'dist'),
    overwrite: true,
    asar: true,
    icon: path.join(root, 'build', 'icon.ico'),
    appVersion: pkg.version,
    ignore: [/^\/(dist|build|scripts|\.claude)($|\/)/],
    win32metadata: {
      CompanyName: 'LifeLens',
      ProductName: 'LifeLens',
      FileDescription: 'LifeLens',
      InternalName: 'LifeLens',
      OriginalFilename: 'LifeLens.exe',
    },
    // 国内镜像；也可以用环境变量 ELECTRON_MIRROR 覆盖
    download: { mirrorOptions: { mirror: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/' } },
  });
  console.log(`packaged: ${out}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
