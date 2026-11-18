<script setup lang="ts">
/**
 * 探索页。
 *
 * 和「今日推荐」的区别：这里优先给没推荐过的人，
 * 并且刻意保留一些画像差异大的候选——只推相似的人会让人困在同温层。
 * 所以每张卡片会明示「和你不同的地方」。
 */
import { onMounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { matchApi } from '@/api';
import { useToast } from '@/lib/toast';
import Avatar from '@/components/Avatar.vue';
import ScoreRing from '@/components/ScoreRing.vue';
import type { MatchItem } from '@/types';

const router = useRouter();
const { ok, error } = useToast();

const loading = ref(true);
const list = ref<MatchItem[]>([]);
const needsPersona = ref(false);
const busy = ref<string | null>(null);

onMounted(load);

async function load() {
  loading.value = true;
  try {
    const res = await matchApi.explore(18);
    needsPersona.value = Boolean(res.needsPersona);
    list.value = res.matches || [];
  } catch (e: any) {
    error(e?.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

/** 探索页是主动发起连接，成功后直接进会话 */
async function connect(m: MatchItem) {
  const uid = m.user.id;
  if (busy.value) return;
  busy.value = uid;
  try {
    const res = await matchApi.direct(uid);
    if (res.conversationId) {
      ok('你们互相看对眼了，去聊聊');
      router.push(`/chat/${res.conversationId}`);
    } else {
      ok(`已向 ${m.user.nickname} 表达兴趣`);
      m.myAction = 'like';
    }
  } catch (e: any) {
    error(e?.message || '操作失败');
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">探索</h1>
        <p class="page-sub">跳出你的圈子。这里优先推你还没见过的人，包括和你很不一样的</p>
      </div>
    </div>

    <div v-if="loading" class="card-grid">
      <div v-for="i in 6" :key="i" class="skeleton" style="height: 180px" />
    </div>

    <div v-else-if="needsPersona" class="card pad-lg center">
      <div class="empty-ico">🧭</div>
      <h3>先完成人格画像</h3>
      <RouterLink to="/persona" class="btn">去做画像</RouterLink>
    </div>

    <div v-else-if="!list.length" class="empty">
      <div class="empty-ico">🌱</div>
      <div class="empty-title">暂时没有更多人了</div>
      <p class="small">社区里的人还不够多，过一阵再来看看。</p>
    </div>

    <div v-else class="card-grid">
      <div v-for="m in list" :key="m.user.id" class="card hover">
        <div class="row mb-2">
          <RouterLink :to="`/user/${m.user.id}`">
            <Avatar :name="m.user.nickname" :avatar="m.user.avatar" size="lg" />
          </RouterLink>
          <div class="grow" style="min-width: 0">
            <RouterLink :to="`/user/${m.user.id}`" class="bold" style="color: inherit">
              {{ m.user.nickname }}
            </RouterLink>
            <div class="tiny dim">{{ m.user.college }} · {{ m.user.grade }}</div>
          </div>
          <ScoreRing :score="m.score" />
        </div>

        <p v-if="m.user.summary" class="tiny muted clamp-2" style="margin: 0 0 9px">
          {{ m.user.summary }}
        </p>

        <div class="tag-row mb-2">
          <span v-for="i in (m.user.interests || []).slice(0, 4)" :key="i.name" class="tag">{{ i.name }}</span>
          <span v-if="m.user.rhythm && m.user.rhythm !== '灵活'" class="tag">{{ m.user.rhythm }}</span>
        </div>

        <div v-if="m.common.length" class="tiny mb-1">
          <span class="dim">你们都对 </span>
          <span class="bold">{{ m.common.slice(0, 3).join('、') }}</span>
          <span class="dim"> 有兴趣</span>
        </div>
        <div v-else-if="m.newInterests.length" class="tiny mb-1 muted">
          对方对<span class="bold">{{ m.newInterests.slice(0, 2).join('、') }}</span>有兴趣，是你的盲区
        </div>

        <button
          v-if="!m.myAction || m.myAction === 'none'"
          class="btn block mt-2"
          :disabled="busy === m.user.id"
          @click="connect(m)"
        >
          <span v-if="busy === m.user.id" class="spinner" />
          <span v-else>想认识</span>
        </button>
        <RouterLink v-else :to="`/user/${m.user.id}`" class="btn subtle block mt-2">查看资料</RouterLink>
      </div>
    </div>
  </div>
</template>
