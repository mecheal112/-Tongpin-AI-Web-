<script setup lang="ts">
/**
 * 小组群聊。
 *
 * 和 1:1 私聊分开做：私聊围绕「破冰」，有 AI 脚手架；
 * 群聊是一组人围绕一个共同目标协作，需要的是「谁在说话」和「事情进展」，
 * 所以这里只做纯消息流，不加脚手架。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { groupApi } from '@/api';
import { useBadgeStore } from '@/stores/badge';
import { connectSocket, getSocket } from '@/lib/socket';
import { useToast } from '@/lib/toast';
import Avatar from '@/components/Avatar.vue';
import type { Group } from '@/types';

const route = useRoute();
const router = useRouter();
const badges = useBadgeStore();
const { error } = useToast();

const groupId = computed(() => route.params.id as string);
const group = ref<Group | null>(null);
const messages = ref<any[]>([]);
const loading = ref(true);
const sending = ref(false);
const input = ref('');
const bodyEl = ref<HTMLElement | null>(null);

onMounted(async () => {
  connectSocket();
  const s = getSocket();
  s?.on('group:message', onIncoming);
  s?.on('group:closed', onClosed);
  await load();
  s?.emit('group:join', { groupId: groupId.value });
  document.addEventListener('visibilitychange', onVisibility);
});

onUnmounted(() => {
  const s = getSocket();
  s?.off('group:message', onIncoming);
  s?.off('group:closed', onClosed);
  s?.emit('group:leave', { groupId: groupId.value });
  document.removeEventListener('visibilitychange', onVisibility);
});

watch(groupId, async (id, prev) => {
  if (prev) getSocket()?.emit('group:leave', { groupId: prev });
  if (id) {
    await load();
    getSocket()?.emit('group:join', { groupId: id });
  }
});

async function load() {
  loading.value = true;
  try {
    const [d, m] = await Promise.all([
      groupApi.detail(groupId.value),
      groupApi.messages(groupId.value),
    ]);
    group.value = d.group;
    messages.value = m.messages || [];
    // 拉消息时服务端已经落过已读，这里只是把角标立刻抹掉，不等 45 秒轮询
    badges.refresh();
    await scrollDown();
  } catch (e: any) {
    error(e?.message || '无法进入群聊');
    router.push('/groups');
  } finally {
    loading.value = false;
  }
}

function onIncoming(msg: any) {
  if (msg.group_id !== groupId.value) return;
  if (messages.value.some((m) => m.id === msg.id)) return;
  messages.value.push(msg);
  // 页面开着且可见才算读过。标签页在后台时不能替用户认下这条消息，
  // 否则切回来红点已经没了，人却根本没看见。
  if (document.visibilityState === 'visible') getSocket()?.emit('group:read', { groupId: groupId.value });
  badges.refresh();
  scrollDown();
}

/** 从别的标签页切回来：期间攒下的消息现在才真的被看到 */
function onVisibility() {
  if (document.visibilityState !== 'visible') return;
  getSocket()?.emit('group:read', { groupId: groupId.value });
  badges.refresh();
}

/** 正在群里聊着，管理员把小组关了 —— 别让人对着发不出去的消息框发呆 */
function onClosed(payload: any) {
  if (payload?.groupId !== groupId.value) return;
  error('该小组已被管理员关闭');
  router.push('/groups');
}

async function send() {
  const text = input.value.trim();
  if (!text || sending.value) return;
  sending.value = true;
  try {
    const res = await groupApi.send(groupId.value, text);
    input.value = '';
    if (!messages.value.some((m) => m.id === res.message.id)) {
      messages.value.push(res.message);
    }
    await scrollDown();
  } catch (e: any) {
    error(e?.message || '发送失败');
  } finally {
    sending.value = false;
  }
}

async function scrollDown() {
  await nextTick();
  bodyEl.value?.scrollTo({ top: bodyEl.value.scrollHeight, behavior: 'smooth' });
}

function fmtTime(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
</script>

<template>
  <div class="chat-layout group-chat">
    <aside class="conv-list hide-mobile">
      <div class="chat-head">
        <RouterLink to="/groups" class="btn ghost sm">←</RouterLink>
        <b class="grow">同频局</b>
      </div>
      <RouterLink v-if="group" :to="`/group/${group.id}`" class="conv-item active">
        <div class="conv-body">
          <div class="conv-top"><span class="conv-name">{{ group.title }}</span></div>
          <div class="conv-preview">返回小组详情</div>
        </div>
      </RouterLink>
    </aside>

    <section class="chat-main">
      <header class="chat-head">
        <RouterLink :to="`/group/${groupId}`" class="btn ghost sm back-btn">←</RouterLink>
        <div class="grow" style="min-width: 0">
          <div class="bold" style="font-size: 0.94rem">{{ group?.title || '群聊' }}</div>
          <div class="tiny dim">{{ group?.memberCount || 0 }} / {{ group?.capacity || 0 }} 人</div>
        </div>
        <RouterLink :to="`/group/${groupId}`" class="btn ghost sm">小组详情</RouterLink>
      </header>

      <div ref="bodyEl" class="chat-body">
        <div v-if="loading" class="col">
          <div v-for="i in 5" :key="i" class="skeleton" style="height: 44px" />
        </div>

        <template v-else>
          <div v-if="!messages.length" class="empty" style="margin: auto">
            <div class="empty-ico">👥</div>
            <div class="empty-title">群聊还没有消息</div>
            <p class="small">打个招呼，说说你打算在这个小组里做什么</p>
          </div>

          <template v-for="m in messages" :key="m.id">
            <!-- 系统消息：进群、退出这类事件 -->
            <div v-if="m.kind === 'system' || !m.sender_id" class="msg-system">{{ m.content }}</div>

            <div v-else class="msg-row">
              <RouterLink :to="`/user/${m.sender.id}`">
                <Avatar :name="m.sender.nickname" :avatar="m.sender.avatar" size="sm" />
              </RouterLink>
              <div style="min-width: 0; max-width: 76%">
                <div class="msg-sender">{{ m.sender.nickname }}</div>
                <div class="bubble other">{{ m.content }}</div>
                <div class="msg-meta">{{ fmtTime(m.created_at) }}</div>
              </div>
            </div>
          </template>
        </template>
      </div>

      <div class="composer">
        <textarea
          v-model="input"
          rows="1"
          maxlength="2000"
          placeholder="在小组里说点什么…"
          @keydown.enter.exact.prevent="send"
        />
        <button class="btn" :disabled="sending || !input.trim()" @click="send">
          <span v-if="sending" class="spinner" />
          <span v-else>发送</span>
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.chat-layout.group-chat {
  grid-template-columns: 240px 1fr;
}
.msg-sender {
  font-size: 0.72rem;
  color: var(--text-3);
  margin-bottom: 2px;
}
.bubble.other {
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text);
}
@media (max-width: 860px) {
  .chat-layout.group-chat { grid-template-columns: 1fr; }
  .hide-mobile { display: none; }
  .back-btn { display: inline-flex; }
}
.back-btn { display: none; }
</style>
