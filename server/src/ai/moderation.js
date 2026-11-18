import { callAIWithFallback } from './provider.js';
import * as P from './prompts.js';

/**
 * 内容安全与语义标签。
 *
 * 审核在这里不是「附加功能」而是社区能存在的前提：
 * 一个校园社区如果放任骚扰和诈骗，女生和内向的人会先离开，
 * 剩下的人也会停止表达真实想法。所以审核质量和匹配质量同等重要。
 *
 * 同样带本地兜底：无模型时用规则词表，保证社区不会因为 AI 不可用而失去防护。
 */

/** 本地风险词表 */
const RULES = [
  {
    label: '人身攻击',
    weight: 40,
    words: ['傻逼', '智障', '脑残', '废物', '去死', '滚蛋', '垃圾人', '贱', '蠢货', '神经病', '丑八怪'],
  },
  { label: '歧视', weight: 45, words: ['地域狗', '农村人就是', '女人就该', '男人都', '娘炮', '死gay', '同性恋恶心', '歧视']},
  { label: '色情低俗', weight: 55, words: ['约炮', '一夜情', '裸聊', '看片', '黄色网站', '肉体', '开房'] },
  { label: '诈骗广告', weight: 50, words: ['代写', '代考', '刷单', '兼职日结', '包过', '加微信', '加qq', '出售答案', '免考', '贷款', '返利', '赌'] },
  { label: '暴力威胁', weight: 60, words: ['弄死你', '打死', '砍', '报复', '威胁', '找人打'] },
  { label: '自伤倾向', weight: 50, words: ['自杀', '不想活', '活着没意思', '轻生', '结束生命', '跳楼', '割腕', '自我了断'] },
];

/** 本地审核：词表匹配 + 强度估计 */
export function localModerate(content) {
  const s = String(content || '').toLowerCase();
  let score = 0;
  const labels = [];
  let needSupport = false;

  for (const rule of RULES) {
    const hits = rule.words.filter((w) => s.includes(w.toLowerCase()));
    if (hits.length) {
      score += rule.weight * Math.min(hits.length, 3) * 0.6;
      labels.push(rule.label);
      if (rule.label === '自伤倾向') needSupport = true;
    }
  }

  // 全大写/大量感叹号/重复字符：刷屏或情绪激动
  if (/(.)\1{6,}/.test(s)) {
    score += 9;
    labels.push('刷屏');
  }
  if ((s.match(/!/g) || []).length >= 6) score += 6;
  // 联系方式外露配合营销词，判为广告
  if (/(微信|vx|v信|qq|加我)/i.test(s) && /(兼职|赚钱|代理|资源|福利)/.test(s)) {
    score += 30;
    labels.push('广告引流');
  }

  score = Math.min(100, Math.round(score));

  // 自伤内容不按分数分档：一次命中就足以转人工复核。
  // 这类内容要的是及时转介心理支持，宁可多标也不该漏过去。
  const status = needSupport
    ? score >= 65 ? 'blocked' : 'flagged'
    : score >= 65 ? 'blocked' : score >= 32 ? 'flagged' : 'ok';

  return {
    status,
    score,
    labels: [...new Set(labels)],
    need_support: needSupport,
    reason: labels.length ? `命中：${[...new Set(labels)].join('、')}` : '未发现风险',
  };
}

/** 审核入口 */
export async function moderate(content, userId) {
  if (!content || !content.trim()) {
    return { status: 'ok', score: 0, labels: [], need_support: false, reason: '' };
  }

  const res = await callAIWithFallback(
    {
      task: 'moderate',
      userId,
      system: P.MODERATE_SYSTEM,
      messages: [{ role: 'user', content: P.moderatePrompt(content) }],
      json: true,
      fast: true,
      temperature: 0,
      maxTokens: 400,
    },
    () => localModerate(content),
  );

  const d = res.data || localModerate(content);
  const VALID = ['ok', 'flagged', 'blocked'];
  const status = VALID.includes(d.status) ? d.status : 'ok';

  // 自伤内容一律升级为需要支持介入 —— 这类内容不该只做拦截，要给出转介
  const needSupport = Boolean(d.need_support) || (d.labels || []).some((l) => String(l).includes('自伤'));

  return {
    status,
    score: Math.min(100, Math.max(0, Number(d.score) || 0)),
    labels: Array.isArray(d.labels) ? d.labels.slice(0, 6) : [],
    need_support: needSupport,
    reason: String(d.reason || '').slice(0, 200),
    degraded: res.degraded,
  };
}

/** 为动态生成语义标签 */
export async function generateTags(content, userId) {
  const res = await callAIWithFallback(
    {
      task: 'post-tags',
      userId,
      system: P.POST_TAGS_SYSTEM,
      messages: [{ role: 'user', content: P.postTagsPrompt(content) }],
      json: true,
      fast: true,
      temperature: 0.4,
      maxTokens: 300,
    },
    () => localTags(content),
  );
  const tags = Array.isArray(res.data?.tags) ? res.data.tags.filter((t) => typeof t === 'string') : localTags(content);
  return tags.slice(0, 5);
}

/** 本地标签：用校园语境词表命中，无需模型 */
export function localTags(content) {
  const s = String(content || '');
  const out = [];
  const WORDS = {
    考研: ['考研', '初试', '复试', '上岸'],
    找工作: ['实习', '求职', '面试', '秋招', '春招', '简历'],
    实验室: ['实验室', '科研', '论文', '导师'],
    社团: ['社团', '学生会', '部门'],
    考试周: ['考试', '期末', '复习', '绩点'],
    运动搭子: ['跑步', '健身', '篮球', '羽毛球', '约球'],
    编程: ['代码', '编程', '项目', '开发'],
    食堂: ['食堂', '吃饭', '探店'],
    宿舍日常: ['宿舍', '室友', '寝室'],
    音乐: ['音乐', '歌', '乐队', '吉他'],
    电影: ['电影', '观影', '追剧'],
    情感: ['喜欢', '分手', '暗恋', '恋爱'],
    迷茫: ['迷茫', '焦虑', '不知道', '压力'],
  };
  for (const [tag, kws] of Object.entries(WORDS)) {
    if (kws.some((k) => s.includes(k))) out.push(tag);
  }
  return out.slice(0, 4);
}
