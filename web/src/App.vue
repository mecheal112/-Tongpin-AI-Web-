<script setup lang="ts">
/**
 * 应用外壳：桌面端左侧导航 + 移动端底部标签栏。
 * 未登录时不显示导航，由路由守卫引导到登录页。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useBadgeStore } from '@/stores/badge';
import { connectSocket, disconnectSocket, getSocket } from '@/lib/socket';
import { useToast } from '@/lib/toast';
import Avatar from '@/components/Avatar.vue';
import ToastHost from '@/components/ToastHost.vue';

const auth = useAuthStore();
const badges = useBadgeStore();
const route = useRoute();
const router = useRouter();
const { toast } = useToast();

let timer: number | undefined;

const showNav = computed(() => auth.isLoggedIn && route.name !== 'login');

const NAV = [
  { name: 'home', to: '/', label: '首页', ico: '🏠' },
  { name: 'match', to: '/match', label: '匹配', ico: '✨' },
  { name: 'explore', to: '/explore', label: '探索', ico: '🧭' },
  { name: 'chat', to: '/chat', label: '消息', ico: '💬' },
  { name: 'community', to: '/community', label: '社区', ico: '🌱' },
  { name: 'groups', to: '/groups', label: '同频局', ico: '👥' },
];

const MOBILE_NAV = ['home', 'match', 'chat', 'community', 'groups'];

/** 该导航项对应的未读数 —— 消息看私信，通知看通知中心，同频局看「待审批 + 群聊未读」 */
function badgeFor(name: string) {
  if (name === 'chat') return badges.chat;
  if (name === 'groups') return badges.group;
  if (name === 'notifications') return badges.notif;
  return 0;
}

function fmt(n: number) {
  return n > 99 ? '99+' : String(n);
}

function onNotification(payload: any) {
  // 收到推送就和服务端对齐。私信会在 messages 表里留下未读，
  // 所以这里统一 refresh，避免本地自增和实际未读数越差越远。
  if (payload?.title) toast(payload.title);
  badges.refresh();
}

// 有人申请加入我发起的小组：即使不在小组页面，侧栏也能立刻亮起来
function onJoinRequest(payload: any) {
  if (typeof payload?.pendingCount === 'number') badges.refresh();
  else badges.setApprovals(badges.approvals + 1);
}

/**
 * 我所在的小组里有人说话。
 *
 * 事件里只有 groupId 没有内容，所以本地加一和真实未读可能对不上
 * （比如我其实正开着那个群聊）。攒一下再统一去服务端对齐，
 * 既避免一群人连着发言时打出一串请求，也保证数字最终是对的。
 */
let unreadTimer: number | undefined;
function onGroupUnread() {
  if (unreadTimer) window.clearTimeout(unreadTimer);
  unreadTimer = window.setTimeout(() => badges.refresh(), 800);
}

onMounted(async () => {
  await auth.bootstrap();
  if (auth.isLoggedIn) {
    connectSocket();
    badges.refresh();
    timer = window.setInterval(() => badges.refresh(), 45000);
    getSocket()?.on('notification', onNotification);
    getSocket()?.on('group:join-request', onJoinRequest);
    getSocket()?.on('group:member-changed', onJoinRequest);
    getSocket()?.on('group:unread', onGroupUnread);
  }
  router.isReady();
});

onUnmounted(() => {
  if (timer) window.clearInterval(timer);
  if (unreadTimer) window.clearTimeout(unreadTimer);
  getSocket()?.off('notification', onNotification);
  getSocket()?.off('group:join-request', onJoinRequest);
  getSocket()?.off('group:member-changed', onJoinRequest);
  getSocket()?.off('group:unread', onGroupUnread);
});

function logout() {
  disconnectSocket();
  badges.reset();
  auth.logout();
  router.push('/login');
}
</script>

<template>
  <div v-if="!auth.ready" style="display: grid; place-items: center; min-height: 100vh">
    <div class="spinner" />
  </div>

  <div v-else-if="!showNav" class="main-area">
    <RouterView />
  </div>

  <div v-else class="app-shell">
    <!-- 桌面端侧边导航 -->
    <nav class="side-nav">
      <div class="brand">
        <span class="brand-dot">频</span>
        <span>同频</span>
      </div>

      <RouterLink
        v-for="n in NAV"
        :key="n.name"
        :to="n.to"
        class="nav-item"
        :class="{ active: route.name === n.name }"
      >
        <span class="ico">{{ n.ico }}</span>
        <span>{{ n.label }}</span>
        <span v-if="badgeFor(n.name)" class="nav-badge">{{ fmt(badgeFor(n.name)) }}</span>
      </RouterLink>

      <RouterLink to="/notifications" class="nav-item" :class="{ active: route.name === 'notifications' }">
        <span class="ico">🔔</span>
        <span>通知</span>
        <span v-if="badges.hasNotif" class="nav-badge">{{ fmt(badges.notif) }}</span>
      </RouterLink>

      <RouterLink
        v-if="auth.isAdmin"
        to="/admin"
        class="nav-item"
        :class="{ active: route.name === 'admin' }"
      >
        <span class="ico">⚙️</span>
        <span>管理后台</span>
      </RouterLink>

      <div class="nav-spacer" />

      <div class="nav-user">
        <Avatar :name="auth.user!.nickname" :avatar="auth.user!.avatar" size="sm" />
        <div class="nav-user-info">
          <div class="nav-user-name">{{ auth.user!.nickname }}</div>
          <div class="nav-user-sub">{{ auth.user!.major || auth.user!.college || '未填写专业' }}</div>
        </div>
      </div>
      <RouterLink to="/profile" class="nav-item" :class="{ active: route.name === 'profile' }">
        <span class="ico">👤</span><span>个人资料</span>
      </RouterLink>
      <button class="nav-item" style="border: none; background: none; text-align: left; width: 100%" @click="logout">
        <span class="ico">↩︎</span><span>退出登录</span>
      </button>
    </nav>

    <!-- 主内容区 -->
    <div class="main-area">
      <RouterView />
    </div>

    <!-- 移动端底部标签栏 -->
    <nav class="tab-bar">
      <template v-for="n in NAV.filter((x) => MOBILE_NAV.includes(x.name))" :key="n.name">
        <RouterLink :to="n.to" class="tab-item" :class="{ active: route.name === n.name }">
          <span class="ico">{{ n.ico }}</span>
          <span>{{ n.label }}</span>
          <span v-if="badgeFor(n.name)" class="nav-badge">{{ fmt(badgeFor(n.name)) }}</span>
        </RouterLink>
      </template>
      <RouterLink to="/profile" class="tab-item" :class="{ active: route.name === 'profile' }">
        <span class="ico">👤</span>
        <span>我的</span>
      </RouterLink>
    </nav>
  </div>

  <ToastHost />
</template>
