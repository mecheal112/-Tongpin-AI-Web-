<script setup lang="ts">
/**
 * 管理后台。
 * 除了常规的用户/内容管理，这里专门暴露 AI 运行观测：
 * 各条 AI 链路的调用量、延迟、失败率，以及按匹配分档的互动率 ——
 * 后者用来验证匹配算法是不是真的预测了连接，而不是自我感觉良好。
 */
import { onMounted, ref } from 'vue';
import { adminApi } from '@/api';
import { useToast } from '@/lib/toast';

const { ok, error } = useToast();

const tab = ref<'overview' | 'users' | 'posts' | 'reports' | 'ai'>('overview');
const loading = ref(true);

const stats = ref<any>(null);
const aiStatus = ref<any>(null);
const matchQuality = ref<any[]>([]);
const scaffoldStats = ref<any[]>([]);
const users = ref<any[]>([]);
const posts = ref<any[]>([]);
const reports = ref<any[]>([]);
const aiLogs = ref<any[]>([]);
const aiByTask = ref<any[]>([]);
const search = ref('');

onMounted(loadAll);

async function loadAll() {
  loading.value = true;
  try {
    const s = await adminApi.stats();
    stats.value = s.stats;
    aiStatus.value = s.ai;
    const [q, u, p, r, l] = await Promise.all([
      adminApi.matchQuality(),
      adminApi.users(),
      adminApi.posts(),
      adminApi.reports(),
      adminApi.aiLogs(),
    ]);
    matchQuality.value = q.buckets || [];
    scaffoldStats.value = q.scaffoldStats || [];
    users.value = u.users || [];
    posts.value = p.posts || [];
    reports.value = r.reports || [];
    aiLogs.value = l.logs || [];
    aiByTask.value = l.byTask || [];
  } catch (e: any) {
    error(e?.message || '加载失败（需要管理员权限）');
  } finally {
    loading.value = false;
  }
}

async function searchUsers() {
  try {
    const res = await adminApi.users(search.value);
    users.value = res.users || [];
  } catch (e: any) {
    error(e?.message || '搜索失败');
  }
}

async function setStatus(u: any, status: string) {
  try {
    await adminApi.setUserStatus(u.id, status);
    u.status = status;
    ok(`已设为${status === 'active' ? '正常' : status === 'muted' ? '禁言' : '封禁'}`);
  } catch (e: any) {
    error(e?.message || '操作失败');
  }
}

async function moderatePost(p: any, status: string) {
  try {
    await adminApi.moderatePost(p.id, status);
    p.mod_status = status;
    ok('已更新');
  } catch (e: any) {
    error(e?.message || '操作失败');
  }
}

async function resolveReport(r: any, status: string) {
  try {
    await adminApi.resolveReport(r.id, status);
    r.status = status;
    ok('已处理');
  } catch (e: any) {
    error(e?.message || '操作失败');
  }
}

function relTime(ts: number) {
  const d = Date.now() - ts;
  if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
  return `${Math.floor(d / 86400000)} 天前`;
}

const STATUS_LABEL: Record<string, string> = { active: '正常', muted: '禁言', banned: '封禁' };
</script>

