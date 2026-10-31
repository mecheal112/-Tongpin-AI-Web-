import { callAIWithFallback } from './provider.js';
import * as P from './prompts.js';
import { loadCandidatePool } from './matching.js';
import { computeMatch } from './match-engine.js';
import { loadPersona } from './persona.js';

/**
 * 同频局的 AI 人选推荐。
 *
 * 组队的痛点是「发起人不知道该叫谁」—— 好友列表里不一定有合适的，
 * 而社区里合适的人又没被暴露出来。这里用画像做双向匹配，
 * 让发起人看到一个「可能合适但你还不认识」的名单。
 */
export async function recommendMembers(group, ownerId, { limit = 5 } = {}) {
  const owner = loadPersona(ownerId);
  const pool = loadCandidatePool({ excludeIds: [ownerId, ...(group.memberIds || [])] });
  if (!pool.length) return { picks: [], degraded: false };

  // 先用本地引擎按与发起人的匹配度粗筛，减少送入模型的人数
  const corpus = pool.map((p) => p.raw_text || '');
  const coarse = pool
    .map((p) => ({ p, m: computeMatch(owner || {}, p, { corpus }) }))
    .sort((a, b) => b.m.score - a.m.score)
    .slice(0, 12)
    .map((x) => x.p);

  const res = await callAIWithFallback(
    {
      task: 'group-match',
      userId: ownerId,
      system: P.GROUP_MATCH_SYSTEM,
      messages: [{ role: 'user', content: P.groupMatchPrompt(group, owner || { nickname: '发起人' }, coarse) }],
      json: true,
      fast: true,
      temperature: 0.6,
      maxTokens: 800,
    },
    () => localPicks(group, owner, coarse),
  );

  let picks = Array.isArray(res.data?.picks) ? res.data.picks : localPicks(group, owner, coarse).picks;

  // 校验模型返回的 id 必须真实存在于候选中，防止幻觉出不存在的人
  const valid = new Map(coarse.map((c) => [c.user_id, c]));
  picks = picks
    .filter((p) => valid.has(p.id))
    .map((p) => {
      const c = valid.get(p.id);
      return {
        id: p.id,
        nickname: c.nickname,
        avatar: c.avatar,
        summary: c.summary,
        interests: (c.interests || []).map((i) => i.name).slice(0, 4),
        reason: String(p.reason || '').slice(0, 60),
        role_hint: String(p.role_hint || '').slice(0, 40),
      };
    })
    .slice(0, limit);

  if (!picks.length) picks = localPicks(group, owner, coarse).picks.slice(0, limit);

  return { picks, degraded: res.degraded };
}

/** 本地推荐：按与发起人的匹配分排序，把理由写成一句人话 */
function localPicks(group, owner, candidates) {
  const wanted = String(group.wanted || '');
  const scored = candidates.map((c) => {
    const m = computeMatch(owner || {}, c, {});
    // 命中发起人提出的特质要求时加分
    let bonus = 0;
    for (const i of c.interests || []) {
      if (wanted && wanted.includes(i.name)) bonus += 12;
    }
    if (wanted) {
      for (const part of wanted.split(/[，,、\s]+/).filter(Boolean)) {
        if ((c.raw_text || '').includes(part) || (c.summary || '').includes(part)) bonus += 6;
      }
    }
    // 与组内既有成员兴趣重合的人更容易融入
    const overlapWithGroup = (group.memberInterests || []).filter((n) =>
      (c.interests || []).some((i) => i.name === n),
    ).length;
    return { c, score: m.score + bonus + overlapWithGroup * 4, m };
  });

  scored.sort((x, y) => y.score - x.score);

  return {
    picks: scored.slice(0, 5).map(({ c, m }) => ({
      id: c.user_id,
      nickname: c.nickname,
      avatar: c.avatar,
      summary: c.summary,
      interests: (c.interests || []).map((i) => i.name).slice(0, 4),
      reason:
        (m.common || []).length > 0
          ? `和你们在${m.common.slice(0, 2).join('、')}上有共同话题`
          : `画像匹配度 ${m.score}，${(c.interests || [])[0]?.name ? `对${c.interests[0].name}有兴趣` : '兴趣方向不同，能带来新视角'}`,
      role_hint: (c.goals || [])[0] ? `正在${c.goals[0]}` : '可能有新的视角',
    })),
  };
}
