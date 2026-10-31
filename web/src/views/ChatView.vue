<script setup lang="ts">
/**
 * 聊天页 —— 破冰脚手架的核心界面。
 *
 * 界面上要让「AI 会退场」这件事可见：
 *   active  第一次进来直接给 3 条可用开场白
 *   fading  折叠成一个小提示，不再占据视线
 *   retired 完全不出现在对话流里，只在页头留一个可召回的入口
 *
 * 这样设计是因为：如果一个产品把 AI 藏在后台，用户感受到的是「产品在干预」；
 * 把它的进出显式化，用户感受到的是「它帮我启动了关系，然后走开了」。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { chatApi } from '@/api';
import { connectSocket, getSocket } from '@/lib/socket';
import { useBadgeStore } from '@/stores/badge';
import { useToast } from '@/lib/toast';
import Avatar from '@/components/Avatar.vue';
import type { ConversationSummary, Icebreaker, Message, Nudge, ScaffoldState } from '@/types';

const route = useRoute();
const router = useRouter();
const { error, ok } = useToast();
const badges = useBadgeStore();

const convs = ref<ConversationSummary[]>([]);
const loadingConvs = ref(true);
const active = ref<any>(null);
const messages = ref<Message[]>([]);
const loadingMsgs = ref(false);
const input = ref('');
const sending = ref(false);
const openers = ref<Icebreaker[]>([]);
const loadingOpeners = ref(false);
const nudge = ref<Nudge | null>(null);
const typing = ref(false);
const bodyEl = ref<HTMLElement | null>(null);
const scaffoldState = ref<ScaffoldState>('none');
let typingTimer: number | undefined;

const convId = computed(() => route.params.id as string | undefined);
const retired = computed(() => scaffoldState.value === 'retired');

onMounted(async () => {
  connectSocket();
  const s = getSocket();
  s?.on('message:new', onIncoming);
  s?.on('typing', onTyping);
  await loadConvs();
  if (convId.value) await openConv(convId.value);
});

onUnmounted(() => {
  const s = getSocket();
  s?.off('message:new', onIncoming);
  s?.off('typing', onTyping);
  if (typingTimer) window.clearTimeout(typingTimer);
  // 页面停留期间可能来过新消息，离开时和侧栏对一次
  badges.refresh();
});

watch(convId, async (id, prev) => {
  if (prev) getSocket()?.emit('conv:leave', { convId: prev });
  if (id) await openConv(id);
  else {
    active.value = null;
    messages.value = [];
    openers.value = [];
  }
});

function onIncoming(msg: Message) {
  if (msg.conv_id !== convId.value) {
    loadConvs();
    // 正在看别的会话时，这条消息是新的未读，直接反映到红点上
    badges.refresh();
    return;
  }
  if (messages.value.some((m) => m.id === msg.id)) return;
  messages.value.push(msg);
  scrollDown();
  if (msg.kind === 'system') {
    // 脚手架退场的系统提示会推到这里，同步一下状态
    if (msg.content.includes('我先撤了')) scaffoldState.value = 'retired';
  }
}

function onTyping(payload: { convId: string; userId: string; typing: boolean }) {
  if (payload.convId !== convId.value) return;
  typing.value = payload.typing;
  if (typingTimer) window.clearTimeout(typingTimer);
  if (payload.typing) {
    typingTimer = window.setTimeout(() => (typing.value = false), 4000);
  }
}

async function loadConvs() {
  loadingConvs.value = true;
  try {
    const res = await chatApi.conversations();
    convs.value = res.conversations || [];
    // 会话列表的未读之和就是私信红点，本地直接对齐，省一次请求
    badges.setChat(convs.value.reduce((sum, c) => sum + (c.unread || 0), 0));
  } catch (e: any) {
    error(e?.message || '加载会话失败');
  } finally {
    loadingConvs.value = false;
  }
}

async function openConv(id: string) {
  loadingMsgs.value = true;
  openers.value = [];
  nudge.value = null;
  try {
    getSocket()?.emit('conv:join', { convId: id });
    const res = await chatApi.detail(id);
    active.value = res.conversation;
    messages.value = res.messages || [];
    scaffoldState.value = res.conversation.scaffoldState;
    nudge.value = res.nudge?.needed ? res.nudge : null;
    await scrollDown();

    // 本地先把这条会话的未读抹掉，红点即时消失，再让服务端确认
    const opened = convs.value.find((c) => c.id === id);
    if (opened?.unread) {
      badges.setChat(badges.chat - opened.unread);
      opened.unread = 0;
    }
    chatApi
      .read(id)
      .then(() => badges.refresh())
      .catch(() => {});

    // 只有双方还没聊起来时才主动推开场白，避免打扰已经熟了的人
    const humanCount = messages.value.filter((m) => m.kind === 'text').length;
    if (scaffoldState.value === 'active' && humanCount < 3) {
      loadOpeners(id);
    }
  } catch (e: any) {
    error(e?.message || '会话不存在');
    router.push('/chat');
  } finally {
    loadingMsgs.value = false;
  }
}

async function loadOpeners(id: string) {
  loadingOpeners.value = true;
  try {
    const res = await chatApi.icebreakers(id);
    openers.value = res.openers || [];
  } catch {
    /* 开场白拿不到不影响正常聊天 */
  } finally {
    loadingOpeners.value = false;
  }
}

