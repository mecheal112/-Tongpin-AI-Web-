import { callAIWithFallback } from './provider.js';
import * as P from './prompts.js';
import { all, get, run, parseJson, toJson } from '../db/index.js';
import { newId, now } from '../utils/helpers.js';
import { loadPersona } from './persona.js';
import { interestOverlap, complementarity } from './match-engine.js';

/**
 * 破冰脚手架 —— 本产品的核心创新点。
 *
 * 社交产品真正的流失点不在「匹配」，而在匹配之后的第一次对话。
 * 两人互相 like 了，打开聊天框，然后盯着输入框不知道该说什么，最后关掉。
 * 这个匹配就浪费了。
 *
 * 传统做法是给个「打招呼」按钮。但那解决不了问题——真正难的是
 * 「基于我们俩的具体情况，第一句话说什么才不尴尬」。
 *
 * 这里的做法：
 *   阶段 active   —— 双方刚连上，AI 基于双方画像生成 3 条可直接发送的开场白
 *   阶段 fading   —— 对话自然流动起来后，AI 主动降频、只在卡壳时介入
 *   阶段 retired  —— 关系已经能自己走下去，AI 完全退场，不再出现在对话里
 *
 * 关键点：脚手架的终点是拆掉自己。AI 的目标是让两个人建立起不依赖 AI 的关系，
 * 而不是让他们一直依赖 AI 来维持对话。这是对「AI 应该增强人的连接、
 * 而不是替代人的连接」这一判断的产品化表达。
 */

/** 判断脚手架该处于什么阶段 —— 决定 AI 是否出场 */
export function scaffoldPhase(conv, messages) {
  const humanMsgs = messages.filter((m) => m.kind === 'text');
  const humanCount = humanMsgs.length;

  // 双方都发过消息，且总量足够 —— 关系已经启动
  const senders = new Set(humanMsgs.map((m) => m.sender_id).filter(Boolean));
  const bothEngaged = senders.size >= 2;

  if (humanCount >= 20 && bothEngaged) return 'retired';
  if (humanCount >= 8 && bothEngaged) return 'fading';
  return 'active';
}

/** 生成开场白（双方都能看到，但分别有针对性） */
export async function generateIcebreakers(convId, viewerId) {
  const conv = get('SELECT * FROM conversations WHERE id = ?', convId);
  if (!conv) return { ok: false, error: 'not-found' };

  const otherId = conv.user_a === viewerId ? conv.user_b : conv.user_a;
  const me = loadPersona(viewerId);
  const other = loadPersona(otherId);
  if (!me || !other) return { ok: false, error: 'no-persona' };

  const { common } = interestOverlap(me.interests, other.interests);
  const comp = complementarity(me, other);

  const res = await callAIWithFallback(
    {
      task: 'icebreak',
      userId: viewerId,
      system: P.ICEBREAK_SYSTEM,
      messages: [{ role: 'user', content: P.icebreakPrompt(me, other, common, comp.newInterests) }],
      json: true,
      fast: true,
      temperature: 0.9,
      maxTokens: 700,
    },
    () => localIcebreakers(me, other, common, comp.newInterests),
  );

  const openers = Array.isArray(res.data?.openers) && res.data.openers.length
    ? res.data.openers
    : localIcebreakers(me, other, common, comp.newInterests).openers;

  run('UPDATE conversations SET scaffold_state = ? WHERE id = ? AND scaffold_state = ?', 'active', convId, 'none');

  return { ok: true, openers: openers.slice(0, 3), common, degraded: res.degraded };
}

/** 本地开场白生成：基于双方画像的真实交集拼装，保证句子具体可用 */
export function localIcebreakers(me, other, common = [], newInterests = []) {
  const openers = [];
  const myTop = (me.interests || [])[0]?.name;
  const theirTop = (other.interests || [])[0]?.name;

  if (common.length) {
    openers.push({
      text: `发现我们都对${common[0]}感兴趣，你最近在这上面花时间多吗？`,
      angle: '共同兴趣',
      target: 'both',
    });
  }

  // 差异好奇：把互补点变成话题。用「想了解」而不是「你有研究」，避免预设对方是专家。
  if (newInterests.length) {
    openers.push({
      text: `我对${newInterests[0]}一直想入门但没找到头绪，你平时是怎么玩的？`,
      angle: '差异好奇',
      target: 'both',
    });
  } else if (myTop && theirTop && myTop !== theirTop) {
    openers.push({
      text: `你平时的重心在${theirTop}？我在${myTop}上花的时间比较多，好奇你是怎么开始的。`,
      angle: '差异好奇',
      target: 'both',
    });
  }

  // 当下状态：引导对方说具体经历，而不是只回「是啊」
  const goal = (other.goals || [])[0];
  if (goal) {
    openers.push({
      text: `看到你也在准备${goal}，最近进度怎么样？我这边有点卡住，想找人聊聊。`,
      angle: '当下状态',
      target: 'both',
    });
  } else {
    openers.push({
      text: `你最近在忙什么？我除了上课就是泡在${myTop || '自己的事情'}上，想找个能一起做事的人。`,
      angle: '当下状态',
      target: 'both',
    });
  }

  // 作息差异是很好的轻松开场
  if (me.rhythm && other.rhythm && me.rhythm !== other.rhythm && me.rhythm !== '灵活' && other.rhythm !== '灵活') {
    openers.push({
      text: `你是${other.rhythm}？我是${me.rhythm}，感觉我们聊天得挑个双方都清醒的时间。`,
      angle: '差异好奇',
      target: 'both',
    });
  }

  return { openers: openers.slice(0, 3), common };
}

