<script setup lang="ts">
/**
 * 他人资料页。
 *
 * 只展示对方愿意公开的部分，并且刻意不展示原始的六维数值 ——
 * 把一个人的性格量化成数字摆出来会让人被标签化，
 * 所以这里只展示经过解读的摘要和兴趣，把「人」放在「数据」前面。
 */
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { chatApi, matchApi } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/lib/toast';
import Avatar from '@/components/Avatar.vue';
import ScoreRing from '@/components/ScoreRing.vue';
import type { MatchItem } from '@/types';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const { ok, error } = useToast();

const loading = ref(true);
const match = ref<MatchItem | null>(null);
const busy = ref(false);

const uid = computed(() => route.params.id as string);
const isSelf = computed(() => uid.value === auth.user?.id);

onMounted(load);

async function load() {
  loading.value = true;
  if (isSelf.value) {
    router.replace('/profile');
    return;
  }
  try {
    // 只读取资料卡，不产生任何表态 —— 看资料不等于想认识
    const res = await matchApi.profile(uid.value);
    if (res.match) {
      match.value = res.match;
    } else {
      error('找不到这个人');
      router.push('/explore');
    }
  } catch (e: any) {
    error(e?.message || '找不到这个人');
    router.push('/explore');
  } finally {
    loading.value = false;
  }
}

/**
 * 想认识。已有匹配记录就在记录上表态；
 * 还没有记录时走 direct —— 这是真正会写下 like 的动作，只应由点击触发。
 */
async function like() {
  if (!match.value || busy.value) return;
  busy.value = true;
  try {
    const res = match.value.id
      ? await matchApi.act(match.value.id, 'like')
      : await matchApi.direct(uid.value);

    match.value.myAction = 'like';
    if (res.mutual) {
      ok('你们互相看对眼了');
      if (res.conversationId) router.push(`/chat/${res.conversationId}`);
    } else {
      ok('已表达兴趣');
    }
  } catch (e: any) {
    error(e?.message || '操作失败');
  } finally {
    busy.value = false;
  }
}

async function startChat() {
  busy.value = true;
  try {
    const res = await chatApi.openWith(uid.value);
    router.push(`/chat/${res.conversationId}`);
  } catch (e: any) {
    error(e?.message || '打开会话失败');
  } finally {
    busy.value = false;
  }
}

async function pass() {
  if (!match.value?.id) return;
  try {
    await matchApi.act(match.value.id, 'pass');
    match.value.myAction = 'pass';
    ok('已跳过');
    router.push('/match');
  } catch (e: any) {
    error(e?.message || '操作失败');
  }
}
</script>

<template>
  <div class="page narrow">
    <button class="btn ghost sm mb-2" @click="router.back()">← 返回</button>

    <div v-if="loading" class="skeleton" style="height: 340px" />

    <template v-else-if="match">
      <div class="card pad-lg mb-3">
        <div class="row mb-2">
          <Avatar :name="match.user.nickname" :avatar="match.user.avatar" size="xl" />
          <div class="grow" style="min-width: 0">
            <h2 class="mb-0" style="font-size: 1.25rem">{{ match.user.nickname }}</h2>
            <div class="tiny dim">
              {{ match.user.college }}{{ match.user.major ? ' · ' + match.user.major : '' }}{{ match.user.grade ? ' · ' + match.user.grade : '' }}
            </div>
            <div v-if="match.user.contact_pref" class="tag mt-1">偏好{{ match.user.contact_pref }}</div>
          </div>
          <!-- 还没算过匹配分就不显示圆环，避免摆一个 0 分 -->
          <ScoreRing v-if="match.id" :score="match.score" />
        </div>

        <p v-if="match.user.bio" class="pre-wrap">{{ match.user.bio }}</p>

        <div class="divider" />

        <!-- AI 匹配解读 -->
        <div v-if="match.reason" class="alert info">
          <b>为什么你们可能合拍</b>
          <p class="mb-0 mt-1" style="margin: 6px 0 0">{{ match.reason }}</p>
        </div>

        <div v-if="match.common.length" class="mb-2">
          <div class="tiny dim bold mb-1">你们的共鸣</div>
          <div class="tag-row">
            <span v-for="c in match.common" :key="c" class="tag ok">{{ c }}</span>
          </div>
        </div>

        <div v-if="match.complement.length || match.newInterests.length" class="mb-2">
          <div class="tiny dim bold mb-1">对方能带给你新东西的地方</div>
          <div class="tag-row">
            <span
              v-for="c in match.complement.length ? match.complement : match.newInterests"
              :key="c"
              class="tag warn"
            >
              {{ c }}
            </span>
          </div>
        </div>

        <div v-if="match.user.summary" class="mb-2">
          <div class="tiny dim bold mb-1">画像摘要</div>
          <p class="small muted mb-0">{{ match.user.summary }}</p>
        </div>

        <div v-if="(match.user.interests || []).length" class="mb-2">
          <div class="tiny dim bold mb-1">兴趣</div>
          <div class="tag-row">
            <span v-for="i in match.user.interests" :key="i.name" class="tag brand">{{ i.name }}</span>
          </div>
        </div>

        <div v-if="(match.user.goals || []).length" class="mb-2">
          <div class="tiny dim bold mb-1">近期目标</div>
          <div class="tag-row">
            <span v-for="g in match.user.goals" :key="g" class="tag">{{ g }}</span>
          </div>
        </div>

        <div class="row wrap small muted">
          <span v-if="match.user.rhythm">作息：<b>{{ match.user.rhythm }}</b></span>
        </div>
      </div>

      <!-- 操作 -->
      <div class="row">
        <template v-if="match.myAction === 'connected'">
          <button class="btn grow" :disabled="busy" @click="startChat">你们已连接，去聊天</button>
        </template>
        <template v-else-if="match.myAction === 'like'">
          <span class="tag warn grow center" style="padding: 10px">已表达兴趣，等对方回应</span>
        </template>
        <template v-else-if="match.myAction === 'pass'">
          <span class="tag grow center" style="padding: 10px">已跳过</span>
        </template>
        <!-- 还没有匹配记录时也能主动发起；没有 id 就不给「跳过」（跳过需要一条记录可写） -->
        <template v-else>
          <button class="btn grow" :disabled="busy" @click="like">想认识</button>
          <button v-if="match.id" class="btn ghost" :disabled="busy" @click="pass">跳过</button>
        </template>
      </div>
    </template>
  </div>
</template>
