<script setup lang="ts">
/**
 * 人格画像访谈 —— AI 核心环节之一。
 *
 * 两条路径：
 *   对话访谈：AI 逐轮追问，从自然语言里提炼人格向量
 *   快速提炼：直接粘贴一段自我介绍，让 AI 抽取
 * 完成后可视化 6 维向量，并允许手动微调（用户对 AI 的判断有最终话语权）
 */
import { computed, nextTick, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { personaApi } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/lib/toast';
import type { Dimension } from '@/types';

const auth = useAuthStore();
const router = useRouter();
const { error, ok } = useToast();

const loading = ref(true);
const sending = ref(false);
const tab = ref<'chat' | 'quick'>('chat');

const sessionId = ref<string | null>(null);
const messages = ref<{ role: string; content: string }[]>([]);
const input = ref('');
const done = ref(false);
const turnCount = ref(0);
const minTurns = ref(6);
const persona = ref<any>(null);
const dimensions = ref<Dimension[]>([]);
const quickText = ref('');
const bodyEl = ref<HTMLElement | null>(null);

const canSend = computed(() => input.value.trim().length > 0 && !sending.value && !done.value);

onMounted(load);

async function load() {
  loading.value = true;
  try {
    const res = await personaApi.me();
    persona.value = res.persona;
    dimensions.value = res.dimensions || [];
    minTurns.value = res.minTurns || 6;
    if (res.stage >= 2 && !res.session) {
      done.value = true;
    }
    if (res.session) {
      sessionId.value = res.session.id;
      messages.value = res.session.messages || [];
      turnCount.value = res.session.turnCount || 0;
      if (res.stage >= 2 && !res.session) done.value = true;
    }
    await scrollDown();
  } finally {
    loading.value = false;
  }
}

async function start() {
  sending.value = true;
  try {
    const res = await personaApi.startSession();
    sessionId.value = res.session.id;
    messages.value = res.session.messages || [];
    turnCount.value = res.session.turnCount || 0;
    done.value = false;
    await scrollDown();
  } catch (e: any) {
    error(e?.message || '开始失败');
  } finally {
    sending.value = false;
  }
}

async function send() {
  const text = input.value.trim();
  if (!text || !sessionId.value || sending.value) return;

  messages.value.push({ role: 'user', content: text });
  input.value = '';
  sending.value = true;
  await scrollDown();

  try {
    const res = await personaApi.turn(sessionId.value, text);
    messages.value.push({ role: 'assistant', content: res.reply });
    turnCount.value += 1;
    if (res.done) {
      done.value = true;
      persona.value = res.persona;
      ok('画像已生成');
      await auth.refreshUser();
    }
    await scrollDown();
  } catch (e: any) {
    error(e?.message || '发送失败');
    messages.value.pop();
  } finally {
    sending.value = false;
  }
}

async function submitQuick() {
  if (quickText.value.trim().length < 30) {
    error('至少写 30 个字，信息太少提炼不出来');
    return;
  }
  sending.value = true;
  try {
    const res = await personaApi.quick(quickText.value);
    persona.value = res.persona;
    done.value = true;
    ok('画像已生成');
    await auth.refreshUser();
  } catch (e: any) {
    error(e?.message || '提炼失败');
  } finally {
    sending.value = false;
  }
}

async function restart() {
  if (sessionId.value) {
    try {
      await personaApi.restart(sessionId.value);
    } catch {
      /* 忽略 */
    }
  }
  sessionId.value = null;
  messages.value = [];
  turnCount.value = 0;
  done.value = false;
  persona.value = null;
  await start();
}

async function scrollDown() {
  await nextTick();
  bodyEl.value?.scrollTo({ top: bodyEl.value.scrollHeight, behavior: 'smooth' });
}

/** 把 0-100 的值映射成进度条位置 */
const dimRows = computed(() =>
  (dimensions.value || []).map((d, i) => ({
    ...d,
    value: persona.value?.vector?.[i] ?? 50,
  })),
);
</script>

<template>
  <div class="page narrow">
    <div class="page-head">
      <div>
        <h1 class="page-title">人格画像</h1>
        <p class="page-sub">这是所有匹配的基础。你说得越具体，画像越准。</p>
      </div>
      <button v-if="done || messages.length" class="btn ghost sm" :disabled="sending" @click="restart">
        重新开始
      </button>
    </div>

    <div v-if="loading" class="skeleton" style="height: 320px" />

    <template v-else>
      <!-- 已完成：展示画像 -->
      <template v-if="done && persona">
        <div class="card pad-lg mb-3">
          <h3>AI 眼中的你</h3>
          <p class="muted">{{ persona.summary }}</p>

          <div class="divider" />

          <h4 class="small bold mb-2">六维画像</h4>
          <div v-for="d in dimRows" :key="d.key" class="dim-row">
            <span>{{ d.low }}</span>
            <div class="mid">
              <div class="bar"><i :style="{ width: d.value + '%' }" /></div>
              <div class="dim-marker" :style="{ left: d.value + '%' }" />
            </div>
            <span style="text-align: right">{{ d.high }}</span>
          </div>

          <div class="divider" />

          <div class="mb-2">
            <div class="row between mb-1">
              <div class="small bold">兴趣爱好</div>
              <RouterLink to="/graph" class="tiny link">查看兴趣图谱 →</RouterLink>
            </div>
            <div class="tag-row">
              <span v-for="i in persona.interests || []" :key="i.name" class="tag brand">
                {{ i.name }} · {{ i.weight }}
              </span>
              <span v-if="!(persona.interests || []).length" class="dim small">未识别到</span>
            </div>
          </div>

          <div v-if="(persona.values || []).length" class="mb-2">
            <div class="small bold mb-1">在意的价值</div>
            <div class="tag-row">
              <span v-for="v in persona.values" :key="v" class="tag">{{ v }}</span>
            </div>
          </div>

          <div v-if="(persona.goals || []).length" class="mb-2">
            <div class="small bold mb-1">近期目标</div>
            <div class="tag-row">
              <span v-for="g in persona.goals" :key="g" class="tag">{{ g }}</span>
            </div>
          </div>

          <div class="row wrap small muted">
            <span>作息：<b>{{ persona.rhythm }}</b></span>
          </div>

          <div v-if="persona.ideal_match" class="alert info mt-2 mb-0">
            <b>适合你的人：</b>{{ persona.ideal_match }}
          </div>
        </div>

        <div class="row wrap">
          <RouterLink to="/match" class="btn">去看今日推荐</RouterLink>
          <RouterLink to="/graph" class="btn ghost">查看兴趣图谱</RouterLink>
          <RouterLink to="/" class="btn ghost">返回首页</RouterLink>
        </div>
      </template>

      <!-- 未完成：访谈或快速提炼 -->
      <template v-else>
        <div class="seg mb-2" style="max-width: 320px">
          <button :class="{ on: tab === 'chat' }" @click="tab = 'chat'">对话访谈</button>
          <button :class="{ on: tab === 'quick' }" @click="tab = 'quick'">快速提炼</button>
        </div>

        <!-- 对话访谈 -->
        <div v-if="tab === 'chat'" class="card pad-lg">
          <div v-if="!sessionId" class="center">
            <div class="empty-ico">💬</div>
            <h3>聊聊你自己</h3>
            <p class="muted" style="max-width: 430px; margin: 0 auto 18px">
              大概六七个问题。不用想太久，怎么说话就怎么答，
              这样提炼出来的画像才像你。
            </p>
            <button class="btn lg" :disabled="sending" @click="start">
              <span v-if="sending" class="spinner" />
              <span v-else>开始</span>
            </button>
          </div>

          <template v-else>
            <div ref="bodyEl" class="chat-body" style="max-height: 52vh; padding: 0 0 12px">
              <div
                v-for="(m, idx) in messages"
                :key="idx"
                class="msg-row"
                :class="{ mine: m.role === 'user' }"
              >
                <div class="bubble">{{ m.content }}</div>
              </div>
              <div v-if="sending" class="msg-row">
                <div class="bubble"><span class="spinner" /></div>
              </div>
            </div>

            <div class="row between tiny dim mb-1">
              <span>已聊 {{ turnCount }} 轮{{ turnCount < minTurns ? `（至少 ${minTurns} 轮）` : '' }}</span>
            </div>

            <div class="composer" style="padding: 0; border: none; background: none">
              <textarea
                v-model="input"
                placeholder="说说你的想法…（Enter 发送，Shift+Enter 换行）"
                @keydown.enter.exact.prevent="canSend && send()"
              />
              <button class="btn" :disabled="!canSend" @click="send">发送</button>
            </div>
          </template>
        </div>

        <!-- 快速提炼 -->
        <div v-else class="card pad-lg">
          <h3>直接粘贴一段自我介绍</h3>
          <p class="muted small">
            比如你的朋友圈签名、日记片段，或者随便写写自己是什么样的人。
            写得越细，提炼越准（至少 30 字）。
          </p>
          <textarea
            v-model="quickText"
            class="textarea"
            style="min-height: 170px"
            placeholder="我平时喜欢…，性格偏…，最近在忙…，希望认识…的人"
          />
          <div class="row between mt-1">
            <span class="tiny dim">{{ quickText.length }} 字</span>
            <button class="btn" :disabled="sending || quickText.trim().length < 30" @click="submitQuick">
              <span v-if="sending" class="spinner" />
              <span v-else>提炼画像</span>
            </button>
          </div>
        </div>
      </template>
    </template>
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
</style>
