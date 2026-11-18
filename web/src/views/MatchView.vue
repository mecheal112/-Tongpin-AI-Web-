<script setup lang="ts">
/**
 * 匹配页：今日推荐 + 喜欢我的人。
 * 每张卡片展示匹配分、AI 生成的匹配理由、共鸣点与互补点。
 * 互补点是这个产品区别于「推荐相似的人」的地方，所以单独展示。
 */
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { matchApi } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/lib/toast';
import Avatar from '@/components/Avatar.vue';
import ScoreRing from '@/components/ScoreRing.vue';
import type { MatchItem } from '@/types';

const auth = useAuthStore();
const { ok, error } = useToast();

const loading = ref(true);
const tab = ref<'daily' | 'received'>('daily');
const matches = ref<MatchItem[]>([]);
const needsPersona = ref(false);
const busyId = ref<string | null>(null);
const expanded = ref<string | null>(null);

onMounted(load);

function switchTab(t: 'daily' | 'received') {
  if (tab.value === t) return;
  tab.value = t;
  load();
}

async function load() {
  loading.value = true;
  try {
    if (tab.value === 'received') {
      const res = await matchApi.received();
      matches.value = res.matches || [];
      needsPersona.value = false;
    } else {
      const res = await matchApi.daily(8);
      needsPersona.value = Boolean(res.needsPersona);
      matches.value = res.matches || [];
    }
  } catch (e: any) {
    error(e?.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

async function act(m: MatchItem, action: 'like' | 'pass') {
  if (!m.id || busyId.value) return;
  busyId.value = m.id;
  try {
    const res = await matchApi.act(m.id, action);
    m.myAction = action;
    if (res.mutual) {
      ok('你们互相看对眼了，去打个招呼吧');
    } else if (action === 'like') {
      ok('已表达兴趣，等对方回应');
    }
  } catch (e: any) {
    error(e?.message || '操作失败');
  } finally {
    busyId.value = null;
  }
}

function level(s: number) {
  return s >= 80 ? 'high' : s >= 62 ? 'mid' : 'low';
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">{{ tab === 'daily' ? '今日同频' : '喜欢我的人' }}</h1>
        <p class="page-sub">
          {{ tab === 'daily' ? '不是推荐最热门的人，是推荐和你最合拍的人' : '这些人对你表达了兴趣，看看谁值得回应' }}
        </p>
      </div>
      <RouterLink to="/explore" class="btn ghost sm">探索更多人</RouterLink>
    </div>

    <div class="seg mb-3" style="max-width: 320px">
      <button :class="{ on: tab === 'daily' }" @click="switchTab('daily')">今日同频</button>
      <button :class="{ on: tab === 'received' }" @click="switchTab('received')">喜欢我的人</button>
    </div>

    <div v-if="loading" class="card-grid">
      <div v-for="i in 3" :key="i" class="skeleton" style="height: 200px" />
    </div>

    <div v-else-if="needsPersona" class="card pad-lg center">
      <div class="empty-ico">🧭</div>
      <h3>还没有人格画像</h3>
      <p class="muted">匹配要靠画像才能算得准。先花三分钟让我认识你。</p>
      <RouterLink to="/persona" class="btn">去做画像</RouterLink>
    </div>

    <div v-else-if="!matches.length" class="empty">
      <div class="empty-ico">{{ tab === 'daily' ? '🌙' : '💌' }}</div>
      <div class="empty-title">{{ tab === 'daily' ? '今天的推荐已经看完了' : '还没有人对你表达兴趣' }}</div>
      <p class="small">
        {{ tab === 'daily' ? '明天会有新的一批。也可以去探索页主动找人。' : '完善画像、多发发动态，会更容易被对的人看到。' }}
      </p>
      <RouterLink to="/explore" class="btn ghost">去探索</RouterLink>
    </div>

    <div v-else class="card-grid">
      <div v-for="m in matches" :key="m.id || m.user.id" class="card hover">
        <div class="row mb-2">
          <RouterLink :to="`/user/${m.user.id}`">
            <Avatar :name="m.user.nickname" :avatar="m.user.avatar" size="lg" />
          </RouterLink>
          <div class="grow" style="min-width: 0">
            <RouterLink :to="`/user/${m.user.id}`" class="bold" style="color: inherit">
              {{ m.user.nickname }}
            </RouterLink>
            <div class="tiny dim">{{ m.user.college }} · {{ m.user.major }} · {{ m.user.grade }}</div>
          </div>
          <ScoreRing :score="m.score" />
        </div>

        <p class="small" style="margin: 0 0 10px">{{ m.reason }}</p>

        <div v-if="m.common.length" class="mb-1">
          <div class="tiny dim bold">共鸣</div>
          <div class="tag-row">
            <span v-for="c in m.common.slice(0, 4)" :key="c" class="tag ok">{{ c }}</span>
          </div>
        </div>

        <div v-if="m.complement.length || m.newInterests.length" class="mb-2">
          <div class="tiny dim bold">能带给你新东西的地方</div>
          <div class="tag-row">
            <span v-for="c in (m.complement.length ? m.complement : m.newInterests).slice(0, 4)" :key="c" class="tag warn">
              {{ c }}
            </span>
          </div>
        </div>

        <!-- 分数明细，默认收起 -->
        <button class="detail-toggle" @click="expanded = expanded === (m.id || m.user.id) ? null : (m.id || m.user.id)">
          {{ expanded === (m.id || m.user.id) ? '收起' : '查看评分细节' }}
        </button>
        <div v-if="expanded === (m.id || m.user.id)" class="detail-box">
          <div v-for="d in [
            { k: '共鸣度', v: m.breakdown.resonance },
            { k: '互补度', v: m.breakdown.complement },
            { k: '现实兼容', v: m.breakdown.compatibility },
          ]" :key="d.k" class="detail-row">
            <span>{{ d.k }}</span>
            <div class="bar grow"><i :style="{ width: (d.v || 0) + '%' }" /></div>
            <span class="tiny bold">{{ d.v ?? '-' }}</span>
          </div>
          <div v-for="c in m.breakdown.compatDetail || []" :key="c.key" class="detail-row">
            <span class="dim">{{ c.label }}</span>
            <div class="bar grow"><i :style="{ width: c.score + '%' }" /></div>
            <span class="tiny dim">{{ c.score }}</span>
          </div>
        </div>

        <div class="row mt-2">
          <template v-if="m.myAction === 'none' || !m.myAction">
            <button class="btn grow" :disabled="busyId === m.id" @click="act(m, 'like')">想认识</button>
            <button class="btn ghost" :disabled="busyId === m.id" @click="act(m, 'pass')">跳过</button>
          </template>
          <template v-else-if="m.myAction === 'connected'">
            <RouterLink :to="`/chat`" class="btn subtle grow">已连接，去聊天</RouterLink>
          </template>
          <template v-else-if="m.myAction === 'like'">
            <span class="tag warn grow center">已表达兴趣，等对方回应</span>
          </template>
          <template v-else>
            <span class="tag grow center">已跳过</span>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.seg {
  display: flex;
  background: var(--surface-2);
  border-radius: var(--radius-sm);
  padding: 3px;
  gap: 3px;
}
.seg button {
  flex: 1;
  border: none;
  background: transparent;
  padding: 8px;
  border-radius: 7px;
  font-weight: 600;
  color: var(--text-2);
}
.seg button.on {
  background: var(--surface);
  color: var(--brand-600);
  box-shadow: var(--shadow);
}
.detail-toggle {
  border: none;
  background: none;
  padding: 2px 0;
  font-size: 0.78rem;
  color: var(--text-3);
  text-decoration: underline;
}
.detail-box {
  background: var(--surface-2);
  border-radius: var(--radius-sm);
  padding: 10px;
  margin-top: 6px;
}
.detail-row {
  display: grid;
  grid-template-columns: 68px 1fr 30px;
  align-items: center;
  gap: 8px;
  font-size: 0.76rem;
  margin-bottom: 5px;
}
.detail-row:last-child { margin-bottom: 0; }
</style>
