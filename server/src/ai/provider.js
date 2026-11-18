import { config, aiConfigured, DEFAULT_MODELS } from '../config.js';
import { newId, now } from '../utils/helpers.js';
import { run } from '../db/index.js';

/**
 * 统一的大模型调用入口。
 *
 * 设计目标：上层业务只关心「我要完成什么任务、要什么结构的结果」，
 * 不关心底层是哪家模型、协议差异、失败怎么办。
 *  - 支持 Anthropic Messages API 与任意 OpenAI 兼容 Chat Completions
 *  - 强制 JSON 结构化输出，带容错解析（模型偶尔会包 ```json 代码块）
 *  - 单次调用超时控制
 *  - 失败时按配置自动降级，由调用方提供的本地实现兜底
 *  - 全量写入 ai_logs，便于管理后台观测与调优
 */

const JSON_SYSTEM_SUFFIX = `

你必须只输出一个合法的 JSON 对象，不要输出任何解释文字、前言、markdown 代码块围栏。`;

/** 从模型回复里抠出 JSON —— 容错处理代码块、前后缀文本 */
export function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();

  // 去掉 ```json ... ``` 围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  try {
    return JSON.parse(s);
  } catch {
    /* 继续尝试截取 */
  }

  // 截取第一个 { 到最后一个 }（或数组）
  const firstBrace = s.indexOf('{');
  const firstBracket = s.indexOf('[');
  let start = -1;
  let openCh;
  let closeCh;
  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    start = firstBrace;
    openCh = '{';
    closeCh = '}';
  } else if (firstBracket !== -1) {
    start = firstBracket;
    openCh = '[';
    closeCh = ']';
  }
  if (start === -1) return null;

  const end = s.lastIndexOf(closeCh);
  if (end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

function logAi({ userId, task, provider, model, latency, ok, error, usage }) {
  try {
    run(
      `INSERT INTO ai_logs (id,user_id,task,provider,model,latency_ms,ok,error,tokens_in,tokens_out,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      newId('ail'),
      userId || null,
      task,
      provider,
      model || '',
      Math.round(latency || 0),
      ok ? 1 : 0,
      error ? String(error).slice(0, 500) : '',
      usage?.in || 0,
      usage?.out || 0,
      now(),
    );
  } catch {
    /* 审计失败不影响主流程 */
  }
}

async function fetchWithTimeout(url, options) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.ai.timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 各 provider 适配 ---------------- */

/**
 * 解析实际使用的模型名。
 * AI_MODEL 只覆盖主模型，AI_MODEL_FAST 只覆盖轻量任务，
 * 两者互不干扰 —— 否则设了 AI_MODEL 就会把 fast 路径也顶成昂贵模型。
 */
function resolveModel(provider, fast) {
  const preset = DEFAULT_MODELS[provider];
  const override = fast ? config.ai.modelFast : config.ai.model;
  return override || (fast ? preset.fast : preset.main);
}

async function callAnthropic({ system, messages, maxTokens, temperature, fast }) {
  const model = resolveModel('anthropic', fast);
  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
    system,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  };

  const res = await fetchWithTimeout(`${config.ai.anthropicBase}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.ai.anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Anthropic ${res.status}: ${data?.error?.message || JSON.stringify(data).slice(0, 200)}`);
  }
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return {
    text,
    model,
    usage: { in: data.usage?.input_tokens || 0, out: data.usage?.output_tokens || 0 },
  };
}

async function callOpenAI({ system, messages, maxTokens, temperature, fast, jsonMode }) {
  const model = resolveModel('openai', fast);
  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
    messages: [{ role: 'system', content: system }, ...messages],
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetchWithTimeout(`${config.ai.openaiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.ai.openaiKey}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${data?.error?.message || JSON.stringify(data).slice(0, 200)}`);
  }
  const text = data.choices?.[0]?.message?.content || '';
  return {
    text,
    model,
    usage: { in: data.usage?.prompt_tokens || 0, out: data.usage?.completion_tokens || 0 },
  };
}

/* ---------------- 对外主入口 ---------------- */

/**
 * @param {object} opts
 * @param {string} opts.task            任务标识，用于审计
 * @param {string} [opts.userId]        触发用户
 * @param {string} opts.system          系统提示词
 * @param {Array}  opts.messages        [{role:'user'|'assistant', content}]
 * @param {boolean}[opts.json]          是否要求 JSON 输出
 * @param {boolean}[opts.fast]          是否用快速/廉价模型
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]
 * @returns {Promise<{ok:boolean, text:string, data:any, provider:string, model:string, error?:string}>}
 */
export async function callAI(opts) {
  const {
    task,
    userId,
    system,
    messages,
    json = false,
    fast = false,
    maxTokens = 2000,
    temperature = 0.7,
  } = opts;

  if (!aiConfigured()) {
    return { ok: false, text: '', data: null, provider: 'local', model: '', error: 'no-provider' };
  }

  const provider = config.ai.provider;
  const finalSystem = json ? system + JSON_SYSTEM_SUFFIX : system;
  const started = Date.now();

  try {
    const out =
      provider === 'anthropic'
        ? await callAnthropic({ system: finalSystem, messages, maxTokens, temperature, fast })
        : await callOpenAI({ system: finalSystem, messages, maxTokens, temperature, fast, jsonMode: json });

    const latency = Date.now() - started;
    logAi({
      userId,
      task,
      provider,
      model: out.model,
      latency,
      ok: true,
      usage: out.usage,
    });

    const data = json ? extractJson(out.text) : null;
    if (json && data === null) {
      // 模型没按 JSON 返回，视为可降级的失败
      return {
        ok: false,
        text: out.text,
        data: null,
        provider,
        model: out.model,
        error: 'invalid-json',
      };
    }
    return { ok: true, text: out.text, data, provider, model: out.model };
  } catch (err) {
    const latency = Date.now() - started;
    const msg = err?.name === 'AbortError' ? 'timeout' : err?.message || String(err);
    logAi({ userId, task, provider, model: '', latency, ok: false, error: msg });
    return { ok: false, text: '', data: null, provider, model: '', error: msg };
  }
}

/**
 * 带本地兜底的高层封装：远端不可用或返回异常时执行 localFn。
 * 返回值永远带有 ok 标记，调用方据此决定是否提示用户「当前为本地引擎结果」。
 */
export async function callAIWithFallback(opts, localFn) {
  const res = await callAI(opts);
  if (res.ok) return { ...res, degraded: false };

  if (config.ai.fallback && typeof localFn === 'function') {
    try {
      const data = await localFn();
      return {
        ok: true,
        text: '',
        data,
        provider: 'local',
        model: 'local-engine',
        degraded: true,
        reason: res.error,
      };
    } catch (err) {
      return {
        ok: false,
        text: '',
        data: null,
        provider: res.provider,
        model: res.model,
        degraded: true,
        error: `remote:${res.error}; local:${err?.message}`,
      };
    }
  }
  return { ...res, degraded: true };
}

export function aiStatus() {
  return {
    configured: aiConfigured(),
    provider: aiConfigured() ? config.ai.provider : 'local',
    model:
      config.ai.model ||
      (config.ai.provider === 'anthropic' ? DEFAULT_MODELS.anthropic.main : config.ai.provider === 'openai' ? DEFAULT_MODELS.openai.main : 'local-engine'),
    fallbackEnabled: config.ai.fallback,
  };
}
