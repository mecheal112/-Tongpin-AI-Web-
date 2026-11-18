/**
 * 种子数据。
 *
 * 存在的意义：社交产品的价值只有在有人的时候才能被验证。
 * 一个空库的同频无法演示「AI 匹配」和「破冰」这两件核心的事。
 *
 * 这里构造 23 位有真实区分度的同学：不同学院、不同作息、不同兴趣画像、
 * 性格分布刻意覆盖内向/外向、深度/轻松、规律/随性等维度，
 * 让匹配引擎和破冰脚手架有真实的对比空间。
 *
 * 每位体验账号的登录密码统一为 Tongpin@2026（README 中已注明，供评审使用）。
 */

import bcrypt from 'bcryptjs';
import { pathToFileURL } from 'node:url';
import { migrate, getDb, run, get, all } from './index.js';
import { newId } from '../utils/helpers.js';
import { config, DEMO_PASSWORD } from '../config.js';
import { scorePersona, extractInterests, detectRhythm, extractValues, extractGoals, summarizePersona } from '../ai/local-engine.js';
import { ensureSeeded } from '../ai/interest-graph.js';
import { toJson } from './index.js';

const PROFILES = [
  {
    nickname: '林知遥', email: 'linzhiyao@tongpin.demo', gender: '女', college: '计算机学院', major: '软件工程', grade: '大三',
    bio: '写代码，也写点没用的小说。',
    contact_pref: '线上',
    text: '我是那种能在实验室待到凌晨的人，最近在做一个开源项目，经常熬夜到两三点。不太擅长社交，聚会超过五个人我就会想找借口走。但我很享受和一两个人聊很深的话题，比如为什么人会拖延、技术到底改变了什么。喜欢跑步，跑的时候脑子最清醒。最近在准备考研，压力挺大但还撑得住。我看重真诚和长期主义，讨厌无效社交。',
  },
  {
    nickname: '陈胥', email: 'chenxu@tongpin.demo', gender: '男', college: '经济管理学院', major: '工商管理', grade: '大三',
    bio: '早上六点的操场，晚上十点的图书馆。',
    contact_pref: '线下',
    text: '我是早起型，每天六点起来跑步，作息比较规律。喜欢摄影，周末经常一个人背着相机去扫街，也在做一个小红书账号。最近在准备一个创业比赛，对产品设计和商业逻辑很感兴趣。性格外向，喜欢认识新朋友，组局能力还行。我想找能一起做事的人，不只是聊天。我看重效率和成长，不太喜欢拖沓。',
  },
  {
    nickname: '苏晚', email: 'suwan@tongpin.demo', gender: '女', college: '文学院', major: '汉语言文学', grade: '大二',
    bio: '在读诗，也在逃避写论文。',
    contact_pref: '都可',
    text: '我喜欢读书，尤其是小说和散文，最近在读加缪。性格比较安静，不太主动说话，但一旦聊到喜欢的东西会停不下来。我经常emo，会为一个句子的写法纠结一整晚。喜欢民谣和独立音乐，偶尔去看livehouse。作息不太规律，经常熬夜看书。我希望找到能安静待在一起也不用尴尬的人，看重理解和陪伴。',
  },
  {
    nickname: '郑野', email: 'zhengye@tongpin.demo', gender: '男', college: '体育学院', major: '运动训练', grade: '大四',
    bio: '打球、爬山、活着。',
    contact_pref: '线下',
    text: '我基本每天泡在球场，篮球和羽毛球都打，最近在练攀岩。性格挺直的直接，不太会绕弯子，也不太懂那些细腻的情绪。早睡早起，作息极规律。喜欢户外，周末经常去徒步和露营。快毕业了，想找几个能长期一起运动的朋友，或者一起出去玩的搭子。我看重真实和信任，最讨厌说一套做一套。',
  },
  {
    nickname: '何清和', email: 'heqinghe@tongpin.demo', gender: '男', college: '物理学院', major: '理论物理', grade: '大三',
    bio: '在算一个大概算不出来的东西。',
    contact_pref: '线上',
    text: '我大部分时间在实验室和自习室，做理论物理的方向，喜欢推导和证明的感觉。作息很乱，经常通宵，凌晨效率最高。话不多，也不太会安慰人，朋友说我理性到有点冷。但我其实很在意身边的人，只是不知道怎么表达。喜欢科幻，也玩一点围棋。希望认识能聊学术也能聊别的的人，看重逻辑和独立思考。',
  },
  {
    nickname: '许南', email: 'xunan@tongpin.demo', gender: '女', college: '艺术学院', major: '视觉传达', grade: '大二',
    bio: '画画、拍照、逛展。',
    contact_pref: '都可',
    text: '我是学设计的，平时喜欢画画和插画，也在做视频剪辑。性格比较跳脱，兴趣特别广，什么都想试试，但坚持下来的不多。作息看心情，经常熬夜改稿。喜欢探店和拍vlog，周末喜欢去美术馆。我很容易跟人熟起来，但也容易聊着聊着就没下文了，希望遇到能持续聊下去的人。看重自由和创造力。',
  },
  {
    nickname: '周砚', email: 'zhouyan@tongpin.demo', gender: '男', college: '计算机学院', major: '人工智能', grade: '大四',
    bio: '在做大模型相关的研究。',
    contact_pref: '线上',
    text: '我在做NLP方向的研究，主要是大模型的应用，已经发了一篇论文。作息偏夜猫，凌晨写代码效率最高。性格中等偏内向，但讨论技术问题时话很多。喜欢打游戏，主玩策略类和桌游，也玩剧本杀。最近在准备申请出国的研究生，压力不小。想找能一起做项目或者一起打游戏的同好，看重专注和坦诚。',
  },
  {
    nickname: '孟今', email: 'mengjin@tongpin.demo', gender: '女', college: '心理学院', major: '应用心理学', grade: '大三',
    bio: '在学着理解别人，也在学着理解自己。',
    contact_pref: '都可',
    text: '我学心理学，对人的情绪和动机特别敏感，朋友都爱找我倾诉。性格温和，共情能力比较强，但有时候会因为太在意别人的感受而内耗。作息还算规律，早睡早起。喜欢烘焙和做咖啡，也喜欢写点东西记录生活。最近在准备心理咨询相关的实习。希望认识能平等相处的人，而不是只把当树洞。看重理解与边界感。',
  },
  {
    nickname: '吴阔', email: 'wukuo@tongpin.demo', gender: '男', college: '机械工程学院', major: '机械设计', grade: '大二',
    bio: '造车、修车、拆车。',
    contact_pref: '线下',
    text: '我在车队做赛车，动手能力比较强，喜欢把东西拆开看看怎么运作。性格偏安静，不太会说漂亮话，但做事靠谱。作息规律，晚上十二点前一定睡。喜欢骑行，周末经常骑几十公里。也玩一点摄影，喜欢拍机械和城市。最近在准备一个方程式赛车的比赛。想找能一起搞事情的人，看重靠谱和执行力。',
  },
  {
    nickname: '叶朝', email: 'yezhao@tongpin.demo', gender: '男', college: '外国语学院', major: '英语', grade: '大三',
    bio: '在背单词，也在背诗。',
    contact_pref: '都可',
    text: '我学英语，口语还不错，平时喜欢看原版电影和美剧。性格外向，喜欢说话也喜欢表达，班里做汇报基本都是我上。喜欢摇滚乐，自己组了个乐队弹吉他，偶尔在学校演出。作息比较乱，经常熬夜排练。最近在准备雅思，想申请交换。希望认识能一起玩音乐或者一起练口语的人，看重热情和行动力。',
  },
  {
    nickname: '时予', email: 'shiyu@tongpin.demo', gender: '女', college: '医学院', major: '临床医学', grade: '大三',
    bio: '背书背到怀疑人生，但还是想当医生。',
    contact_pref: '线上',
    text: '医学生的日常就是背书和见习，课业压力很大。我性格比较要强，也很能扛，但偶尔会有撑不住的时候。作息不太规律，值班的时候完全乱掉。喜欢看电影，尤其是纪录片，也喜欢做饭，做饭的时候最放松。最近在准备执业医师相关的考试。想找能理解我时间不固定、不会因为我回消息慢就生气的朋友。看重坚持和善意。',
  },
  {
    nickname: '顾行', email: 'guxing@tongpin.demo', gender: '男', college: '数学学院', major: '统计学', grade: '大四',
    bio: '数据里找规律，生活里找不着。',
    contact_pref: '都可',
    text: '我学统计，喜欢用数据解释问题，做过几个数据挖掘的项目。性格偏内向，不太主动社交，但熟了之后挺好相处。作息混乱，属于典型的夜猫。喜欢打德州扑克和玩桌游，也喜欢看悬疑小说。最近在准备秋招，投了几个互联网的数据岗。想找能一起刷题或者一起玩桌游的人，看重聪明和真诚。',
  },
  {
    nickname: '白露', email: 'bailu@tongpin.demo', gender: '女', college: '新闻传播学院', major: '新闻学', grade: '大二',
    bio: '在记录别人，也在记录自己。',
    contact_pref: '线下',
    text: '我在校媒做记者，喜欢采访和写稿，觉得把人写清楚是件很难也很迷人的事。性格开朗，很主动，采访过很多陌生人。作息还行，但赶稿的时候会通宵。喜欢看电影和话剧，也喜欢逛书店。最近在做一个关于校园孤独感的选题，想多听听不同人的故事。看重好奇心与共情。',
  },
  {
    nickname: '卫舟', email: 'weizhou@tongpin.demo', gender: '男', college: '环境学院', major: '环境工程', grade: '大三',
    bio: '想为这个星球做点小事。',
    contact_pref: '都可',
    text: '我关注环保，参加过几次河流清理和垃圾分类的志愿活动，也在做一个校园减塑的项目。性格温和，不是特别外向但也不社恐。作息比较规律，坚持早睡早起。喜欢徒步和露营，也喜欢做饭。最近在准备一个环保公益的竞赛。想找愿意一起做公益的人，看重责任感和长期主义。',
  },
  {
    nickname: '南栀', email: 'nanzhi@tongpin.demo', gender: '女', college: '音乐学院', major: '音乐表演', grade: '大三',
    bio: '练琴、听曲、发呆。',
    contact_pref: '线上',
    text: '我主修钢琴，每天练琴四五个小时。性格比较安静，喜欢独处，也需要独处。作息规律，早睡早起，早上是练琴效率最高的时候。喜欢古典乐，也听一点爵士。喜欢看书和写日记。不太擅长社交场合，但很希望能有一两个可以聊很久的朋友。看重专注和内心的丰富。',
  },
  {
    nickname: '方程', email: 'fangcheng@tongpin.demo', gender: '男', college: '计算机学院', major: '计算机科学', grade: '大二',
    bio: '刷题、打比赛、写博客。',
    contact_pref: '线上',
    text: '我在打ACM，平时主要在刷算法题，也在写技术博客。作息是典型的夜猫，经常通宵打完比赛直接睡到中午。性格偏安静，不太会说场面话，但在自己擅长的领域话会变多。喜欢打游戏，主要是竞技类。想找能一起组队打比赛或者一起做项目的人，看重实力和认真。',
  },
  {
    nickname: '温禾', email: 'wenhe@tongpin.demo', gender: '女', college: '农业学院', major: '园艺', grade: '大二',
    bio: '在种花，也在种自己。',
    contact_pref: '线下',
    text: '我在学校的植物园帮忙，平时喜欢种花养草。性格很平和，不太焦虑，朋友说跟我在一起很放松。作息规律，早睡早起，喜欢清晨。喜欢做饭和烘焙，也喜欢慢跑。喜欢看纪录片和写植物笔记。最近在做毕业花坛的设计方案。想认识愿意慢下来的人，看重平和与耐心。',
  },
  {
    nickname: '楚河', email: 'chuhe@tongpin.demo', gender: '男', college: '法学院', major: '法学', grade: '大四',
    bio: '在背法条，也在辩真理。',
    contact_pref: '都可',
    text: '我学法学，参加过模拟法庭和辩论赛，说话比较有条理，也喜欢争论。性格外向偏强势，不太喜欢含糊其辞。作息规律，早睡早起。喜欢看历史书和政论节目，也喜欢下棋。最近在准备法考，压力很大。想找能接受我直率、也能跟我据理力争的朋友，看重原则和思辨。',
  },
  {
    nickname: '宋听', email: 'songting@tongpin.demo', gender: '女', college: '教育学院', major: '教育学', grade: '大三',
    bio: '未来想当老师。',
    contact_pref: '都可',
    text: '我学教育学，做过几次支教的志愿活动，很喜欢和小孩相处。性格温和，共情能力比较强，是比较典型的倾听者。作息比较规律。喜欢做手工和画画，也喜欢爬山。最近在准备教师资格证的考试。想找能一起做志愿或者一起爬山的朋友，看重善意和耐心。',
  },
  {
    nickname: '陆离', email: 'luli@tongpin.demo', gender: '男', college: '艺术学院', major: '数字媒体', grade: '大三',
    bio: '做游戏，也想做点别的。',
    contact_pref: '线上',
    text: '我学数字媒体，主要做游戏设计和交互设计，参与过一个独立游戏的开发。性格有点飘忽，兴趣变得快，喜欢尝试新东西。作息混乱，经常熬到早上。喜欢玩游戏，尤其是独立游戏和叙事类游戏，也喜欢看电影。最近在做一个自己的小项目。想找能一起做游戏或者能忍受我跳脱的人，看重创意和好奇心。',
  },
  {
    nickname: '安和', email: 'anhe@tongpin.demo', gender: '女', college: '公共卫生学院', major: '预防医学', grade: '大二',
    bio: '在做健康科普，很认真那种。',
    contact_pref: '都可',
    text: '我学预防医学，平时会做健康科普的公众号，也参加过几次献血和义诊的志愿活动。性格比较温和，但聊到专业问题会很认真。作息规律，早睡早起。喜欢跑步和瑜伽，也喜欢做饭。最近在做一个关于大学生睡眠的调查。想找能一起运动或者一起做科普的人，看重认真和善意。',
  },
  {
    nickname: '江舟', email: 'jiangzhou@tongpin.demo', gender: '男', college: '哲学学院', major: '哲学', grade: '大三',
    bio: '在想一些没用但重要的问题。',
    contact_pref: '线上',
    text: '我学哲学，喜欢思考一些抽象的问题，比如什么是好的生活、人为什么会焦虑。性格偏内向，话不多，但一旦聊到感兴趣的话题会聊很久很深入。作息极其混乱，经常通宵看书，白天补觉。喜欢看文艺片和读小说，也写一点东西。最近在读存在主义。想找能聊得深的人，看重诚实和思想，最讨厌寒暄。',
  },
  {
    nickname: '骆晴', email: 'luoqing@tongpin.demo', gender: '女', college: '商学院', major: '市场营销', grade: '大三',
    bio: '在找实习，也在找自己。',
    contact_pref: '线下',
    text: '我学市场营销，做过几段实习，比较懂怎么跟人打交道。性格外向，很会活跃气氛，朋友很多但深交的不多。作息还算规律。喜欢探店、喝咖啡、拍照，也喜欢逛街和看展。最近在准备秋招，投了很多快消和互联网的市场岗。想找能聊点真心话的人，不只是社交场上的客套。看重真诚和有想法。',
  },
];

