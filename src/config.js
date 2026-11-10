const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULT_PROMPT =
  '这是用户电脑屏幕的截图。请用简短的5句话总结用户此刻正在做什么。\n' +
  '要求：恰好5句，每句不超过30个字，使用中文；每句单独一行；' +
  '不要编号，不要开场白，不要任何额外解释。';

const DEFAULTS = {
  intervalSec: 20,            // 截屏间隔（秒）
  dataDir: '',                // 数据目录，留空 = 文档\LifeLens
  autoStart: true,            // 启动应用后自动开始截屏
  skipWhenLocked: true,       // 锁屏时不截屏
  maxWidth: 1920,             // 每块屏幕图片的最大宽度（像素），0 = 原始分辨率
  jpegQuality: 80,            // JPEG 质量 30-100
  analysisEnabled: true,      // 是否调用本地模型分析
  baseUrl: 'http://127.0.0.1:8080/v1', // Strata 的 OpenAI 兼容接口
  model: '',                  // 留空 = 自动使用服务当前加载的模型
  apiKey: '',                 // Strata 设置了 API key 时填写
  reasoningEffort: 'none',    // 关闭思考，回答更快
  maxTokens: 512,
  requestTimeoutSec: 180,
  maxQueue: 180,              // 待分析队列上限（180 张 = 1 小时），超出则跳过最旧的
  prompt: DEFAULT_PROMPT,
  syncEnabled: false,         // 多设备同步（私有 Git 仓库）
  syncRepo: '',               // 仓库地址，例如 https://github.com/你/lifelens-memory.git
  deviceName: '',             // 这台电脑的名字，留空 = 计算机名
};

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function defaultDataDir() {
  return path.join(app.getPath('documents'), 'LifeLens');
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalize(raw) {
  const c = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  c.intervalSec = clamp(c.intervalSec, 5, 3600, DEFAULTS.intervalSec);
  c.maxWidth = clamp(c.maxWidth, 0, 7680, DEFAULTS.maxWidth);
  if (c.maxWidth > 0 && c.maxWidth < 640) c.maxWidth = 640;
  c.jpegQuality = clamp(c.jpegQuality, 30, 100, DEFAULTS.jpegQuality);
  c.maxTokens = clamp(c.maxTokens, 64, 4096, DEFAULTS.maxTokens);
  c.requestTimeoutSec = clamp(c.requestTimeoutSec, 10, 1800, DEFAULTS.requestTimeoutSec);
  c.maxQueue = clamp(c.maxQueue, 1, 5000, DEFAULTS.maxQueue);
  c.autoStart = !!c.autoStart;
  c.skipWhenLocked = !!c.skipWhenLocked;
  c.analysisEnabled = !!c.analysisEnabled;
  c.dataDir = String(c.dataDir || '').trim() || defaultDataDir();
  c.baseUrl = String(c.baseUrl || '').trim().replace(/\/+$/, '') || DEFAULTS.baseUrl;
  c.model = String(c.model || '').trim();
  c.apiKey = String(c.apiKey || '').trim();
  c.reasoningEffort = String(c.reasoningEffort || '').trim();
  c.prompt = String(c.prompt || '').trim() || DEFAULT_PROMPT;
  c.syncEnabled = !!c.syncEnabled;
  c.syncRepo = String(c.syncRepo || '').trim();
  c.deviceName = String(c.deviceName || '').trim() || require('os').hostname();
  return c;
}

function load() {
  try {
    return normalize(JSON.parse(fs.readFileSync(configPath(), 'utf8')));
  } catch {
    return normalize({});
  }
}

function save(raw) {
  const c = normalize(raw);
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(c, null, 2), 'utf8');
  return c;
}

module.exports = { load, save, DEFAULT_PROMPT };
