<script setup lang="ts">
/** 首页：根据画像状态分流，已完成的给今日推荐入口 + 概览 */
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useBadgeStore } from '@/stores/badge';
import { matchApi, personaApi } from '@/api';
import Avatar from '@/components/Avatar.vue';
import ScoreRing from '@/components/ScoreRing.vue';
import type { MatchItem } from '@/types';

const auth = useAuthStore();
const badges = useBadgeStore();
const loading = ref(true);
const matches = ref<MatchItem[]>([]);
const persona = ref<any>(null);

onMounted(async () => {
  try {
    const p = await personaApi.me();
    persona.value = p.persona;
    if (p.stage >= 2) {
      const res = await matchApi.daily(3);
      matches.value = res.matches || [];
    }
    await badges.refresh();
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="page">
    <div v-if="loading" class="col">
      <div class="skeleton" style="height: 92px" />
      <div class="skeleton" style="height: 150px" />
    </div>

    <template v-else>
      <div class="page-head">
        <div>
          <h1 class="page-title">你好，{{ auth.user?.nickname }}</h1>
          <p class="page-sub">
            <template v-if="!auth.hasPersona">先完成人格画像，才能开始匹配</template>
            <template v-else>今天也有几个人在等一个同频的人</template>
          </p>
        </div>
      </div>

      <!-- 未完成画像：引导 -->
      <div v-if="!auth.hasPersona" class="card pad-lg center">
        <div class="empty-ico">🧭</div>
        <h2>先让 AI 认识一下你</h2>
        <p class="muted" style="max-width: 460px; margin: 0 auto 18px">
          匹配的基础是了解你。接下来我会问你六七个问题，大概三分钟。
          聊完我会生成一份人格画像，之后所有推荐都基于它。
        </p>
        <RouterLink to="/persona" class="btn lg">开始画像访谈</RouterLink>
      </div>

      <template v-else>
        <!-- 画像摘要 -->
        <div v-if="persona" class="card mb-3">
          <div class="row between mb-1">
            <h3 class="mb-0">你的人格画像</h3>
            <RouterLink to="/persona" class="small">重新访谈</RouterLink>
          </div>
          <p class="muted mb-2" style="margin-top: 4px">{{ persona.summary }}</p>
          <div class="tag-row">
            <span v-for="i in (persona.interests || []).slice(0, 6)" :key="i.name" class="tag brand">
              {{ i.name }}
            </span>
            <span v-if="persona.rhythm && persona.rhythm !== '灵活'" class="tag">{{ persona.rhythm }}</span>
          </div>
        </div>

        <!-- 今日推荐 -->
        <div class="row between mb-2">
          <h2 class="mb-0">今日同频</h2>
          <RouterLink to="/match" class="small">查看全部 →</RouterLink>
        </div>

        <div v-if="matches.length" class="card-grid">
          <RouterLink
            v-for="m in matches"
            :key="m.id || m.user.id"
            :to="`/user/${m.user.id}`"
            class="card hover"
            style="display: block; color: inherit"
          >
            <div class="row mb-2">
              <Avatar :name="m.user.nickname" :avatar="m.user.avatar" size="lg" />
              <div class="grow" style="min-width: 0">
                <div class="bold">{{ m.user.nickname }}</div>
                <div class="tiny dim">{{ m.user.college }} · {{ m.user.grade }}</div>
              </div>
              <ScoreRing :score="m.score" />
            </div>
            <p class="small clamp-3" style="margin: 0">{{ m.reason }}</p>
          </RouterLink>
        </div>

        <div v-else class="card center muted">
          <p class="mb-1">今天的推荐还没生成</p>
          <RouterLink to="/match" class="btn subtle">去匹配页看看</RouterLink>
        </div>
      </template>

      <!-- 快捷入口 -->
      <h2 class="mt-3 mb-2">去哪儿看看</h2>
      <div class="quick-grid">
        <RouterLink to="/chat" class="quick card hover">
          <span class="quick-ico">💬</span>
          <div>
            <div class="bold">消息</div>
            <div class="tiny dim">{{ badges.chat ? `${badges.chat} 条未读` : '和匹配到的人聊聊' }}</div>
          </div>
        </RouterLink>
        <RouterLink to="/community" class="quick card hover">
          <span class="quick-ico">🌱</span>
          <div>
            <div class="bold">校园社区</div>
            <div class="tiny dim">看看别人在经历什么</div>
          </div>
        </RouterLink>
        <RouterLink to="/groups" class="quick card hover">
          <span class="quick-ico">👥</span>
          <div>
            <div class="bold">同频局</div>
            <div class="tiny dim">找人一起做点事</div>
          </div>
        </RouterLink>
        <RouterLink to="/explore" class="quick card hover">
          <span class="quick-ico">🧭</span>
          <div>
            <div class="bold">探索</div>
            <div class="tiny dim">跳出你的同温层</div>
          </div>
        </RouterLink>
      </div>
    </template>
  </div>
</template>

<style scoped>
.quick-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 12px;
}
.quick {
  display: flex;
  align-items: center;
  gap: 12px;
  color: inherit;
}
.quick-ico { font-size: 26px; }
</style>