const POSTS = [
  { author: 0, content: '凌晨两点，代码终于跑通了。虽然明天还有早八，但此刻的快乐是真的。', topics: ['编程', '宿舍日常'] },
  { author: 1, content: '六点的操场只有我和几个大爷。跑完五公里，今天也是清醒的一天。', topics: ['跑步', '早起'] },
  { author: 2, content: '读完了《局外人》，合上书发了很久的呆。有人愿意聊聊默尔索到底是不是冷漠吗？', topics: ['阅读', '文学'] },
  { author: 4, content: '算了一晚上的积分，最后发现是题目抄错了。科研的快乐和痛苦都在这了。', topics: ['科研', '实验室日常'] },
  { author: 7, content: '今天做了第三次模拟咨询，来访者说「跟你聊完轻松多了」。这句话让我觉得选这个专业是对的。', topics: ['心理学', '实习'] },
  { author: 5, content: '咖啡拉花终于有点样子了。虽然还是歪的，但比上周进步了。', topics: ['咖啡', '日常'] },
  { author: 10, content: '临床见习第一天，跟着老师查房。站了六个小时，腿废了，但还是很想干这行。', topics: ['医学生', '见习'] },
  { author: 12, content: '做了一期关于「大学生孤独感」的采访，前后聊了二十多个人。原来不是只有我一个人这样觉得。', topics: ['采访', '情感'] },
  { author: 14, content: '练琴的时候最容易忘记时间。今天把肖邦的夜曲磨了三遍，终于有点味道了。', topics: ['音乐', '练琴'] },
  { author: 17, content: '模拟法庭拿了最佳辩手，但更开心的是对手赛后过来跟我讨论了一个小时的法理问题。', topics: ['法学', '辩论'] },
  { author: 15, content: '今天组队赛又掉分了。感觉配合还是有问题，有没有人愿意一起练练？', topics: ['游戏', '组队'] },
  { author: 3, content: '今天攀岩终于过了那条5.11a，手都磨破了，值。', topics: ['攀岩', '运动'] },
  { author: 20, content: '做了个梦，梦见自己在跟康德吵架。醒来发现是室友在打呼噜。', topics: ['哲学', '宿舍日常'] },
  { author: 6, content: '论文终于投出去了。等审稿的这段时间大概是最煎熬的。', topics: ['科研', '论文'] },
  { author: 22, content: '秋招第一面挂了，复盘了一晚上。感觉简历没问题，是我讲项目的方式不对。', topics: ['求职', '实习'] },
  { author: 8, content: '车队的新车第一次试跑，虽然只跑了两圈就出故障了，但这两圈等了半年。', topics: ['赛车', '社团'] },
  { author: 19, content: '独立游戏的第一版demo做完了，虽然很粗糙。想让几个人试玩一下给点意见，有人感兴趣吗？', topics: ['游戏开发', '找搭子'] },
  { author: 18, content: '支教的时候有个小孩问我大学是什么样。我想了很久，不知道怎么跟他说。', topics: ['支教', '志愿']},
  { author: 11, content: '数分考完了，感觉人生一片灰暗。有没有人一起抱团取暖。', topics: ['考试', '数学'] },
  { author: 13, content: '今天捡了两袋垃圾，河边的塑料比想象中多太多。做了个统计，准备写进项目报告。', topics: ['环保', '志愿'] },
];

