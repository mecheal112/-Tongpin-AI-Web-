<script setup lang="ts">
/** 动态详情 + 评论区 */
import { onMounted, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { postApi } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/lib/toast';
import Avatar from '@/components/Avatar.vue';
import type { Comment, Post } from '@/types';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const { ok, error } = useToast();

const loading = ref(true);
const post = ref<Post | null>(null);
const comments = ref<Comment[]>([]);
const draft = ref('');
const sending = ref(false);

onMounted(load);

async function load() {
  loading.value = true;
  try {
    const id = route.params.id as string;
    const [p, c] = await Promise.all([postApi.get(id), postApi.comments(id)]);
    post.value = p.post;
    comments.value = c.comments || [];
  } catch (e: any) {
    error(e?.message || '动态不存在');
    router.push('/community');
  } finally {
    loading.value = false;
  }
}

async function send() {
  const text = draft.value.trim();
  if (!text || !post.value || sending.value) return;
  sending.value = true;
  try {
    const res = await postApi.comment(post.value.id, text);
    comments.value.push(res.comment);
    post.value.commentCount += 1;
    draft.value = '';
  } catch (e: any) {
    error(e?.message || '评论失败');
  } finally {
    sending.value = false;
  }
}

async function toggleLike() {
  if (!post.value) return;
  try {
    const res = await postApi.like(post.value.id);
    post.value.liked = res.liked;
    post.value.likeCount = res.likeCount;
  } catch (e: any) {
    error(e?.message || '操作失败');
  }
}

/* 举报：选一个理由即提交，进管理后台的举报队列 */
const REPORT_REASONS = ['垃圾广告', '色情低俗', '人身攻击', '违法违规', '其他'];
const reporting = ref(false);
const reported = ref(false);

async function report(reason: string) {
  if (!post.value) return;
  try {
    await postApi.report(post.value.id, reason);
    reported.value = true;
    reporting.value = false;
    ok('已收到举报，管理员会尽快处理');
  } catch (e: any) {
    error(e?.message || '举报失败');
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
    <button class="btn ghost sm mb-2" @click="router.back()">← 返回</button>

    <div v-if="loading" class="col">
      <div class="skeleton" style="height: 180px" />
    </div>

    <template v-else-if="post">
      <article class="card pad-lg mb-3">
        <div class="row mb-2">
          <RouterLink :to="`/user/${post.author.id}`">
            <Avatar :name="post.author.nickname" :avatar="post.author.avatar" size="lg" />
          </RouterLink>
          <div class="grow">
            <RouterLink :to="`/user/${post.author.id}`" class="bold" style="color: inherit">
              {{ post.author.nickname }}
            </RouterLink>
            <div class="tiny dim">
              {{ post.author.college }}{{ post.author.major ? ' · ' + post.author.major : '' }} ·
              {{ relTime(post.createdAt) }}
            </div>
          </div>
        </div>

        <p class="pre-wrap" style="font-size: 1.02rem">{{ post.content }}</p>

        <div v-if="post.topics.length" class="tag-row mb-2">
          <span v-for="t in post.topics" :key="t" class="tag brand"># {{ t }}</span>
        </div>

        <div class="divider" />

        <div class="row" style="gap: 18px">
          <button class="act-btn" :class="{ on: post.liked }" @click="toggleLike">
            {{ post.liked ? '❤️' : '🤍' }} {{ post.likeCount }} 赞
          </button>
          <span class="act-btn">💬 {{ post.commentCount }} 评论</span>
          <button
            v-if="auth.isLoggedIn && post.author.id !== auth.user?.id && !reported"
            class="act-btn"
            style="margin-left: auto"
            @click="reporting = !reporting"
          >
            🚩 举报
          </button>
          <span v-if="reported" class="tiny dim" style="margin-left: auto">已举报，等待处理</span>
        </div>

        <!-- 举报理由 -->
        <div v-if="reporting" class="tag-row" style="margin-top: 10px">
          <span class="tiny dim">举报理由：</span>
          <button v-for="r in REPORT_REASONS" :key="r" class="tag warn report-reason" @click="report(r)">{{ r }}</button>
        </div>
      </article>

      <!-- 评论 -->
      <h3>评论 {{ comments.length ? `(${comments.length})` : '' }}</h3>

      <div v-if="auth.isLoggedIn" class="row mb-3" style="align-items: flex-start">
        <textarea
          v-model="draft"
          class="textarea"
          style="min-height: 68px"
          placeholder="说点什么…"
          @keydown.enter.exact.prevent="send"
        />
        <button class="btn" :disabled="!draft.trim() || sending" @click="send">发送</button>
      </div>

      <div v-if="!comments.length" class="empty" style="padding: 30px">
        <p class="small">还没有评论</p>
      </div>

      <div v-else class="col" style="gap: 12px">
        <div v-for="c in comments" :key="c.id" class="row" style="align-items: flex-start">
          <RouterLink :to="`/user/${c.author_id}`">
            <Avatar :name="c.nickname" :avatar="c.avatar" size="sm" />
          </RouterLink>
          <div class="grow">
            <div class="tiny dim">
              <b style="color: var(--text)">{{ c.nickname }}</b> · {{ relTime(c.created_at) }}
            </div>
            <div class="pre-wrap small">{{ c.content }}</div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.act-btn {
  border: none;
  background: none;
  padding: 2px;
  color: var(--text-3);
  font-size: 0.85rem;
}
.act-btn.on { color: var(--danger); }
.report-reason {
  cursor: pointer;
  border: none;
  font: inherit;
}
</style>
