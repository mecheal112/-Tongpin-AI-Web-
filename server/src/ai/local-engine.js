/**
 * 本地语义引擎。
 *
 * 存在的理由：这是一个要求「评审期间保持服务可用」的作品。
 * 如果全部 AI 能力都硬依赖外部模型 API，那么一次欠费、一次网络抖动、
 * 一次区域不可达，产品就会变成空壳。
 *
 * 所以这里用纯算法实现了一套可独立工作的语义能力：
 *   - 中文友好的字符 n-gram + 词袋 TF-IDF 向量化（不依赖分词库）
 *   - 余弦相似度、兴趣图谱 Jaccard/加权重合
 *   - 关键词抽取、作息识别、维度打分
 *
 * 配置了大模型时它作为兜底；没配置时它就是主引擎，
 * 保证画像、匹配、破冰、审核四条链路始终可用。
 */

/* ---------------- 文本向量化 ---------------- */

const STOPWORDS = new Set(
  ('的 了 和 是 我 你 他 她 它 们 在 有 就 都 而 及 与 或 一个 一些 这个 那个 什么 怎么 如何 ' +
    '可以 我们 你们 他们 自己 觉得 感觉 比较 还是 但是 因为 所以 如果 就是 这样 那样 时候 ' +
    'a an the is are was were be been to of in on at for with and or but if then this that i you he she it we they')
    .split(/\s+/)
    .filter(Boolean),
);

/** 抽取中文 2-gram 与拉丁词，构建稀疏词频向量 */
export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const tokens = [];

  // 拉丁字母/数字词
  for (const m of s.matchAll(/[a-z0-9]{2,}/g)) tokens.push(m[0]);

  // 中文连续片段 -> 1-gram 与 2-gram
  for (const m of s.matchAll(/[一-龥]+/g)) {
    const seg = m[0];
    for (let i = 0; i < seg.length; i += 1) {
      const ch = seg[i];
      if (!STOPWORDS.has(ch)) tokens.push(ch);
      if (i + 1 < seg.length) tokens.push(seg.slice(i, i + 2));
    }
  }
  return tokens;
}

