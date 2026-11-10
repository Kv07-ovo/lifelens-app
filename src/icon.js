/**
 * LifeLens 图标：彩色圆底 + 白色镜头圈 + 中心圆点。
 * 直接按像素画出来，托盘/窗口图标和打包用的 icon.ico 共用这一份。
 *
 * format:
 *   'bgra' —— 预乘 alpha 的 BGRA，给 Electron 的 nativeImage.createFromBitmap 用
 *   'rgba' —— 普通 RGBA，给 PNG 用
 */
function renderIcon(size, active = true, format = 'bgra') {
  const buf = Buffer.alloc(size * size * 4);
  const [r, g, b] = active ? [37, 99, 235] : [120, 126, 138];
  const c = (size - 1) / 2;
  const cover = (radius, d) => Math.min(1, Math.max(0, radius - d + 0.5)); // 边缘抗锯齿
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const alpha = cover(size * 0.47, d);
      const white = Math.min(1, cover(size * 0.31, d) - cover(size * 0.22, d) + cover(size * 0.1, d));
      const red = r + (255 - r) * white;
      const green = g + (255 - g) * white;
      const blue = b + (255 - b) * white;
      const i = (y * size + x) * 4;
      if (format === 'rgba') {
        buf[i] = Math.round(red);
        buf[i + 1] = Math.round(green);
        buf[i + 2] = Math.round(blue);
      } else {
        buf[i] = Math.round(blue * alpha);
        buf[i + 1] = Math.round(green * alpha);
        buf[i + 2] = Math.round(red * alpha);
      }
      buf[i + 3] = Math.round(255 * alpha);
    }
  }
  return buf;
}

module.exports = { renderIcon };