async function send() {
  const text = input.value.trim();
  if (!text || !convId.value || sending.value) return;
  sending.value = true;
  try {
    const res = await chatApi.send(convId.value, text);
    input.value = '';
    if (!messages.value.some((m) => m.id === res.message.id)) {
      messages.value.push(res.message);
    }
    openers.value = [];
    nudge.value = null;
    scaffoldState.value = res.scaffoldState || scaffoldState.value;
    if (res.moderation) {
      ok('内容已通过审核，但被标记为需要关注');
    }
    await scrollDown();
    loadConvs();
  } catch (e: any) {
    error(e?.message || '发送失败');
  } finally {
    sending.value = false;
  }
}

/** 点开场白直接填入输入框，用户可改可发 —— 不替用户说话 */
function useOpener(text: string) {
  input.value = text;
  nextTick(() => {
    const ta = document.querySelector<HTMLTextAreaElement>('.composer textarea');
    ta?.focus();
  });
}

async function askNudge() {
  if (!convId.value) return;
  try {
    const res = await chatApi.nudge(convId.value);
    if (res.needed) {
      nudge.value = res;
    } else {
      ok('聊得挺顺的，暂时不用我插话');
      nudge.value = null;
    }
  } catch (e: any) {
    error(e?.message || '获取建议失败');
  }
}

async function recall() {
  if (!convId.value) return;
  try {
    await chatApi.scaffold(convId.value, 'recall');
    scaffoldState.value = 'active';
    await loadOpeners(convId.value);
    ok('已叫回破冰助手');
  } catch (e: any) {
    error(e?.message || '操作失败');
  }
}

async function retire() {
  if (!convId.value) return;
  try {
    await chatApi.scaffold(convId.value, 'retire');
    scaffoldState.value = 'retired';
    openers.value = [];
    nudge.value = null;
    ok('已让助手退场，需要时随时叫回');
  } catch (e: any) {
    error(e?.message || '操作失败');
  }
}

function onInput() {
  getSocket()?.emit('typing', { convId: convId.value, typing: input.value.length > 0 });
}

async function scrollDown() {
  await nextTick();
  bodyEl.value?.scrollTo({ top: bodyEl.value.scrollHeight, behavior: 'smooth' });
}