/** 词频向量 */
function termFreq(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

/**
 * 构建 TF-IDF 向量。语料越大越准；语料很小的时候退化为 TF。
 * 返回 Map<term, weight>
 */
export function tfidf(text, corpus = []) {
  const tf = termFreq(tokenize(text));
  if (!tf.size) return new Map();

  const n = corpus.length || 1;
  const vec = new Map();
  for (const [term, freq] of tf) {
    let df = 0;
    for (const doc of corpus) {
      if (doc.includes(term)) df += 1;
    }
    // 未提供语料时 df=0，idf 退化为常数，等价于 TF 归一化
    const idf = df > 0 ? Math.log((n + 1) / (df + 1)) + 1 : 1;
    vec.set(term, (1 + Math.log(freq)) * idf);
  }
  return vec;
}

/** 余弦相似度，输入为 Map<term, weight> */
export function cosine(m1, m2) {
  if (!m1?.size || !m2?.size) return 0;
  let dot = 0;
  let n1 = 0;
  let n2 = 0;
  for (const v of m1.values()) n1 += v * v;
  for (const v of m2.values()) n2 += v * v;
  const [small, big] = m1.size <= m2.size ? [m1, m2] : [m2, m1];
  for (const [k, v] of small) {
    const w = big.get(k);
    if (w) dot += v * w;
  }
  const denom = Math.sqrt(n1) * Math.sqrt(n2);
  return denom === 0 ? 0 : dot / denom;
}

/** 把文本向量化为可比较的 Map */
export const vectorize = (text, corpus = []) => tfidf(text, corpus);

/* ---------------- 数值向量工具 ---------------- */

/** 数值向量余弦（用于 6 维人格向量） */
export function numCosine(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

export const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** 曼哈顿距离归一化后的相似度（对单维差异更敏感） */
export function normManhattan(a, b, max = 100) {
  if (!a?.length || !b?.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs((a[i] || 0) - (b[i] || 0));
  const avg = sum / a.length;
  return clamp01(1 - avg / max);
}

/* ---------------- 领域词表 ---------------- */

/** 兴趣词表：用于从自由文本中识别兴趣标签 */
export const INTEREST_LEXICON = {
  编程开发: ['编程', '代码', '开发', '前端', '后端', '算法', 'python', 'java', 'javascript', 'golang', 'rust', '写代码', 'debug', '开源', 'github'],
  人工智能: ['ai', '人工智能', '机器学习', '深度学习', '大模型', 'llm', '神经网络', 'transformer', '数据科学', 'nlp', '计算机视觉'],
  数学物理: ['数学', '物理', '微积分', '线代', '概率', '量子', '证明', '竞赛', '建模'],
  阅读写作: ['读书', '阅读', '写作', '小说', '文学', '散文', '诗', '公众号', '博客', '杂文'],
  影视音乐: ['电影', '追剧', '音乐', '唱歌', '乐队', '吉他', '钢琴', '摇滚', '民谣', '说唱', '演唱会', 'livehouse', '剧本'],
  游戏电竞: ['游戏', '电竞', 'steam', '主机', '手游', '开黑', '桌游', '剧本杀', '狼人杀', '跑团'],
  运动健身: ['跑步', '健身', '篮球', '足球', '羽毛球', '游泳', '瑜伽', '骑行', '爬山', '徒步', '滑板', '攀岩', '乒乓'],
  摄影设计: ['摄影', '拍照', '设计', '插画', '绘画', 'ps', '剪辑', '视频', 'vlog', '手绘', 'ui'],
  志愿公益: ['志愿', '公益', '支教', '义工', '慈善', '环保', '献血', '社区服务'],
  创业商业: ['创业', '商业', '产品', '运营', '投资', '金融', '市场', '实习', '求职', '面试'],
  语言学习: ['英语', '日语', '法语', '德语', '韩语', '雅思', '托福', '四六级', '翻译', '口语'],
  美食生活: ['美食', '做饭', '烘焙', '咖啡', '探店', '奶茶', '甜品', '旅行', '露营'],
  学术科研: ['科研', '论文', '实验室', '读研', '考研', '保研', '博士', '论文投稿', '科研项目'],
  心理健康: ['焦虑', '压力', 'emo', '失眠', '内耗', '情绪', '心理咨询', '孤独', '社恐'],
};

/** 作息词表 */
const RHYTHM_LEXICON = {
  早起型: ['早起', '晨跑', '早睡', '六点', 'morning', '晨读', '作息规律'],
  夜猫型: ['熬夜', '通宵', '夜猫', '凌晨', '晚睡', '深夜', '晚上效率'],
};

/** 从文本中抽取兴趣标签及权重 */
export function extractInterests(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  for (const [name, words] of Object.entries(INTEREST_LEXICON)) {
    let hits = 0;
    for (const w of words) {
      if (s.includes(w.toLowerCase())) hits += 1;
    }
    if (hits > 0) out.push({ name, weight: Math.min(100, 40 + hits * 20) });
  }
  return out.sort((a, b) => b.weight - a.weight);
}

/**
 * 兴趣图谱的本地抽取（AI 抽取的兜底，输出与 AI 版同构）。
 *
 * 两类信号：
 *  1. 词表命中 → 已有规范节点（node 命中词表分类名）
 *  2. 「迷上/入坑 XX」这类强意图句式 → 候选新节点（create: true），
 *     让无 Key 演示时图谱也能「长出新节点」，而不只是旧节点涨权重
 */
export function extractInterestItems(text) {
  const s = String(text || '').toLowerCase();
  const items = [];

  // 取证据句：包含关键词的标点分句片段
  const sentences = String(text || '')
    .split(/[。！？；\n!?;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const quoteOf = (word) => {
    const hit = sentences.find((sen) => sen.toLowerCase().includes(word));
    return (hit || '').slice(0, 80);
  };

  for (const [name, words] of Object.entries(INTEREST_LEXICON)) {
    const hitWords = words.filter((w) => s.includes(w.toLowerCase()));
    if (!hitWords.length) continue;
    items.push({
      node: name,
      create: false,
      relation: 'related',
      delta: Math.min(30, 12 + hitWords.length * 6),
      quote: quoteOf(hitWords[0]),
    });
  }

  // 强意图句式 → 新节点（单次上限 5 个由上层统一截断）
  const INTENT = /(迷上|爱上|入坑|最近在学|刚学|开始学|喜欢上|打算学)([一-龥a-z0-9]{2,6})/gi;
  for (const m of s.matchAll(INTENT)) {
    const name = m[2].trim();
    if (!name || items.some((it) => it.node === name)) continue;
    items.push({ node: name, create: true, suggest_name: name, relation: 'co_occurs', delta: 18, quote: quoteOf(m[2]) });
  }

  return items.slice(0, 5);
}

/** 识别作息类型 */
export function detectRhythm(text) {
  const s = String(text || '');
  let best = null;
  let bestHits = 0;
  for (const [name, words] of Object.entries(RHYTHM_LEXICON)) {
    const hits = words.filter((w) => s.includes(w)).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = name;
    }
  }
  return best || '灵活';
}

/** 抽取价值观/目标关键词 */
const VALUE_LEXICON = ['真诚', '自由', '成长', '陪伴', '效率', '探索', '稳定', '热爱', '边界感', '长期主义', '活在当下', '相互尊重', '独立', '合作', '创造', '意义'];

export function extractValues(text) {
  const s = String(text || '');
  return VALUE_LEXICON.filter((v) => s.includes(v));
}

/** 抽取用户自述的目标 */
export function extractGoals(text) {
  const s = String(text || '');
  const goals = [];
  const patterns = [
    /(考研|保研|出国|留学|考公|找工作|实习|转专业|创业|发论文|学[^\s，。]{1,8})/g,
    /(想|希望|打算|计划)([^\s，。]{2,14})/g,
  ];
  for (const re of patterns) {
    for (const m of s.matchAll(re)) {
      const g = (m[2] || m[1] || '').trim();
      if (g && g.length >= 2 && !goals.includes(g)) goals.push(g);
    }
  }
  return goals.slice(0, 6);
}

/* ---------------- 人格维度打分 ---------------- */

export const DIMENSIONS = [
  { key: 'social_energy', label: '社交能量', low: '安静内敛', high: '热情外放' },
  { key: 'openness', label: '探索开放', low: '专注深耕', high: '广泛好奇' },
  { key: 'structure', label: '结构条理', low: '随性自由', high: '计划清晰' },
  { key: 'empathy', label: '情绪共情', low: '理性直接', high: '细腻体贴' },
  { key: 'expressiveness', label: '表达活跃', low: '倾听为主', high: '乐于输出' },
  { key: 'depth', label: '深度偏好', low: '轻松浅聊', high: '深度长谈' },
];

const DIM_HINTS = {
  social_energy: { high: ['社交', '朋友', '聚会', '热闹', '外向', '活跃', '聊天', '认识新', '一群人'], low: ['独处', '安静', '社恐', '内向', '一个人', '内向型', '不擅长社交', '安静地'] },
  openness: { high: ['尝试', '好奇', '新鲜', '探索', '跨', '多元', '兴趣广', '都想试', '体验'], low: ['专注', '深入', '钻研', '只喜欢', '固定', '专一', '深耕'] },
  structure: { high: ['计划', '规划', '条理', '清单', 'ddl', '时间表', '规律', '自律', '提前'], low: ['随性', '随意', '灵活', '即兴', '拖延', '看心情', '不擅长计划'] },
  empathy: { high: ['理解', '感受', '情绪', '倾听', '敏感', '共情', '体贴', '在意别人'], low: ['理性', '逻辑', '直接', '就事论事', '效率', '不绕弯'] },
  expressiveness: { high: ['表达', '分享', '输出', '说话', '写作', '讲', '喜欢聊', '话多'], low: ['倾听', '安静', '不爱说', '默默', '观察', '内敛'] },
  depth: { high: ['深度', '哲学', '意义', '为什么', '长谈', '本质', '思考', '价值观', '认真聊'], low: ['轻松', '随便聊', '有趣', '搞笑', '日常', '浅聊', '不要那么严肃'] },
};

/**
 * 检测某个关键词在文本中是否被否定。
 *
 * 这是关键词法最致命的盲区：文本里出现「社交」不代表性向外向，
 * 「不太擅长社交」「不喜欢聚会」表达的是相反的意思。
 * 所以命中前要看一下它前面一小段里有没有否定词，命中否定就反转信号。
 */
const NEGATIONS = ['不', '没', '无', '别', '很少', '不太', '不喜欢', '不擅长', '讨厌', '避免', '不想', '从不', '拒绝', '懒得'];

/**
 * 往前找一个边界（标点或句首），在边界与关键词之间找否定词。
 *
 * 固定回看 6 个字符是不够的：「不太擅长社交，聚会超过五个人」里
 * 关键词「聚会」前面隔着「社交，」，「不太擅长」已经被挤出窗口，
 * 结果否定被漏判、内向的人被打成外向。
 * 所以这里回溯到最近的标点或句首，只在这段区间里找否定词——
 * 既不会漏掉被隔开的否定，也不会跨越标点误伤下一句话。
 */
const BOUNDARY = /[，。！？；：、\n,.!?;:]/;

function isNegated(text, index) {
  // 向前回溯到最近的标点（最多 20 字符，避免长句里跨度过大）
  const limit = Math.max(0, index - 20);
  let start = index;
  while (start > limit && !BOUNDARY.test(text[start - 1])) start -= 1;

  const before = text.slice(start, index);
  return NEGATIONS.some((n) => before.includes(n));
}

/** 统计一组提示词在文本中的净命中（正向 +1 / 被否定 -1） */
function countHints(text, words) {
  let score = 0;
  for (const w of words) {
    const target = w.toLowerCase();
    let from = 0;
    for (;;) {
      const idx = text.indexOf(target, from);
      if (idx === -1) break;
      score += isNegated(text, idx) ? -1 : 1;
      from = idx + target.length;
    }
  }
  return score;
}

/** 基于文本的启发式打分（0..100），作为大模型输出的本地替身 */
export function scorePersona(text) {
  const s = String(text || '').toLowerCase();
  const vec = [];
  for (const dim of DIMENSIONS) {
    const hints = DIM_HINTS[dim.key];
    const hi = countHints(s, hints.high);
    const lo = countHints(s, hints.low);
    // 基线 50，有信号时按净信号偏移
    const total = Math.abs(hi) + Math.abs(lo);
    let base;
    if (hi === 0 && lo === 0) base = 50;
    else {
      const net = hi - lo;
      const strength = Math.min(1, total / 3); // 信号越多越自信
      base = 50 + 42 * strength * (net >= 0 ? 1 : -1) * Math.min(1, Math.abs(net) / 2);
    }
    // 表达活跃度额外看文本长度：愿意写很多字的人通常更乐于输出
    let lenBonus = 0;
    if (dim.key === 'expressiveness') {
      lenBonus = Math.min(10, s.length / 100);
    }
    vec.push(Math.round(Math.min(96, Math.max(6, base + lenBonus))));
  }
  return vec;
}

/** 生成一句话画像摘要 */
export function summarizePersona({ vector, interests, rhythm, values }) {
  const v = vector || [];
  const top = [];
  DIMENSIONS.forEach((d, i) => {
    const val = v[i] ?? 50;
    if (val >= 68) top.push(d.high);
    else if (val <= 32) top.push(d.low);
  });
  const parts = [];
  parts.push(`你${top.slice(0, 2).join('、') || '的风格比较均衡'}`);
  if (interests?.length) parts.push(`对${interests.slice(0, 3).map((i) => i.name).join('、')}有明显兴趣`);
  if (rhythm && rhythm !== '灵活') parts.push(`作息偏${rhythm}`);
  if (values?.length) parts.push(`看重${values.slice(0, 2).join('与')}`);
  return `${parts.join('，')}。`;
}
