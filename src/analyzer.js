/**
 * 调用本地模型（Strata 的 OpenAI 兼容接口）分析截图。
 * Strata 默认地址 http://127.0.0.1:8080/v1，图片用 image_url（base64 data URL）传入。
 */
const fs = require('fs/promises');

/** 服务没启动 / 模型还没加载好：这类错误不算分析失败，稍后重试 */
class OfflineError extends Error {}

/** 请求超时：通常是模型太忙，稍后重试即可，不应直接判为失败 */
class TimeoutError extends Error {}

async function requestJson(url, { method = 'GET', body, apiKey, timeoutMs }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let res;
  let text;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    text = await res.text();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new TimeoutError(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    }
    const reason = (err.cause && (err.cause.code || err.cause.message)) || err.message;
    throw new OfflineError(`连接不上本地模型服务（${reason}）`);
  } finally {
    clearTimeout(timer);
  }

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    const detail = (json && json.error && (json.error.message || json.error)) || text.slice(0, 300) || res.statusText;
    const message = `HTTP ${res.status}：${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    throw res.status === 502 || res.status === 503 ? new OfflineError(message) : new Error(message);
  }
  return json;
}

/** 探测服务状态：是否在线、当前模型、是否能读图 */
async function probe(config) {
  const status = { online: false, model: null, vision: null, loaded: null, error: null };
  try {
    // Strata 专有的 /health：能告诉我们模型是否加载、是否开启了读图
    const health = await requestJson(new URL('/health', config.baseUrl).href, { timeoutMs: 4000 }).catch((err) => {
      if (err instanceof OfflineError) throw err;
      return null; // 其他 OpenAI 兼容服务没有这个接口，忽略
    });
    if (health && health.service === 'strata') {
      status.model = health.model || null;
      status.loaded = !!health.loaded;
      // 模型还在加载时服务会报“不能读图”，那只是还不知道，不能当成“不支持读图”
      status.vision = status.loaded ? !!health.images : null;
    }
    const models = await requestJson(`${config.baseUrl}/models`, { apiKey: config.apiKey, timeoutMs: 4000 });
    const textModels = ((models && models.data) || []).filter(
      (m) => !((m.architecture && m.architecture.output_modalities) || []).includes('image')
    );
    if (!status.model && textModels.length) status.model = textModels[0].id;
    status.online = true;
  } catch (err) {
    status.error = err.message;
  }
  return status;
}

/** 把模型的回答整理成最多 5 句话 */
function toSentences(text) {
  const raw = String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
  const clean = (line) =>
    line
      .replace(/^\s*(?:[-*•·]+|\d+\s*[.、)）:：]|[（(]\d+[)）]|第[一二三四五1-5]句?[、:：.]?)\s*/, '')
      .replace(/\*\*/g, '')
      .trim();
  const keep = (line) => line && !/[:：]$/.test(line); // 丢掉“以下是总结：”这类开场白

  let lines = raw.split(/\r?\n+/).map(clean).filter(keep);
  if (lines.length < 5) {
    // 模型没按行输出：按句末标点切分（英文句号后面要有空白才算，避免切开 main.js 这类文件名）
    lines = lines
      .join(' ')
      .split(/(?<=[。！？!?])\s*|(?<=\.)\s+/)
      .map(clean)
      .filter(keep);
  }
  return lines.slice(0, 5);
}

/**
 * 分析一次截屏（可能包含多块屏幕），返回 { activity, sentences, model, ms }
 * images: [{ path, active }]，active 表示鼠标所在的屏幕
 */
async function analyze(config, images, detectedModel) {
  const content = [];
  for (const image of images) {
    const data = await fs.readFile(image.path);
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data.toString('base64')}` } });
  }
  let prompt = config.prompt;
  if (images.length > 1) {
    const active = images.findIndex((image) => image.active) + 1;
    prompt =
      `用户有 ${images.length} 块屏幕，上面 ${images.length} 张图是同一时刻每块屏幕的截图（按屏幕位置从左到右、从上到下排列）。` +
      (active ? `第 ${active} 张是鼠标所在的屏幕，通常是用户正在操作的那块。` : '') +
      `请综合所有屏幕来判断。\n${prompt}`;
  }
  content.push({ type: 'text', text: prompt });

  const model = config.model || detectedModel || 'default';
  const body = {
    model,
    messages: [{ role: 'user', content }],
    max_tokens: config.maxTokens,
    temperature: 0.2,
    stream: false,
  };
  if (config.reasoningEffort) body.reasoning_effort = config.reasoningEffort;

  const started = Date.now();
  const data = await requestJson(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    body,
    apiKey: config.apiKey,
    timeoutMs: config.requestTimeoutSec * 1000,
  });

  let answer = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (Array.isArray(answer)) answer = answer.map((part) => part.text || '').join('');
  const sentences = toSentences(answer);
  if (!sentences.length) throw new Error('模型没有返回内容');

  return {
    activity: sentences.join('\n'),
    sentences,
    model: (data && data.model) || model,
    ms: Date.now() - started,
  };
}

module.exports = { probe, analyze, toSentences, requestJson, OfflineError, TimeoutError };
