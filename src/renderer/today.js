/* “今日”页：今天的概况、接着上次的来、待办收件箱。依赖 renderer.js 的 api / $ / el，activity.js 的 CATEGORY_CLASS / showView */

const minutesText = formatMinutes; // 共用 renderer.js 里的实现

const clockText = (ms) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function categoryChips(byCategory) {
  const row = el('div', 'diary-stats');
  for (const name of ['工作', '学习', '娱乐', '社交']) {
    if (byCategory[name]) row.append(el('span', `chip cat ${CATEGORY_CLASS[name]}`, `${name} ${minutesText(byCategory[name])}`));
  }
  return row;
}

function projectList(projects) {
  const list = el('ol', 'today-projects');
  for (const project of projects) {
    const item = el('li');
    item.append(el('span', '', project.name), el('span', 'muted', minutesText(project.minutes)));
    list.append(item);
  }
  return list;
}

function linkButton(label, onClick) {
  const button = el('button', '', label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function todoItem(todo, closed) {
  const item = el('li', `todo${closed ? ' closed' : ''}`);
  const text = el('div', 'todo-text');
  text.append(el('span', '', todo.text));
  const seen = todo.count > 1 ? `出现过 ${todo.count} 次，最近一次 ${clockText(todo.lastSeen)}` : `出现于 ${clockText(todo.firstSeen)}`;
  text.append(el('span', 'muted', closed ? (todo.status === 'done' ? '已完成' : '已忽略') : seen));
  item.append(text);
  const actions = el('div', 'todo-actions');
  if (closed) {
    actions.append(linkButton('撤销', () => api.setTodo(todo.id, 'open')));
  } else {
    const done = linkButton('完成', () => api.setTodo(todo.id, 'done'));
    done.className = 'primary';
    actions.append(done, linkButton('忽略', () => api.setTodo(todo.id, 'ignored')));
  }
  item.append(actions);
  return item;
}

async function loadToday() {
  const data = await api.today();

  // 今天
  const now = [el('h2', '', '今天')];
  if (data.today) {
    now.push(el('p', 'today-big', minutesText(data.today.minutes)), el('p', 'muted', '实际在用电脑的时间'));
    now.push(categoryChips(data.today.byCategory), projectList(data.today.projects));
  } else {
    now.push(el('p', 'placeholder', '今天还没有汇总。用上 10 分钟之后，这里会显示今天的时间分配。'));
  }
  $('today-now').replaceChildren(...now);

  // 接着上次的来
  const prev = [el('h2', '', '接着上次的来')];
  if (data.previous) {
    const p = data.previous;
    prev.push(el('p', '', `${p.label}记录了 ${minutesText(p.minutes)}，${p.lastAt} 结束时在做的是：`));
    prev.push(el('p', 'today-last', p.lastProject));
    if (p.highlight) prev.push(el('p', 'muted', `高光：${p.highlight}`));
    prev.push(projectList(p.projects));
    const actions = el('div', 'form-actions');
    actions.append(linkButton(p.hasDiary ? `看${p.label}的日记` : `去生成${p.label}的日记`, () => showView('diary')));
    prev.push(actions);
  } else {
    prev.push(el('p', 'placeholder', '还没有之前的记录。明天早上这里会告诉你今天做到了哪里。'));
  }
  $('today-prev').replaceChildren(...prev);

  // 待办收件箱
  const { open, closed } = data.todos;
  $('todo-open').replaceChildren(...open.map((todo) => todoItem(todo, false)));
  $('todo-empty').hidden = open.length > 0;
  $('todo-count').textContent = open.length ? `${open.length} 件待处理` : '';
  $('todo-closed').replaceChildren(...closed.map((todo) => todoItem(todo, true)));
  $('todo-closed-box').hidden = closed.length === 0;

  $('btn-snooze').textContent = data.snoozed ? '恢复今天的提醒' : '今天别再提醒';
  $('btn-snooze').dataset.snoozed = data.snoozed ? '1' : '';
  $('nudge-note').textContent = data.snoozed
    ? '今天不会再弹出提醒，明天自动恢复。'
    : `今天已提醒 ${data.sentToday} 次，每天最多 ${data.maxPerDay} 次。`;
}

$('btn-snooze').addEventListener('click', async () => {
  await api.snoozeNudges(!$('btn-snooze').dataset.snoozed);
  loadToday();
});
$('btn-test-nudge').addEventListener('click', () => api.testNudge());

document.addEventListener('view-open', (event) => {
  if (event.detail === 'today') loadToday();
});

let todayTimer = null;
const refreshTodaySoon = () => {
  if ($('view-today').hidden) return;
  clearTimeout(todayTimer);
  todayTimer = setTimeout(loadToday, 300);
};
api.onTodayChanged(refreshTodaySoon);
api.onSummariesChanged(refreshTodaySoon);
api.onOpenView((name) => showView(name)); // 点击系统通知时，主进程让界面切到对应的页

loadToday(); // “今日”是默认打开的页
