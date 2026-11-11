// 右下角提醒卡片：显示标题和正文；点卡片打开“今日”页，点 × 只是关掉
const params = new URLSearchParams(location.search);
document.getElementById('title').textContent = params.get('title') || 'LifeLens';
document.getElementById('body').textContent = params.get('body') || '';

document.getElementById('close').addEventListener('click', (event) => {
  event.stopPropagation();
  window.lifelens.toastDone(false);
});
document.getElementById('toast').addEventListener('click', () => window.lifelens.toastDone(true));
