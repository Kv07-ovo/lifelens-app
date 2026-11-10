/* “问答”标签页。依赖 renderer.js 里的 api / $ / el */

const qaHistory = []; // [{ question, answer }]，只把最近两轮带给模型
let qaBusy = false;
let qaStatus = null; // 正在回答时显示进度的那一行

function qaScroll() {
  $('qa-chat').scrollTop = $('qa-chat').scrollHeight;
}

/** 回答下面的“检索过程”：每一次搜了什么、命中多少，可展开看原文 */
function searchTrail(searches) {
  const details = el('details', 'qa-trail');
  details.append(el('summary', '', searches.length ? `检索过程（搜索了 ${searches.length} 次）` : '检索过程（没有搜索，直接回答）'));
  for (const [i, s] of searches.entries()) {
    const step = el('div', 'qa-step');
    step.append(
      el('p', 'qa-step-head',
        `${i + 1}. ${s.sourceName} · 关键词：${s.keywords.length ? s.keywords.join('、') : '（按时间列出）'} · ${s.from} 到 ${s.to}` +
        `${s.clamped ? '（范围已自动缩小）' : ''} · 共 ${s.scanned} 条，命中 ${s.total} 条`)
    );
    if (s.results.length) {
      const list = el('ul');
      for (const line of s.results) list.append(el('li', '', line));
      step.append(list);
    }
    details.append(step);
  }
  return details;
}

async function askQuestion(question) {
  const text = question.trim();
  if (!text || qaBusy) return;
  qaBusy = true;
  $('qa-send').disabled = true;
  $('qa-intro').hidden = true;
  $('qa-input').value = '';

  $('qa-chat').append(el('div', 'qa-msg user', text));
  const bubble = el('div', 'qa-msg bot');
  qaStatus = el('p', 'placeholder');
  qaStatus.append(el('span', 'spinner'), document.createTextNode('正在分析问题…'));
  bubble.append(qaStatus);
  $('qa-chat').append(bubble);
  qaScroll();

  const result = await api.ask(text, qaHistory.slice(-2));
  qaStatus = null;
  if (result.error) {
    bubble.replaceChildren(el('p', 'qa-error', `没能回答：${result.error}`));
  } else {
    qaHistory.push({ question: text, answer: result.answer });
    bubble.replaceChildren(
      el('p', 'qa-answer', result.answer),
      searchTrail(result.searches),
      el('p', 'muted qa-foot', `${result.model} · 用时 ${(result.ms / 1000).toFixed(1)} 秒`)
    );
  }
  qaBusy = false;
  $('qa-send').disabled = false;
  qaScroll();
  $('qa-input').focus();
}

api.onQaProgress((text) => {
  if (!qaStatus) return;
  qaStatus.replaceChildren(el('span', 'spinner'), document.createTextNode(text));
  qaScroll();
});

$('qa-form').addEventListener('submit', (event) => {
  event.preventDefault();
  askQuestion($('qa-input').value);
});
$('qa-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    askQuestion($('qa-input').value);
  }
});
for (const example of document.querySelectorAll('#qa-examples .tag')) {
  example.addEventListener('click', () => askQuestion(example.textContent));
}
document.addEventListener('view-open', (event) => {
  if (event.detail === 'qa') $('qa-input').focus();
});
