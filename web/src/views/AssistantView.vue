<script setup lang="ts">
/**
 * 社群助手 —— W2 核心界面。
 *
 * 一个多轮问答页：用户问、助手基于「社区动态」检索并作答，答案带 [n] 出处，
 * 出处是真实帖子，点开能溯源。会话在服务端单活跃、FIFO 20 条。
 *
 * 无 Key 时助手退化为「本地 TF-IDF 检索 + 模板答案」，界面顶部给一行提示，
 * 让演示时能一眼说清「当前是本地引擎还是大模型」。
 */
import { nextTick, onMounted, ref } from 'vue';
import { assistantApi } from '@/api';
import { useToast } from '@/lib/toast';
import type { AssistantMessage, AssistantSource } from '@/types';

const { error } = useToast();

const messages = ref<AssistantMessage[]>([]);
const input = ref('');
const sending = ref(false);
const loading = ref(true);
const degraded = ref(false);
const sessionId = ref<string | undefined>(undefined);
const bodyEl = ref<HTMLElement | null>(null);

/** 最近一条助手回答的参考动态（溯源列表） */
const sources = ref<AssistantSource[]>([]);
const showSources = ref(false);

onMounted(load);

async function load() {
  loading.value = true;
  try {
    const res = await assistantApi.history();
    messages.value = res.messages || [];
    scrollDown();
  } catch {
    /* 历史拿不到不阻塞提问 */
  } finally {
    loading.value = false;
  }
}

async function send() {
  const q = input.value.trim();
  if (!q || sending.value) return;
  sending.value = true;
  messages.value.push({ role: 'user', content: q });
  input.value = '';
  await scrollDown();

  try {
    const res = await assistantApi.ask(q, sessionId.value);
    sessionId.value = res.session_id;
    degraded.value = res.degraded;
    messages.value.push({ role: 'assistant', content: res.answer, citations: res.citations });
    sources.value = res.sources || [];
    if (res.degraded) showSources.value = true;
    await scrollDown();
  } catch (e: any) {
    error(e?.message || '助手暂时不可用');
    messages.value.push({ role: 'assistant', content: '抱歉，助手出了点问题，稍后再试。' });
  } finally {
    sending.value = false;
  }
}

async function reset() {
  try {
    await assistantApi.reset();
  } catch {
    /* 重置失败也照常清空本地 */
  }
  messages.value = [];
  sources.value = [];
  sessionId.value = undefined;
  degraded.value = false;
  showSources.value = false;
}

async function scrollDown() {
  await nextTick();
  bodyEl.value?.scrollTo({ top: bodyEl.value.scrollHeight, behavior: 'smooth' });
}
</script>

<template>
  <div class="page asst-page">
    <div class="page-head">
      <div>
        <h1 class="page-title">社群助手 🤖</h1>
        <p class="page-sub">基于社区里的真实动态回答你的问题，答案带出处，点开能溯源。</p>
      </div>
      <button class="btn ghost sm" :disabled="!messages.length" @click="reset">重开会话</button>
    </div>

    <div v-if="degraded" class="alert info mb-2">
      当前为本地语义引擎结果（未配置大模型）：检索走 TF-IDF、答案走模板。配置 API Key 后自动切换为大模型 + 向量检索。
    </div>

    <div class="card asst-card">
      <div ref="bodyEl" class="chat-body asst-body">
        <div v-if="loading" class="col" style="padding: 12px">
          <div v-for="i in 4" :key="i" class="skeleton" style="height: 44px" />
        </div>

        <div v-else-if="!messages.length" class="empty" style="margin: auto">
          <div class="empty-ico">🤖</div>
          <div class="empty-title">问问社区里的事</div>
          <p class="small" style="max-width: 360px; margin: 0 auto 12px">
            「有没有人一起跑步」「高数复习有什么资源」「哪个实验室在招人」—— 我会从最近的动态里找答案。
          </p>
          <div class="tag-row" style="justify-content: center">
            <button v-for="s in ['有人一起跑步吗', '最近有什么活动', '考研搭子']" :key="s" class="tag brand" @click="input = s; send()">
              {{ s }}
            </button>
          </div>
        </div>

        <template v-else>
          <div v-for="(m, i) in messages" :key="i" class="msg-row" :class="{ mine: m.role === 'user' }">
            <div class="asst-avatar">{{ m.role === 'user' ? '👤' : '🤖' }}</div>
            <div class="asst-msg">
              <div class="bubble" style="white-space: pre-wrap">{{ m.content }}</div>
              <div v-if="m.citations?.length" class="cite-row">
                <span class="tiny dim">出处：</span>
                <RouterLink
                  v-for="c in m.citations"
                  :key="c.post_id"
                  :to="`/post/${c.post_id}`"
                  class="tag brand sm cite-chip"
                  :title="c.quote"
                >
                  {{ c.quote || '查看原文' }}
                </RouterLink>
              </div>
            </div>
          </div>

          <!-- 参考动态溯源列表 -->
          <div v-if="sources.length && showSources" class="sources-panel">
            <button class="link-btn" @click="showSources = !showSources">
              {{ showSources ? '收起' : '展开' }}参考动态（{{ sources.length }}）
            </button>
            <template v-if="showSources">
              <RouterLink
                v-for="s in sources"
                :key="s.post_id"
                :to="`/post/${s.post_id}`"
                class="source-item"
              >
                <span class="source-excerpt">「{{ s.excerpt }}」</span>
                <span class="tiny dim">{{ s.author }}</span>
              </RouterLink>
            </template>
          </div>
        </template>
      </div>

      <div class="composer">
        <textarea
          v-model="input"
          rows="1"
          placeholder="问问社区动态…（Enter 发送，Shift+Enter 换行）"
          @keydown.enter.exact.prevent="send"
        />
        <button class="btn" :disabled="!input.trim() || sending" @click="send">
          <span v-if="sending" class="spinner" />
          <span v-else>发送</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.asst-page {
  max-width: 760px;
  margin: 0 auto;
}
.asst-card {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 190px);
  min-height: 420px;
  overflow: hidden;
  padding: 0;
}
.asst-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}
.asst-avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--surface-2);
  display: grid;
  place-items: center;
  font-size: 1rem;
  flex-shrink: 0;
}
.asst-msg {
  min-width: 0;
  max-width: 82%;
}
.cite-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-top: 6px;
}
.cite-chip {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  border: none;
  font: inherit;
  text-decoration: none;
}
.sources-panel {
  margin-top: 12px;
  padding: 10px 12px;
  background: var(--surface-2);
  border-radius: 10px;
}
.source-item {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 10px;
  padding: 7px 0;
  border-bottom: 1px solid var(--border);
  text-decoration: none;
  color: inherit;
}
.source-item:last-child {
  border-bottom: none;
}
.source-excerpt {
  font-size: 0.83rem;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.source-item:hover .source-excerpt {
  color: var(--brand-600);
}
.link-btn {
  border: none;
  background: none;
  color: var(--brand-600);
  font-size: 0.78rem;
  cursor: pointer;
  padding: 0 0 6px;
  font-family: inherit;
}
</style>
