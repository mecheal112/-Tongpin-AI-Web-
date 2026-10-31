import { callAI, callAIWithFallback } from './provider.js';
import * as P from './prompts.js';
import {
  extractInterests,
  detectRhythm,
  extractValues,
  extractGoals,
  scorePersona,
  summarizePersona,
  DIMENSIONS,
  cosine,
  vectorize,
} from './local-engine.js';
import { parseJson, toJson, run, get } from '../db/index.js';
import { newId, now } from '../utils/helpers.js';
import { extractAndApply } from './interest-graph.js';

/* ============================================================
 *  画像服务：对话式访谈 + 结构化提炼
 * ============================================================ */

export const MIN_TURNS = 6;

/**
 * 推进一轮画像访谈。
 * 有模型时由模型主导追问；无模型时用本地引导问题清单。
 */
export async function personaTurn({ user, session, history, userMessage }) {
  const turnCount = session.turn_count + 1;
  const msgs = [
    { role: 'user', content: P.personaUserPrompt({ history: [...history, { role: 'user', content: userMessage }], turnCount }) },
  ];

  const res = await callAIWithFallback(
    {
      task: 'persona',
      userId: user.id,
      system: P.PERSONA_SYSTEM,
      messages: msgs,
      json: true,
      temperature: 0.8,
      maxTokens: 1200,
    },
    () => localPersonaTurn({ history: [...history, { role: 'user', content: userMessage }], turnCount }),
  );

  const data = res.data || localPersonaTurn({ history, turnCount });

  // 模型判断可以收尾时，落库画像
  if (data.done && turnCount >= MIN_TURNS) {
    const persona = {
      vector: normalizeVector(data.vector),
      interests: normalizeInterests(data.interests),
      values: Array.isArray(data.values) ? data.values.slice(0, 8) : [],
      goals: Array.isArray(data.goals) ? data.goals.slice(0, 6) : [],
      rhythm: data.rhythm || '灵活',
      summary: data.summary || '',
      ideal_match: data.ideal_match || '',
    };
    persona.raw_text = buildRawText(history, userMessage, persona);
    // 模型漏字段时用本地引擎补齐，保证画像永远完整
    const local = localPersonaTurn({ history: [...history, { role: 'user', content: userMessage }], turnCount }).persona;
    mergeMissing(persona, local);

    savePersona(user.id, persona);
    return { done: true, reply: data.reply || '画像已经生成好了。', persona, degraded: res.degraded, provider: res.provider };
  }

  // 达到硬上限则强制收尾，避免用户被无限追问
  if (turnCount >= 10) {
    const local = localPersonaTurn({ history: [...history, { role: 'user', content: userMessage }], turnCount: 10 });
    const persona = local.persona;
    persona.raw_text = buildRawText(history, userMessage, persona);
    savePersona(user.id, persona);
    return { done: true, reply: '聊得差不多了，我已经对你有比较完整的了解。', persona, degraded: res.degraded, provider: res.provider };
  }

  return {
    done: false,
    reply: data.reply || '能再具体说说吗？',
    degraded: res.degraded,
    provider: res.provider,
  };
}

function normalizeVector(v) {
  const base = Array.isArray(v) && v.length === DIMENSIONS.length ? v : scorePersona('');
  return base.map((x) => Math.round(Math.min(100, Math.max(0, Number(x) || 0))));
}

function normalizeInterests(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((i) => (typeof i === 'string' ? { name: i, weight: 60 } : { name: String(i?.name || '').trim(), weight: Number(i?.weight) || 60 }))
    .filter((i) => i.name)
    .slice(0, 8);
}

function mergeMissing(persona, local) {
  if (!persona.interests.length) persona.interests = local.interests;
  if (!persona.values.length) persona.values = local.values;
  if (!persona.goals.length) persona.goals = local.goals;
  if (persona.rhythm === '灵活' && local.rhythm !== '灵活') persona.rhythm = local.rhythm;
  if (!persona.summary) persona.summary = local.summary;
  if (!persona.ideal_match) persona.ideal_match = local.ideal_match;
}

function buildRawText(history, last, persona) {
  const parts = history.map((m) => m.content).concat([last]);
  parts.push((persona.interests || []).map((i) => i.name).join(' '));
  parts.push((persona.values || []).join(' '));
  parts.push((persona.goals || []).join(' '));
  return parts.join('\n').slice(0, 4000);
}

/* ---- 本地访谈引擎：无模型时保证访谈仍然可用 ---- */

const LOCAL_QUESTIONS = [
  { q: '先随便聊聊——最近一周，你花时间最多的一件事是什么？', dim: 'openness' },
  { q: '周末如果完全没人找你，你一般会怎么过？', dim: 'social_energy' },
  { q: '你更喜欢深夜还是清晨？那段时间你通常在做什么？', dim: 'structure' },
  { q: '最近有没有什么事让你觉得挺有压力的？', dim: 'empathy' },
  { q: '你身边的朋友一般怎么形容你？你自己认同吗？', dim: 'expressiveness' },
  { q: '有没有什么话题，你能跟人聊上几个小时都不腻？', dim: 'depth' },
  { q: '你希望认识什么样的新朋友？或者说，你现在缺什么样的关系？', dim: 'social_energy' },
  { q: '大学这几年，你有什么特别想做成的事吗？', dim: 'structure' },
];