function fmtTime(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/* 举报对方消息：点 🚩 展开理由，选一个即提交 */
const REPORT_REASONS = ['垃圾广告', '色情低俗', '人身攻击', '违法违规', '其他'];
const reportTarget = ref<string | null>(null);
const reportedIds = ref(new Set<string>());

async function reportMsg(msgId: string, reason: string) {
  try {
    await chatApi.report(msgId, reason);
    reportedIds.value.add(msgId);
    reportTarget.value = null;
    ok('已收到举报，管理员会尽快处理');
  } catch (e: any) {
    error(e?.message || '举报失败');
  }
}

function relTime(ts: number) {
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}
</script>

<template>
  <div class="chat-layout">
    <!-- 会话列表 -->
    <aside class="conv-list" :class="{ 'hide-mobile': convId }">
      <div class="chat-head">
        <b>消息</b>
      </div>
      <div v-if="loadingConvs" class="col" style="padding: 12px">
        <div v-for="i in 4" :key="i" class="skeleton" style="height: 52px" />
      </div>
      <div v-else-if="!convs.length" class="empty" style="padding: 34px 16px">
        <div class="empty-ico">💬</div>
        <div class="empty-title">还没有会话</div>
        <p class="tiny">互相表达兴趣后，这里会出现对话</p>
        <RouterLink to="/match" class="btn subtle sm">去找人</RouterLink>
      </div>
      <RouterLink
        v-for="c in convs"
        v-else
        :key="c.id"
        :to="`/chat/${c.id}`"
        class="conv-item"
        :class="{ active: c.id === convId }"
      >
        <Avatar :name="c.user.nickname" :avatar="c.user.avatar" :online="c.online" />
        <div class="conv-body">
          <div class="conv-top">
            <span class="conv-name">{{ c.user.nickname }}</span>
            <span class="conv-time">{{ fmtTime(c.lastAt) }}</span>
          </div>
          <div class="conv-preview">{{ c.lastMessage || '开始聊天吧' }}</div>
        </div>
        <span v-if="c.unread" class="nav-badge">{{ c.unread > 99 ? '99+' : c.unread }}</span>
      </RouterLink>
    </aside>

    <!-- 对话区 -->
    <section class="chat-main" :class="{ 'hide-mobile': !convId }">
      <template v-if="!active">
        <div class="empty" style="margin: auto">
          <div class="empty-ico">👈</div>
          <div class="empty-title">选一个对话开始</div>
          <p class="small">破冰助手会基于你们两个人的画像，给出可以直接用的开场白</p>
        </div>
      </template>

      <template v-else>
        <header class="chat-head">
          <RouterLink to="/chat" class="btn ghost sm back-btn">←</RouterLink>
          <Avatar :name="active.user.nickname" :avatar="active.user.avatar" :online="active.user.online" />
          <div class="grow" style="min-width: 0">
            <div class="bold" style="font-size: 0.94rem">{{ active.user.nickname }}</div>
            <div class="tiny dim">
              {{ active.user.college || '' }}{{ active.user.grade ? ' · ' + active.user.grade : '' }}
              <span v-if="active.user.online" style="color: var(--ok)"> · 在线</span>
            </div>
          </div>
          <RouterLink :to="`/user/${active.user.id}`" class="btn ghost sm">资料</RouterLink>
        </header>

        <!-- 脚手架状态条：让 AI 的在退场过程可见 -->
        <div v-if="scaffoldState !== 'retired'" class="scaffold-bar">
          <span class="scaffold-label">
            <template v-if="scaffoldState === 'active'">🤝 破冰助手在场：正在帮你们把话头接上</template>
            <template v-else>🤝 破冰助手：只在卡壳时才会出现</template>
          </span>
          <button class="link-btn" @click="retire">让它退场</button>
        </div>
        <div v-else class="scaffold-bar retired">
          <span class="scaffold-label dim">🤝 破冰助手已退场，你们的对话由自己掌握</span>
          <button class="link-btn" @click="recall">叫回来</button>
        </div>

        <div ref="bodyEl" class="chat-body">
          <div v-if="loadingMsgs" class="col">
            <div v-for="i in 4" :key="i" class="skeleton" style="height: 44px" />
          </div>

          <template v-else>
            <!-- 开场白卡片 -->
            <div v-if="openers.length" class="scaffold-card">
              <div class="scaffold-head">
                <span>✨</span>
                <span>基于你们俩的画像，这几句可以直接发</span>
              </div>
              <div v-if="loadingOpeners" class="skeleton" style="height: 60px" />
              <button v-for="(o, i) in openers" :key="i" class="opener" @click="useOpener(o.text)">
                <div class="opener-angle">{{ o.angle }}</div>
                <div>{{ o.text }}</div>
              </button>
              <p class="tiny dim" style="margin: 6px 0 0">
                点一下填进输入框，你可以改过再发 —— 这是你的话，不是它的话。
              </p>
            </div>

            <!-- AI 介入建议 -->
            <div v-else-if="nudge?.needed" class="scaffold-card">
              <div class="scaffold-head">
                <span>💡</span>
                <span>感觉你们的对话停了一下</span>
              </div>
              <button class="opener" @click="useOpener(nudge.suggestion || '')">
                <div class="opener-angle">{{ nudge.state === 'unbalanced' ? '平衡话头' : '重新起个头' }}</div>
                <div>{{ nudge.suggestion }}</div>
              </button>
              <p class="tiny dim" style="margin: 6px 0 0">{{ nudge.reason }}</p>
            </div>

            <!-- 消息流 -->
            <template v-for="m in messages" :key="m.id">
              <div v-if="m.kind === 'system'" class="msg-system">{{ m.content }}</div>
              <div v-else class="msg-row" :class="{ mine: m.sender_id !== active.user.id }">
                <Avatar
                  v-if="m.sender_id === active.user.id"
                  :name="active.user.nickname"
                  :avatar="active.user.avatar"
                  size="sm"
                />
                <div>
                  <div class="bubble">{{ m.content }}</div>
                  <div class="msg-meta">
                    {{ fmtTime(m.created_at) }}
                    <button
                      v-if="m.sender_id === active.user.id && m.kind === 'text' && !reportedIds.has(m.id)"
                      class="report-btn"
                      @click="reportTarget = reportTarget === m.id ? null : m.id"
                    >
                      🚩 举报
                    </button>
                    <span v-if="reportedIds.has(m.id)" class="tiny dim">已举报</span>
                  </div>
                  <div v-if="reportTarget === m.id" class="tag-row" style="margin-top: 4px">
                    <span class="tiny dim">理由：</span>
                    <button
                      v-for="r in REPORT_REASONS"
                      :key="r"
                      class="tag warn report-reason"
                      @click="reportMsg(m.id, r)"
                    >
                      {{ r }}
                    </button>
                  </div>
                </div>
              </div>
            </template>

            <div v-if="typing" class="typing-hint">对方正在输入…</div>
          </template>
        </div>

        <div class="composer">
          <textarea
            v-model="input"
            rows="1"
            placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"
            @input="onInput"
            @keydown.enter.exact.prevent="send"
          />
          <button v-if="!retired" class="btn ghost" title="让助手看看" @click="askNudge">求助</button>
          <button class="btn" :disabled="!input.trim() || sending" @click="send">
            <span v-if="sending" class="spinner" />
            <span v-else>发送</span>
          </button>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.scaffold-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 16px;
  background: var(--brand-50);
  border-bottom: 1px solid var(--border);
  font-size: 0.79rem;
  flex-shrink: 0;
}
@media (prefers-color-scheme: dark) {
  .scaffold-bar { background: var(--brand-100); }
}
.scaffold-bar.retired { background: var(--surface-2); }
.scaffold-label { color: var(--brand-700); }
@media (prefers-color-scheme: dark) {
  .scaffold-label { color: var(--brand-400); }
}
.link-btn {
  border: none;
  background: none;
  color: var(--text-3);
  font-size: 0.76rem;
  text-decoration: underline;
  flex-shrink: 0;
}
.back-btn { display: none; }
.hide-mobile { display: flex; }

@media (max-width: 860px) {
  .back-btn { display: inline-flex; }
  .conv-list.hide-mobile { display: none; }
  .chat-main.hide-mobile { display: none; }
  .chat-layout { display: block; }
}

/* 举报入口：悬停才出现，不打扰正常阅读 */
.report-btn {
  border: none;
  background: none;
  font-size: 0.72rem;
  color: var(--text-3);
  opacity: 0;
  cursor: pointer;
  padding: 0 4px;
  font-family: inherit;
}
.msg-row:hover .report-btn {
  opacity: 1;
}
.report-reason {
  cursor: pointer;
  border: none;
  font: inherit;
}
</style>
