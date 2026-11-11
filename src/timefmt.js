/** 主进程里和“时间的文字表示”有关的小工具，日记和主动提醒共用，保证各处写法一致 */

/** 分钟数 -> “45 分钟” / “2 小时” / “2 小时 5 分” */
function duration(minutes) {
  const m = Math.round(minutes);
  if (m < 60) return `${m} 分钟`;
  return m % 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m / 60} 小时`;
}

/** 'YYYY-MM-DD' -> 这一天的 [开始, 结束) 毫秒时间 */
function dayRange(date) {
  const [y, m, d] = date.split('-').map(Number);
  return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()];
}

module.exports = { duration, dayRange };
