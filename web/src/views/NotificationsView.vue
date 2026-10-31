<script setup lang="ts">
/** 通知中心 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { notifApi } from '@/api';
import { useBadgeStore } from '@/stores/badge';
import { useToast } from '@/lib/toast';
import type { Notification } from '@/types';

const { error } = useToast();
const badges = useBadgeStore();
const loading = ref(true);
const items = ref<Notification[]>([]);
const filter = ref<'all' | 'unread'>('all');

const shown = computed(() =>
  filter.value === 'unread' ? items.value.filter((n) => !n.read_at) : items.value,
);
const unreadCount = computed(() => items.value.filter((n) => !n.read_at).length);

const ICONS: Record<string, string> = {
  match: '✨',
  message: '💬',
  like: '❤️',
  comment: '💭',
  group: '👥',
  system: '📢',
};

onMounted(load);

// 离开通知中心时再和侧栏对齐一次，防止页面停留期间来了新通知
onUnmounted(() => badges.refresh());

async function load() {
  loading.value = true;
  try {
    const res = await notifApi.list();
    items.value = res.notifications || [];
    badges.setNotif(res.unread ?? 0);
  } catch (e: any) {
    error(e?.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

async function markAll() {
  try {
    const res = await notifApi.read();
    items.value.forEach((n) => (n.read_at = Date.now()));
    badges.setNotif(res.unread ?? 0);
  } catch (e: any) {
    error(e?.message || '操作失败');
  }
}

async function markOne(n: Notification) {
  if (n.read_at) return;
  try {
    const res = await notifApi.read([n.id]);
    n.read_at = Date.now();
    badges.setNotif(res.unread ?? 0);
  } catch {
    /* 忽略 */
  }
}

function relTime(ts: number) {
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}
</script>

<template>
  <div class="page narrow">
    <div class="page-head">
      <div>
        <h1 class="page-title">通知</h1>
        <p class="page-sub">{{ unreadCount ? `${unreadCount} 条未读` : '都看完了' }}</p>
      </div>
      <button v-if="unreadCount" class="btn ghost sm" @click="markAll">全部标为已读</button>
    </div>

    <div class="tag-row mb-3">
      <button class="chip" :class="{ on: filter === 'all' }" @click="filter = 'all'">全部</button>
      <button class="chip" :class="{ on: filter === 'unread' }" @click="filter = 'unread'">
        未读 {{ unreadCount || '' }}
      </button>
    </div>

    <div v-if="loading" class="col">
      <div v-for="i in 5" :key="i" class="skeleton" style="height: 66px" />
    </div>

    <div v-else-if="!shown.length" class="empty">
      <div class="empty-ico">🔔</div>
      <div class="empty-title">{{ filter === 'unread' ? '没有未读通知' : '还没有通知' }}</div>
    </div>

    <div v-else class="col" style="gap: 9px">
      <component
        v-for="n in shown"
        :key="n.id"
        :is="n.link ? RouterLink : 'div'"
        :to="n.link || undefined"
        class="notif card"
        :class="{ unread: !n.read_at }"
        @click="markOne(n)"
      >
        <span class="notif-ico">{{ ICONS[n.type] || '📌' }}</span>
        <div class="grow" style="min-width: 0">
          <div class="row between">
            <b style="font-size: 0.9rem">{{ n.title }}</b>
            <span class="tiny dim">{{ relTime(n.created_at) }}</span>
          </div>
          <div v-if="n.body" class="tiny muted clamp-2">{{ n.body }}</div>
        </div>
        <span v-if="!n.read_at" class="dot" />
      </component>
    </div>
  </div>
</template>

<style scoped>
.chip {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-2);
  padding: 4px 12px;
  border-radius: 999px;
  font-size: 0.8rem;
}
.chip.on {
  background: var(--brand-600);
  border-color: var(--brand-600);
  color: var(--on-brand);
  font-weight: 600;
}
.notif {
  display: flex;
  gap: 11px;
  align-items: flex-start;
  color: inherit;
  cursor: pointer;
  transition: border-color 0.14s;
}
.notif:hover { text-decoration: none; border-color: var(--brand-200); }
.notif.unread { border-left: 3px solid var(--brand-500); }
.notif-ico { font-size: 19px; flex-shrink: 0; }
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--brand-500);
  flex-shrink: 0;
  margin-top: 6px;
}
</style>
