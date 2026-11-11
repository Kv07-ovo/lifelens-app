/**
 * 主动提醒：在三个时刻主动开口，而不是等用户自己来翻记录。
 *
 *   早上  今天第一次开始用电脑时：昨天主要在做什么、停在哪、还有几件待办
 *   白天  某件待办挂了一阵子或被反复检测到：提醒一次
 *   晚上  到了设定的收工时间：今天的小结，顺便开始写今天的日记
 *
 * “该不该提醒”全部用规则判断，不调用模型。为了不变成骚扰：
 *   每天有总量上限；每类可以单独关；可以“今天别再提醒”；每件待办只提醒一次；待办提醒之间至少隔一小时。
 *
 * “一天”按凌晨 5 点分界：凌晨 1 点还在用电脑算前一天的晚上，不会被当成新一天的早晨。
 * 状态存在 <dataDir>/nudge-state.json，重启应用不会重复提醒。
 */
const fs = require('fs/promises');
const path = require('path');
const storage = require('./storage');
const { duration, dayRange } = require('./timefmt');
const { CATEGORIES } = require('./summarizer');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DAY_STARTS_AT_HOUR = 5;
const MAX_PER_DAY = 6;
const TODO_GAP_MS = HOUR_MS;

const dateOf = (ms) => storage.parts(new Date(ms)).date;
const logicalDate = (now) => dateOf(now - DAY_STARTS_AT_HOUR * HOUR_MS);

function createNudges({ getConfig, summarizer, diary, todos, notify, getIdleSeconds, isRecording }) {
  let state = { date: '', morning: false, evening: false, sent: 0, snoozed: false, lastTodoAt: 0 };

  const file = () => path.join(getConfig().dataDir, 'nudge-state.json');
  const save = () => fs.writeFile(file(), JSON.stringify(state), 'utf8').catch(() => {});

  /** 某一天的概况：记录时长、各类时长、花时间最多的项目、最后在做的事 */
  function daySummary(date) {
    const infos = summarizer.lightRange(...dayRange(date));
    if (!infos.length) return null;
    const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
    const projects = new Map();
    let minutes = 0;
    for (const info of infos) {
      minutes += info.minutes;
      if (info.category in byCategory) byCategory[info.category] += info.minutes;
      projects.set(info.project, (projects.get(info.project) || 0) + info.minutes);
    }
    const top = [...projects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, m]) => ({ name, minutes: Math.round(m) }));
    const last = infos[infos.length - 1];
    for (const name of CATEGORIES) byCategory[name] = Math.round(byCategory[name]);
    return {
      date,
      minutes: Math.round(minutes),
      byCategory,
      projects: top,
      lastProject: last.project,
      lastAt: storage.parts(new Date(last.end)).clock.slice(0, 5),
    };
  }

  /** 今天之前、最近一个有记录的日子 */
  function previousDay(today) {
    const dates = [...summarizer.doneDates().keys()].filter((d) => d < today).sort();
    return dates.length ? daySummary(dates[dates.length - 1]) : null;
  }

  const dayLabel = (date, today) => {
    const [, m, d] = date.split('-').map(Number);
    return dateOf(dayRange(today)[0] - DAY_MS) === date ? '昨天' : `${m}月${d}日`;
  };

  /** 进入新的一天时把“今天发过什么”清零。返回今天的日期 */
  function startDay(now) {
    const day = logicalDate(now);
    if (state.date !== day) {
      state = { date: day, morning: false, evening: false, sent: 0, snoozed: false, lastTodoAt: state.lastTodoAt };
      save();
    }
    return day;
  }

  function send(kind, title, body) {
    state.sent += 1;
    save();
    notify({ kind, title, body });
  }

  return {
    async load() {
      const saved = await fs.readFile(file(), 'utf8').then(JSON.parse).catch(() => null);
      if (saved && typeof saved === 'object') state = { ...state, ...saved };
    },

    /** 每分钟调用一次 */
    tick(now = Date.now()) {
      const config = getConfig();
      const day = startDay(now);
      const idle = getIdleSeconds();
      const present = isRecording() && idle < 120; // 人在电脑前才提醒，否则发了也没人看
      if (!present) return;
      const quiet = state.snoozed || state.sent >= MAX_PER_DAY;
      const hour = new Date(now).getHours();

      // 早上：只在 5 点到 14 点之间算“早上”，下午才开机就不提了
      if (!state.morning && hour >= DAY_STARTS_AT_HOUR && hour < 14) {
        state.morning = true;
        save();
        const previous = previousDay(day);
        if (config.nudgeMorning && !quiet && previous) {
          const open = todos.openCount();
          const top = previous.projects[0];
          send(
            'morning',
            '接着上次的来',
            `${dayLabel(previous.date, day)}主要在${top.name}（${duration(top.minutes)}），最后在做的是${previous.lastProject}。` +
              `${open ? `还有 ${open} 件待办没处理。` : ''}`
          );
        }
        return;
      }

      // 晚上：到了设定的收工时间，今天有记录才提
      const [eh, em] = config.eveningTime.split(':').map(Number);
      // 一天从凌晨 5 点算起，所以设成 00:00–04:59 的时间指的是“第二天凌晨”，要加一天
      const eveningAt = dayRange(day)[0] + eh * HOUR_MS + em * 60000 + (eh < DAY_STARTS_AT_HOUR ? DAY_MS : 0);
      if (!state.evening && now >= eveningAt) {
        state.evening = true;
        save();
        const today = daySummary(day) || daySummary(dateOf(now)); // 过了零点才触发时，“今天”指的还是刚过去的那一天
        if (config.nudgeEvening && !quiet && today) {
          diary.request(today.date); // 顺便开始写今天的日记；明天如果又多了记录，会自动补全
          send(
            'evening',
            '今天的小结',
            `今天记录了${duration(today.minutes)}，主要在${today.projects[0].name}。日记正在生成，点开查看，也可以顺手清理今天的截图。`
          );
        }
        return;
      }

      // 白天：待办
      if (config.nudgeTodos && !quiet && now - state.lastTodoAt >= TODO_GAP_MS) {
        const due = todos.dueForReminder(now);
        if (due) {
          todos.markNotified(due.id);
          state.lastTodoAt = now;
          send('todo', '可能漏了一件事', `${due.text}${due.count > 1 ? `（在 ${due.count} 个时间段里都出现过）` : ''}`);
        }
      }
    },

    /** 今天别再提醒 / 恢复提醒 */
    snooze(on, now = Date.now()) {
      startDay(now);
      state.snoozed = !!on;
      save();
    },

    /** “今日”页的数据 */
    overview(now = Date.now()) {
      const today = dateOf(now);
      const previous = previousDay(today);
      const brief = previous ? diary.brief(previous.date) : null;
      return {
        date: today,
        today: daySummary(today),
        previous: previous ? { ...previous, label: dayLabel(previous.date, today), highlight: brief ? brief.highlight : '', hasDiary: !!brief } : null,
        todos: todos.list(),
        snoozed: state.snoozed && state.date === logicalDate(now),
        sentToday: state.date === logicalDate(now) ? state.sent : 0,
        maxPerDay: MAX_PER_DAY,
      };
    },
  };
}

module.exports = { createNudges, logicalDate, duration };
