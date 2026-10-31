<script setup lang="ts">
/** 同频局列表：浏览 / 按类别筛选 / 创建 */
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { groupApi } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { useBadgeStore } from '@/stores/badge';
import { useToast } from '@/lib/toast';
import type { Group } from '@/types';

const auth = useAuthStore();
const badges = useBadgeStore();
const { ok, error } = useToast();

const loading = ref(true);
const groups = ref<Group[]>([]);
const categories = ref<string[]>([]);
const activeCat = ref('');
const showCreate = ref(false);
const creating = ref(false);
const tab = ref<'all' | 'mine'>('all');

const form = ref({
  title: '',
  description: '',
  category: '学习搭子',
  wanted: '',
  capacity: 6,
  location: '',
  isOnline: true,
});

onMounted(async () => {
  try {
    const c = await groupApi.categories();
    categories.value = c.categories || [];
  } catch {
    /* 忽略 */
  }
  await load();
  badges.refresh();
});

async function load() {
  loading.value = true;
  try {
    const res = tab.value === 'mine' ? await groupApi.mine() : await groupApi.list(activeCat.value);
    groups.value = res.groups || [];
  } catch (e: any) {
    error(e?.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

function pickCat(c: string) {
  activeCat.value = activeCat.value === c ? '' : c;
  tab.value = 'all';
  load();
}

function switchTab(t: 'all' | 'mine') {
  tab.value = t;
  if (t === 'mine') activeCat.value = '';
  load();
}

async function create() {
  if (!form.value.title.trim()) {
    error('给小组起个名字');
    return;
  }
  creating.value = true;
  try {
    await groupApi.create({ ...form.value });
    ok('已创建');
    showCreate.value = false;
    form.value = { title: '', description: '', category: '学习搭子', wanted: '', capacity: 6, location: '', isOnline: true };
    tab.value = 'mine';
    await load();
  } catch (e: any) {
    error(e?.message || '创建失败');
  } finally {
    creating.value = false;
  }
}

async function join(g: Group) {
  try {
    await groupApi.join(g.id);
    // 进组要发起人同意，所以这里只是「申请已提交」，不是「已加入」
    ok('申请已提交，等发起人通过');
    load();
  } catch (e: any) {
    error(e?.message || '申请失败');
  }
}

/** 管理员在列表上下架违规小组。双击确认，因为这个入口就挨着「申请加入」 */
async function closeAsAdmin(g: Group) {
  if (!confirm(`以管理员身份关闭「${g.title}」？组内所有人都会收到通知。`)) return;
  try {
    await groupApi.close(g.id);
    ok('已作为管理员关闭');
    load();
  } catch (e: any) {
    error(e?.message || '操作失败');
  }
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">同频局</h1>
        <p class="page-sub">一个人做不成的事，找几个同频的人一起</p>
      </div>
      <button v-if="auth.isLoggedIn" class="btn" @click="showCreate = !showCreate">
        {{ showCreate ? '收起' : '发起一个' }}
      </button>
    </div>

    <!-- 创建表单 -->
    <div v-if="showCreate" class="card pad-lg mb-3">
      <h3>发起同频局</h3>
      <div class="field">
        <label class="label">小组名称</label>
        <input v-model="form.title" class="input" placeholder="比如：一起刷算法题冲ACM" maxlength="40" />
      </div>
      <div class="field">
        <label class="label">说明</label>
        <textarea v-model="form.description" class="textarea" placeholder="想做什么、怎么参与、大概多久一次" />
      </div>
      <div class="grid-2">
        <div class="field">
          <label class="label">类别</label>
          <select v-model="form.category" class="select">
            <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
          </select>
        </div>
        <div class="field">
          <label class="label">人数上限</label>
          <input v-model.number="form.capacity" class="input" type="number" min="2" max="50" />
        </div>
      </div>
      <div class="field">
        <label class="label">希望找什么样的人</label>
        <input v-model="form.wanted" class="input" placeholder="AI 会据此推荐合适的人选" />
        <p class="hint">写具体一点，比如「能坚持每周来、不划水」，推荐会更准。</p>
      </div>
      <div class="grid-2">
        <div class="field">
          <label class="label">地点</label>
          <input v-model="form.location" class="input" placeholder="线上活动可留空" />
        </div>
        <div class="field">
          <label class="label">形式</label>
          <select v-model="form.isOnline" class="select">
            <option :value="true">线上</option>
            <option :value="false">线下</option>
          </select>
        </div>
      </div>
      <button class="btn block" :disabled="creating" @click="create">
        <span v-if="creating" class="spinner" />
        <span v-else>创建</span>
      </button>
    </div>

    <!-- 我的 / 全部 -->
    <div class="tag-row mb-3">
      <button class="topic-chip" :class="{ on: tab === 'all' }" @click="switchTab('all')">全部</button>
      <button class="topic-chip" :class="{ on: tab === 'mine' }" @click="switchTab('mine')">我参与的</button>
    </div>

    <div v-if="tab === 'all' && categories.length" class="tag-row mb-3">
      <button
        v-for="c in categories"
        :key="c"
        class="topic-chip"
        :class="{ on: activeCat === c }"
        @click="pickCat(c)"
      >
        {{ c }}
      </button>
    </div>

    <div v-if="loading" class="card-grid">
      <div v-for="i in 4" :key="i" class="skeleton" style="height: 165px" />
    </div>

    <div v-else-if="!groups.length" class="empty">
      <div class="empty-ico">👥</div>
      <div class="empty-title">{{ tab === 'mine' ? '你还没有加入任何小组' : '还没有小组' }}</div>
      <p class="small">{{ tab === 'mine' ? '去全部列表看看' : '发起第一个吧' }}</p>
    </div>

    <div v-else class="card-grid">
      <div v-for="g in groups" :key="g.id" class="card hover">
        <RouterLink :to="`/group/${g.id}`" style="color: inherit">
          <div class="row between mb-1">
            <span class="tag brand">{{ g.category }}</span>
            <span class="tiny dim">{{ g.memberCount }} / {{ g.capacity }} 人</span>
          </div>
          <h3 style="margin-bottom: 5px">
            {{ g.title }}
            <span v-if="g.unreadCount" class="unread-dot">{{ g.unreadCount > 99 ? '99+' : g.unreadCount }}</span>
          </h3>
          <p class="small muted clamp-2" style="margin: 0 0 10px">{{ g.description || '暂无说明' }}</p>
        </RouterLink>

        <div class="row between">
          <span class="tiny dim">
            {{ g.owner.nickname }} 发起 · {{ g.isOnline ? '线上' : g.location || '线下' }}
          </span>
          <span v-if="g.isOwner" class="tag">我发起的</span>
          <span v-else-if="g.isMember" class="tag ok">已加入</span>
          <span v-else-if="g.joinPending" class="tag warn">待通过</span>
          <button
            v-else-if="auth.isLoggedIn"
            class="btn sm"
            :disabled="g.memberCount >= g.capacity"
            @click="join(g)"
          >
            {{ g.memberCount >= g.capacity ? '已满' : '申请加入' }}
          </button>
        </div>

        <!-- 管理员行：和上面的日常操作分开放，避免误点 -->
        <div v-if="auth.isAdmin && !g.isOwner" class="admin-row">
          <button class="link-danger" @click="closeAsAdmin(g)">以管理员身份关闭</button>
        </div>

        <!-- 发起人视角：有待审批时直接在列表上提示，不用点进去才发现 -->
        <RouterLink
          v-if="g.isOwner && g.pendingCount"
          :to="`/group/${g.id}`"
          class="pending-hint"
        >
          {{ g.pendingCount }} 条入组申请待处理 →
        </RouterLink>
      </div>
    </div>
  </div>
</template>

<style scoped>
.topic-chip {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-2);
  padding: 4px 11px;
  border-radius: 999px;
  font-size: 0.8rem;
}
.topic-chip.on {
  background: var(--brand-600);
  border-color: var(--brand-600);
  color: var(--on-brand);
  font-weight: 600;
}
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 12px;
}
@media (max-width: 480px) {
  .grid-2 { grid-template-columns: 1fr; }
}
.pending-hint {
  display: block;
  margin-top: 10px;
  padding: 7px 11px;
  border-radius: var(--radius-sm);
  background: rgba(217, 119, 6, 0.1);
  color: var(--warn);
  font-size: 0.78rem;
  font-weight: 600;
  text-align: center;
}
.pending-hint:hover { text-decoration: none; background: rgba(217, 119, 6, 0.16); }
.admin-row {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
  text-align: right;
}
.link-danger {
  border: none;
  background: none;
  padding: 0;
  font-size: 0.74rem;
  color: var(--danger);
  opacity: 0.75;
}
.link-danger:hover { opacity: 1; text-decoration: underline; }
/* 群里有没看过的消息。和导航角标同源，但指着具体哪一个小组 */
.unread-dot {
  display: inline-block;
  vertical-align: 2px;
  margin-left: 4px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--brand-600);
  color: var(--on-brand);
  font-size: 0.68rem;
  font-weight: 700;
  line-height: 1.5;
}
</style>