function localPersonaTurn({ history, turnCount }) {
  const allText = history.map((m) => m.content).join('\n');
  const ready = turnCount >= MIN_TURNS && allText.length >= 80;

  if (ready) {
    const vector = scorePersona(allText);
    const interests = extractInterests(allText);
    const rhythm = detectRhythm(allText);
    const values = extractValues(allText);
    const goals = extractGoals(allText);
    const summary = summarizePersona({ vector, interests, rhythm, values });
    const top = interests.slice(0, 2).map((i) => i.name);
    return {
      done: true,
      reply: '好，我已经对你有比较清晰的了解了，画像生成完毕。',
      persona: {
        vector,
        interests,
        values,
        goals,
        rhythm,
        summary,
        ideal_match: top.length
          ? `同样对${top.join('、')}有兴趣，${values[0] ? `也在意${values[0]}，` : ''}聊得来也约得动的人`
          : '聊得来、节奏合拍、能一起做点事的人',
      },
    };
  }

  const idx = Math.min(turnCount, LOCAL_QUESTIONS.length - 1);
  const q = LOCAL_QUESTIONS[idx];
  // 给一句基于上文的轻回应，避免像问卷
  const ack = turnCount === 0 ? '好，我们从简单的开始。' : '嗯，记下了。';
  return { done: false, reply: `${ack}${q.q}`, partial: { interests: extractInterests(allText).map((i) => i.name), rhythm: detectRhythm(allText) } };
}

/* ---- 从自由文本直接提炼画像（用于「快速创建画像」与种子数据） ---- */

export async function extractPersonaFromText(userId, text) {
  const res = await callAIWithFallback(
    {
      task: 'persona-extract',
      userId,
      system: P.PERSONA_EXTRACT_SYSTEM,
      messages: [{ role: 'user', content: P.personaExtractPrompt(text) }],
      json: true,
      temperature: 0.3,
      maxTokens: 1200,
    },
    () => {
      const vector = scorePersona(text);
      const interests = extractInterests(text);
      const rhythm = detectRhythm(text);
      const values = extractValues(text);
      return {
        vector,
        interests,
        values,
        goals: extractGoals(text),
        rhythm,
        summary: summarizePersona({ vector, interests, rhythm, values }),
        ideal_match: '聊得来、节奏合拍的人',
      };
    },
  );

  const d = res.data || {};
  const persona = {
    vector: normalizeVector(d.vector),
    interests: normalizeInterests(d.interests),
    values: Array.isArray(d.values) ? d.values.slice(0, 8) : [],
    goals: Array.isArray(d.goals) ? d.goals.slice(0, 6) : [],
    rhythm: d.rhythm || '灵活',
    summary: d.summary || '',
    ideal_match: d.ideal_match || '',
    raw_text: text.slice(0, 4000),
  };
  if (!persona.interests.length) persona.interests = extractInterests(text);
  if (!persona.summary) persona.summary = summarizePersona(persona);
  savePersona(userId, persona);
  return { persona, degraded: res.degraded };
}

/* ---- 画像读写 ---- */

export function savePersona(userId, persona) {
  const existing = get('SELECT version FROM personas WHERE user_id = ?', userId);
  const version = existing ? existing.version + 1 : 1;
  const ts = now();

  run(
    `INSERT INTO personas (user_id,vector,interests,values_json,goals,rhythm,summary,ideal_match,raw_text,version,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       vector=excluded.vector, interests=excluded.interests, values_json=excluded.values_json,
       goals=excluded.goals, rhythm=excluded.rhythm, summary=excluded.summary,
       ideal_match=excluded.ideal_match, raw_text=excluded.raw_text,
       version=excluded.version, updated_at=excluded.updated_at`,
    userId,
    toJson(persona.vector),
    toJson(persona.interests),
    toJson(persona.values),
    toJson(persona.goals),
    persona.rhythm || '灵活',
    persona.summary || '',
    persona.ideal_match || '',
    persona.raw_text || '',
    version,
    ts,
  );
  run('UPDATE users SET persona_stage = 2 WHERE id = ?', userId);
  // 兴趣图谱：画像落库后异步入图（访谈收尾/强制收尾/快速提炼都走这里）。
  // 入图失败不阻塞画像主流程，见 interest-graph 的设计约定。
  extractAndApply(userId, { source: 'interview', sourceId: `v${version}`, text: persona.raw_text || persona.summary || '' });
  return version;
}

/** 读出画像并反序列化 JSON 字段 */
export function loadPersona(userId) {
  const row = get(
    `SELECT p.*, u.nickname, u.school, u.college, u.major, u.grade, u.gender, u.bio, u.contact_pref, u.avatar
     FROM personas p JOIN users u ON u.id = p.user_id WHERE p.user_id = ?`,
    userId,
  );
  if (!row) return null;
  return hydratePersona(row);
}

export function hydratePersona(row) {
  return {
    ...row,
    // personas 表的主键是 user_id，没有 id 列。补齐 id 让调用方统一按 id 取人，
    // 否则 me.id / other.id 会静默变成 undefined（卡壳判断和 prompt 都按 id 比对说话人）。
    id: row.user_id,
    vector: parseJson(row.vector, []),
    interests: parseJson(row.interests, []),
    values: parseJson(row.values_json, []),
    goals: parseJson(row.goals, []),
  };
}

export { DIMENSIONS, cosine, vectorize };
