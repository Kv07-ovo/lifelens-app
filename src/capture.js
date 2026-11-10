const { desktopCapturer, screen } = require('electron');

/**
 * 截取所有屏幕（多显示器时每块屏幕一张图），返回数组，按屏幕从左到右、从上到下排序。
 * 每项：{ index, displayId, primary, active, width, height, buffer }
 *   primary = 是否主屏；active = 鼠标是否在这块屏幕上（用户当前在用的屏幕）
 */
async function captureScreens({ maxWidth, jpegQuality }) {
  const primaryId = screen.getPrimaryDisplay().id;
  const activeId = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;

  const displays = screen.getAllDisplays().map((display, sourceIndex) => ({
    display,
    sourceIndex,
    pxWidth: Math.round(display.size.width * display.scaleFactor),
    pxHeight: Math.round(display.size.height * display.scaleFactor),
  }));

  // thumbnailSize 对所有屏幕生效，所以按最大的那块屏幕要原始分辨率，之后再逐块缩小
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.max(...displays.map((d) => d.pxWidth)),
      height: Math.max(...displays.map((d) => d.pxHeight)),
    },
  });
  const noIds = sources.every((s) => !s.display_id);

  displays.sort((a, b) => a.display.bounds.x - b.display.bounds.x || a.display.bounds.y - b.display.bounds.y);

  const shots = [];
  for (const { display, sourceIndex, pxWidth } of displays) {
    let source = sources.find((s) => s.display_id === String(display.id));
    // 个别系统拿不到 display_id，这时屏幕源的顺序与显示器列表一致
    if (!source && noIds && sources.length === displays.length) source = sources[sourceIndex];
    if (!source || source.thumbnail.isEmpty()) continue;

    let image = source.thumbnail;
    const target = maxWidth > 0 ? Math.min(pxWidth, maxWidth) : pxWidth;
    if (image.getSize().width > target) image = image.resize({ width: target, quality: 'best' });

    const size = image.getSize();
    shots.push({
      // 画面指纹：缩到 32 像素宽的位图，用来判断画面和上一次相比有没有变化
      fingerprint: image.resize({ width: 32, quality: 'good' }).toBitmap(),
      index: shots.length + 1,
      displayId: String(display.id),
      primary: display.id === primaryId,
      active: display.id === activeId,
      width: size.width,
      height: size.height,
      buffer: image.toJPEG(jpegQuality),
    });
  }

  if (!shots.length) throw new Error('截屏失败：没有拿到屏幕画面');
  return { shots, displayCount: displays.length };
}

/**
 * 两次截屏的画面是否基本相同。逐块屏幕比较指纹的平均像素差，
 * 允许很小的差异（时钟跳秒、光标闪烁），看视频、滚动页面这类变化会被识别为“变了”。
 */
function sameScreens(previous, current, tolerance = 1.5) {
  if (!previous || previous.length !== current.length) return false;
  for (let i = 0; i < current.length; i++) {
    const a = previous[i];
    const b = current[i];
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let p = 0; p < a.length; p++) diff += Math.abs(a[p] - b[p]);
    if (diff / a.length > tolerance) return false;
  }
  return true;
}

module.exports = { captureScreens, sameScreens };