function buildPersona(text) {
  const vector = scorePersona(text);
  const interests = extractInterests(text);
  const rhythm = detectRhythm(text);
  const values = extractValues(text);
  const goals = extractGoals(text);
  return {
    vector,
    interests,
    values,
    goals,
    rhythm,
    summary: summarizePersona({ vector, interests, rhythm, values }),
    ideal_match: interests.length
      ? `同样对${interests.slice(0, 2).map((i) => i.name).join('、')}感兴趣，${values[0] ? `也在意${values[0]}，` : ''}聊得来也约得动的人`
      : '聊得来、节奏合拍的人',
    raw_text: text,
  };
}

/**
 * 兴趣图谱种子数据。
 *
 * 画像在 seed 里是直接 SQL 落库的，不走 savePersona 的抽取钩子——
 * 那个钩子是 fire-and-forget 异步，种子进程退出前可能还没跑完，
 * 而且结果依赖是否配了 AI Key。这里同步、确定性地把画像兴趣写进图谱：
 * user_interests 带访谈证据，同批兴趣两两连共现边。
 */
function seedGraph(userId, persona, createdAt) {
  const nodeIds = [];
  for (const it of persona.interests.slice(0, 5)) {
    let row = get('SELECT id FROM interest_nodes WHERE name = ?', it.name);
    if (!row) {
      const id = newId('nd');
      run(
        `INSERT INTO interest_nodes (id,name,aliases,category,parent_id,status,created_at) VALUES (?,?,?,?,NULL,'confirmed',?)`,
        id, it.name, '[]', it.name, createdAt,
      );
      row = { id };
    }
    nodeIds.push(row.id);
    run(
      'INSERT OR REPLACE INTO user_interests (user_id,node_id,weight,evidence,updated_at) VALUES (?,?,?,?,?)',
      userId, row.id, it.weight,
      toJson([{ source_type: 'interview', source_id: 'seed', quote: persona.raw_text.slice(0, 80), at: createdAt }]),
      createdAt,
    );
  }
  for (let i = 0; i < nodeIds.length; i += 1) {
    for (let j = i + 1; j < nodeIds.length; j += 1) {
      const [a, b] = nodeIds[i] < nodeIds[j] ? [nodeIds[i], nodeIds[j]] : [nodeIds[j], nodeIds[i]];
      run(
        `INSERT INTO interest_edges (from_node,to_node,type,weight) VALUES (?,?,?,1)
         ON CONFLICT(from_node,to_node,type) DO UPDATE SET weight = weight + 1`,
        a, b, 'co_occurs',
      );
    }
  }
}