/**
 * 对话进行中的介入判断。
 * 只有真的卡住才建议介入 —— 频繁插话会破坏两个人的交流。
 */
export async function evaluateNudge(convId, viewerId) {
  const conv = get('SELECT * FROM conversations WHERE id = ?', convId);
  if (!conv) return { needed: false };

  const phase = conv.scaffold_state;
  if (phase === 'retired') return { needed: false, retired: true };

  const otherId = conv.user_a === viewerId ? conv.user_b : conv.user_a;
  const recent = all(
    'SELECT * FROM messages WHERE conv_id = ? ORDER BY created_at DESC LIMIT 12',
    convId,
  ).reverse();

  const human = recent.filter((m) => m.kind === 'text');
  if (human.length < 3) return { needed: false };

  const me = loadPersona(viewerId);
  const other = loadPersona(otherId);
  if (!me || !other) return { needed: false };

  const res = await callAIWithFallback(
    {
      task: 'nudge',
      userId: viewerId,
      system: P.NUDGE_SYSTEM,
      messages: [{ role: 'user', content: P.nudgePrompt(me, other, recent) }],
      json: true,
      fast: true,
      temperature: 0.6,
      maxTokens: 500,
    },
    () => localNudge(recent, me, other),
  );

  const d = res.data || localNudge(recent, me, other);
  return { ...d, degraded: res.degraded };
}

/** 本地卡壳检测：用对话结构信号判断，不需要理解语义 */
export function localNudge(recent, me, other) {
  const human = recent.filter((m) => m.kind === 'text');
  if (human.length < 4) return { needed: false, state: 'flowing', reason: '对话刚开始' };

  const byA = human.filter((m) => m.sender_id === me.id).length;
  const byB = human.filter((m) => m.sender_id === other.id).length;

  // 单向输出检测
  if (byA >= 4 && byB <= 1) {
    return {
      needed: true,
      state: 'unbalanced',
      suggestion: '你说了不少，要不问问对方最近在忙什么？把话头递过去。',
      reason: '对话偏向单方输出',
    };
  }
  if (byB >= 4 && byA <= 1) {
    return {
      needed: true,
      state: 'unbalanced',
      suggestion: '对方说的比较多，可以顺着追一个具体问题，比如「那你当时是怎么想的」。',
      reason: '对方输出多，你在简短回应',
    };
  }

  // 短回复堆积检测
  const shortReplies = human.slice(-5).filter((m) => m.content.trim().length <= 6).length;
  if (shortReplies >= 3) {
    const theirInterest = (other.interests || [])[0]?.name;
    return {
      needed: true,
      state: 'stalled',
      suggestion: theirInterest
        ? `话题有点散了，换个具体的：问问对方最近在${theirInterest}上有什么新进展。`
        : '话题有点散了，可以聊点具体的，比如最近在忙的一件事。',
      reason: '连续短回复，话题耗尽',
    };
  }

  // 时间间隔检测：超过 24 小时没有新消息
  const last = human[human.length - 1];
  if (last && Date.now() - last.created_at > 86400000) {
    return {
      needed: true,
      state: 'stalled',
      suggestion: '隔了一天了，可以分享一个你刚遇到的小事重新开个头，不用刻意找话题。',
      reason: '对话中断超过一天',
    };
  }

  return { needed: false, state: 'flowing', reason: '对话正在进行' };
}

/** 依据对话进展推进脚手架生命周期 */
export function advanceScaffold(convId) {
  const conv = get('SELECT * FROM conversations WHERE id = ?', convId);
  if (!conv) return 'none';
  const msgs = all('SELECT * FROM messages WHERE conv_id = ? ORDER BY created_at', convId);
  const phase = scaffoldPhase(conv, msgs);

  // active -> fading -> retired 单向推进，不回退
  const order = { none: 0, active: 1, fading: 2, retired: 3 };
  const current = order[conv.scaffold_state] ?? 0;
  const next = Math.max(current, order[phase] ?? 0);
  const state = Object.keys(order).find((k) => order[k] === next) || 'active';

  if (state !== conv.scaffold_state) {
    run('UPDATE conversations SET scaffold_state = ? WHERE id = ?', state, convId);
    if (state === 'retired') {
      // 退场时留一条系统提示，让用户明确知道 AI 不再介入
      run(
        `INSERT INTO messages (id,conv_id,sender_id,kind,content,created_at) VALUES (?,?,NULL,?,?,?)`,
        newId('msg'),
        convId,
        'system',
        '你们已经聊起来了，我先撤了。需要的时候在右上角可以再叫我。',
        now(),
      );
    }
  }
  return state;
}

/** 手动召回脚手架 */
export function recallScaffold(convId, userId) {
  const conv = get('SELECT * FROM conversations WHERE id = ?', convId);
  if (!conv) return { ok: false };
  run('UPDATE conversations SET scaffold_state = ? WHERE id = ?', 'active', convId);
  return { ok: true, state: 'active' };
}