<template>
  <div class="page wide">
    <div class="page-head">
      <div>
        <h1 class="page-title">管理后台</h1>
        <p class="page-sub">
          AI 引擎：<b>{{ aiStatus?.configured ? `${aiStatus.provider} / ${aiStatus.model}` : '本地语义引擎' }}</b>
          <span v-if="!aiStatus?.configured" class="dim">（未配置模型 API，功能仍完整可用）</span>
        </p>
      </div>
    </div>

    <div class="tag-row mb-3">
      <button v-for="t in [
        { k: 'overview', l: '概览' },
        { k: 'users', l: '用户' },
        { k: 'posts', l: '内容' },
        { k: 'reports', l: '举报' },
        { k: 'ai', l: 'AI 观测' },
      ]" :key="t.k" class="chip" :class="{ on: tab === t.k }" @click="tab = t.k as any">
        {{ t.l }}
      </button>
    </div>

    <div v-if="loading" class="col">
      <div class="skeleton" style="height: 200px" />
    </div>

    <template v-else>
      <!-- 概览 -->
      <template v-if="tab === 'overview'">
        <div class="stat-grid mb-3">
          <div v-for="s in [
            { l: '用户', v: stats?.users },
            { l: '已完成画像', v: stats?.personas },
            { l: '匹配记录', v: stats?.matches },
            { l: '建立连接', v: stats?.connections },
            { l: '会话', v: stats?.conversations },
            { l: '消息', v: stats?.messages },
            { l: '动态', v: stats?.posts },
            { l: '同频局', v: stats?.groups },
            { l: '今日活跃', v: stats?.activeToday },
            { l: '本周新增', v: stats?.newThisWeek },
            { l: '待处理举报', v: stats?.pendingReports },
            { l: '待复核内容', v: stats?.flaggedPosts },
          ]" :key="s.l" class="stat card">
            <div class="stat-n">{{ s.v ?? 0 }}</div>
            <div class="stat-l">{{ s.l }}</div>
          </div>
        </div>

        <!-- 匹配质量验证 -->
        <div class="card mb-3">
          <h3>匹配分数 vs 实际互动</h3>
          <p class="small muted">
            如果匹配算法真的有效，分数越高的档位，用户表达兴趣和建立连接的比例应该越高。
          </p>
          <table class="tbl">
            <thead>
              <tr>
                <th>分数区间</th>
                <th>推荐数</th>
                <th>表达兴趣</th>
                <th>兴趣率</th>
                <th>建立连接</th>
                <th>连接率</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="b in matchQuality" :key="b.bucket">
                <td><b>{{ b.bucket }}</b></td>
                <td>{{ b.total }}</td>
                <td>{{ b.liked }}</td>
                <td>{{ b.likeRate }}%</td>
                <td>{{ b.connected }}</td>
                <td>{{ b.connectRate }}%</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 脚手架效果 -->
        <div class="card">
          <h3>破冰脚手架生命周期</h3>
          <p class="small muted">
            active 表示 AI 正在介入，retired 表示已经退场、两人独立聊天。
            retired 占比越高，说明越多对话真正启动起来了。
          </p>
          <div class="col" style="gap: 8px">
            <div v-for="s in scaffoldStats" :key="s.scaffold_state" class="row">
              <span class="tag" :class="s.scaffold_state === 'retired' ? 'ok' : ''">
                {{ s.scaffold_state }}
              </span>
              <div class="bar grow">
                <i
                  :style="{
                    width:
                      (s.n / Math.max(1, ...scaffoldStats.map((x: any) => x.n))) * 100 + '%',
                  }"
                />
              </div>
              <span class="tiny bold">{{ s.n }}</span>
            </div>
            <div v-if="!scaffoldStats.length" class="dim small">还没有会话数据</div>
          </div>
        </div>
      </template>

      <!-- 用户管理 -->
      <template v-else-if="tab === 'users'">
        <div class="row mb-2">
          <input
            v-model="search"
            class="input"
            placeholder="搜昵称 / 邮箱 / 学校 / 专业"
            @keyup.enter="searchUsers"
          />
          <button class="btn" @click="searchUsers">搜索</button>
        </div>
        <div class="card" style="overflow-x: auto">
          <table class="tbl">
            <thead>
              <tr><th>昵称</th><th>邮箱</th><th>学院专业</th><th>画像</th><th>状态</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="u in users" :key="u.id">
                <td><b>{{ u.nickname }}</b> <span v-if="u.role === 'admin'" class="tag brand">管理员</span></td>
                <td class="tiny dim">{{ u.email }}</td>
                <td class="tiny">{{ u.college }} {{ u.major }}</td>
                <td>
                  <span class="tag" :class="u.persona_stage >= 2 ? 'ok' : ''">
                    {{ u.persona_stage >= 2 ? '已完成' : u.persona_stage === 1 ? '进行中' : '未开始' }}
                  </span>
                </td>
                <td>
                  <span class="tag" :class="u.status === 'banned' ? 'danger' : u.status === 'muted' ? 'warn' : ''">
                    {{ STATUS_LABEL[u.status] || u.status }}
                  </span>
                </td>
                <td>
                  <div class="row" style="gap: 5px">
                    <button v-if="u.status !== 'active'" class="btn sm ghost" @click="setStatus(u, 'active')">解封</button>
                    <button v-if="u.status === 'active'" class="btn sm ghost" @click="setStatus(u, 'muted')">禁言</button>
                    <button v-if="u.status !== 'banned' && u.role !== 'admin'" class="btn sm danger" @click="setStatus(u, 'banned')">封禁</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <!-- 内容管理 -->
      <template v-else-if="tab === 'posts'">
        <div class="col" style="gap: 10px">
          <div v-for="p in posts" :key="p.id" class="card">
            <div class="row between mb-1">
              <b class="small">{{ p.nickname }}</b>
              <div class="row" style="gap: 6px">
                <span class="tag" :class="p.mod_status === 'blocked' ? 'danger' : p.mod_status === 'flagged' ? 'warn' : 'ok'">
                  {{ p.mod_status }}
                </span>
                <span class="tiny dim">{{ relTime(p.created_at) }}</span>
              </div>
            </div>
            <p class="small pre-wrap" style="margin: 0 0 8px">{{ p.content }}</p>
            <div v-if="p.mod_reason" class="tiny dim mb-1">审核：{{ p.mod_reason }}</div>
            <div class="row" style="gap: 6px">
              <button class="btn sm ghost" @click="moderatePost(p, 'ok')">放行</button>
              <button class="btn sm ghost" @click="moderatePost(p, 'flagged')">标记</button>
              <button class="btn sm danger" @click="moderatePost(p, 'blocked')">屏蔽</button>
            </div>
          </div>
          <div v-if="!posts.length" class="empty"><p>还没有内容</p></div>
        </div>
      </template>

      <!-- 举报 -->
      <template v-else-if="tab === 'reports'">
        <div class="col" style="gap: 10px">
          <div v-for="r in reports" :key="r.id" class="card">
            <div class="row between mb-1">
              <b class="small">{{ r.reporter_name }} 举报了 {{ r.target_type }}</b>
              <span class="tag" :class="r.status === 'pending' ? 'warn' : 'ok'">{{ r.status }}</span>
            </div>
            <div class="small">理由：{{ r.reason }}</div>
            <div v-if="r.detail" class="tiny muted">{{ r.detail }}</div>
            <div class="tiny dim mb-1">目标 ID：{{ r.target_id }} · {{ relTime(r.created_at) }}</div>
            <div v-if="r.status === 'pending'" class="row" style="gap: 6px">
              <button class="btn sm" @click="resolveReport(r, 'resolved')">已处理</button>
              <button class="btn sm ghost" @click="resolveReport(r, 'dismissed')">驳回</button>
            </div>
          </div>
          <div v-if="!reports.length" class="empty"><p>没有举报</p></div>
        </div>
      </template>

      <!-- AI 观测 -->
      <template v-else>
        <div class="card mb-3">
          <h3>各链路 AI 调用统计</h3>
          <p class="tiny dim">
            只统计真实的大模型 API 调用。本地语义引擎（无 Key 降级路径）不产生费用，也不写入调用记录——当前引擎见页首。
          </p>
          <table class="tbl">
            <thead>
              <tr><th>任务</th><th>引擎</th><th>调用数</th><th>成功</th><th>平均延迟</th><th>输入 token</th><th>输出 token</th></tr>
            </thead>
            <tbody>
              <tr v-for="(t, i) in aiByTask" :key="i">
                <td><b>{{ t.task }}</b></td>
                <td><span class="tag">{{ t.provider }}</span></td>
                <td>{{ t.calls }}</td>
                <td>{{ t.ok_calls }}</td>
                <td>{{ Math.round(t.avg_latency || 0) }} ms</td>
                <td>{{ t.tokens_in || 0 }}</td>
                <td>{{ t.tokens_out || 0 }}</td>
              </tr>
            </tbody>
          </table>
          <div v-if="!aiByTask.length" class="dim small">
            还没有大模型调用记录。配置 .env 中的 AI Key 后，真实 API 调用会记录在这里。
          </div>
        </div>

        <div class="card">
          <h3>最近调用明细</h3>
          <table class="tbl">
            <thead><tr><th>时间</th><th>任务</th><th>引擎</th><th>延迟</th><th>结果</th></tr></thead>
            <tbody>
              <tr v-for="l in aiLogs.slice(0, 40)" :key="l.id">
                <td class="tiny dim">{{ relTime(l.created_at) }}</td>
                <td>{{ l.task }}</td>
                <td class="tiny">{{ l.provider }}</td>
                <td class="tiny">{{ l.latency_ms }} ms</td>
                <td>
                  <span class="tag" :class="l.ok ? 'ok' : 'danger'">{{ l.ok ? '成功' : l.error || '失败' }}</span>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="!aiLogs.length" class="dim small">暂无大模型调用记录</div>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.chip {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-2);
  padding: 4px 13px;
  border-radius: 999px;
  font-size: 0.82rem;
}
.chip.on {
  background: var(--brand-600);
  border-color: var(--brand-600);
  color: var(--on-brand);
  font-weight: 600;
}
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
  gap: 10px;
}
.stat { padding: 13px; text-align: center; }
.stat-n { font-size: 1.5rem; font-weight: 750; line-height: 1.2; }
.stat-l { font-size: 0.74rem; color: var(--text-3); }
.tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
.tbl th {
  text-align: left;
  font-size: 0.74rem;
  color: var(--text-3);
  font-weight: 600;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.tbl td {
  padding: 7px 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
.tbl tr:last-child td { border-bottom: none; }
</style>