export async function seed({ verbose = true } = {}) {
  migrate();
  const db = getDb();

  const existing = get('SELECT COUNT(*) AS n FROM users').n;
  if (existing > 0) {
    if (verbose) console.log(`[seed] 已有 ${existing} 个用户，跳过。如需重建请先执行 npm run reset`);
    return { skipped: true };
  }

  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const now = Date.now();
  const userIds = [];
  ensureSeeded(); // 14 类规范节点先落库，图谱种子数据才有归属

  for (let i = 0; i < PROFILES.length; i += 1) {
    const p = PROFILES[i];
    const id = newId('u');
    userIds.push(id);
    // 让注册时间分散开，更像真实社区
    const createdAt = now - (PROFILES.length - i) * 3600 * 1000 * 7;

    run(
      `INSERT INTO users (id,email,password_hash,nickname,school,college,major,grade,gender,bio,contact_pref,role,is_demo,status,persona_stage,created_at,last_active_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, p.email, hash, p.nickname, '示例大学', p.college, p.major, p.grade, p.gender, p.bio, p.contact_pref,
      i === 0 ? 'admin' : 'user', 1, 'active', 2, createdAt, now - i * 60000,
    );

    const persona = buildPersona(p.text);
    run(
      `INSERT INTO personas (user_id,vector,interests,values_json,goals,rhythm,summary,ideal_match,raw_text,version,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id, toJson(persona.vector), toJson(persona.interests), toJson(persona.values), toJson(persona.goals),
      persona.rhythm, persona.summary, persona.ideal_match, persona.raw_text, 1, createdAt,
    );
    seedGraph(id, persona, createdAt);
  }

  if (verbose) console.log(`[seed] 已创建 ${PROFILES.length} 位同学及其画像`);

  // 动态
  for (let i = 0; i < POSTS.length; i += 1) {
    const post = POSTS[i];
    const id = newId('po');
    const createdAt = now - (POSTS.length - i) * 3600 * 1000 * 5;
    const authorId = userIds[post.author];
    run(
      `INSERT INTO posts (id,author_id,content,topics,mod_status,mod_reason,mod_score,ai_tags,like_count,comment_count,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id, authorId, post.content, toJson(post.topics), 'ok', '', 0, toJson(post.topics),
      Math.floor(Math.random() * 18) + 2, 0, createdAt,
    );

    // 随机点赞
    const likers = new Set();
    const likeN = Math.floor(Math.random() * 8) + 1;
    while (likers.size < Math.min(likeN, userIds.length - 1)) {
      const idx = Math.floor(Math.random() * userIds.length);
      if (userIds[idx] !== authorId) likers.add(userIds[idx]);
    }
    for (const uid of likers) {
      run('INSERT OR IGNORE INTO post_likes (post_id,user_id,created_at) VALUES (?,?,?)', id, uid, createdAt + 1000);
    }

    // 部分动态带评论
    if (i % 3 === 0) {
      const comments = ['同感，我也是这样', '加油，会好起来的', '太真实了哈哈哈哈', '羡慕，我做不到'];
      const n = Math.floor(Math.random() * 3) + 1;
      for (let k = 0; k < n; k += 1) {
        const commenterIdx = Math.floor(Math.random() * userIds.length);
        if (userIds[commenterIdx] === authorId) continue;
        run(
          'INSERT INTO comments (id,post_id,author_id,content,mod_status,created_at) VALUES (?,?,?,?,?,?)',
          newId('cm'), id, userIds[commenterIdx], comments[k % comments.length], 'ok', createdAt + 3600000 * (k + 1),
        );
        run('UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?', id);
      }
    }
  }

  if (verbose) console.log(`[seed] 已创建 ${POSTS.length} 条动态及互动`);

  // 同频局
  const GROUPS = [
    { owner: 0, title: '一起刷算法题冲ACM', category: '竞赛组队', desc: '每周固定两次线上刷题，目标是把常见题型打穿。基础不限，能坚持就行。', wanted: '愿意花时间、有耐心debug的人', capacity: 5 },
    { owner: 3, title: '周末爬山搭子', category: '运动健身', desc: '每周六早上出发，周边山都爬。强度中等，主要是想找人一起。', wanted: '体力还行、不磨叽的人', capacity: 8 },
    { owner: 7, title: '心理学读书会', category: '学习搭子', desc: '两周一本，线上讨论。最近在读《被讨厌的勇气》。', wanted: '愿意认真读完再讨论的人', capacity: 10 },
    { owner: 5, title: '独立游戏试玩小组', category: '兴趣同好', desc: '我做了一个demo，想找人试玩给反馈。互相试玩也行。', wanted: '玩过独立游戏、能给具体意见的人', capacity: 6 },
    { owner: 13, title: '校园减塑项目招人', category: '志愿公益', desc: '在推动食堂减少一次性餐具。需要做调研、设计和对外沟通的人。', wanted: '有环保想法、能做实事的人', capacity: 8 },
    { owner: 10, title: '医学生抱团自习', category: '学习搭子', desc: '期末一起在图书馆占座，互相监督。主要是需要有人盯着我。', wanted: '自律、能早起的人', capacity: 6 },
  ];

  for (const g of GROUPS) {
    const id = newId('gp');
    const ts = now - Math.floor(Math.random() * 5) * 86400000;
    run(
      `INSERT INTO groups (id,owner_id,title,description,category,wanted,capacity,meet_at,location,is_online,status,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, userIds[g.owner], g.title, g.desc, g.category, g.wanted, g.capacity,
      ts + 86400000 * 3, '示例大学', g.category === '运动健身' || g.category === '志愿公益' ? 0 : 1, 'open', ts,
    );
    run('INSERT INTO group_members (group_id,user_id,role,joined_at) VALUES (?,?,?,?)', id, userIds[g.owner], 'owner', ts);

    const extra = Math.floor(Math.random() * 4);
    for (let k = 0; k < extra; k += 1) {
      const idx = Math.floor(Math.random() * userIds.length);
      const exists = get('SELECT 1 AS x FROM group_members WHERE group_id = ? AND user_id = ?', id, userIds[idx]);
      if (!exists) {
        run('INSERT INTO group_members (group_id,user_id,role,joined_at) VALUES (?,?,?,?)', id, userIds[idx], 'member', ts + 3600000);
      }
    }
  }

  if (verbose) console.log(`[seed] 已创建 ${GROUPS.length} 个同频局`);

  if (verbose) {
    console.log('');
    console.log('  体验账号（密码统一为 ' + DEMO_PASSWORD + '）');
    console.log('  ─────────────────────────────────────────────');
    console.log('   管理员   ' + PROFILES[0].email + '   ' + PROFILES[0].nickname + '（' + PROFILES[0].major + '）');
    console.log('   普通用户 ' + PROFILES[1].email + '   ' + PROFILES[1].nickname + '（' + PROFILES[1].major + '）');
    console.log('   普通用户 ' + PROFILES[2].email + '   ' + PROFILES[2].nickname + '（' + PROFILES[2].major + '）');
    console.log('  ─────────────────────────────────────────────');
    console.log('   其余 ' + (PROFILES.length - 3) + ' 个账号见 /api/auth/demo-accounts');
    console.log('');
  }

  return { skipped: false, users: PROFILES.length };
}

// 直接执行时运行（用 pathToFileURL 做比较，兼容 Windows 盘符路径）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seed().then(() => process.exit(0)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
