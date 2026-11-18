<script setup lang="ts">
/**
 * 社区动态流。
 * 发帖走 AI 审核 + 自动打标：被拦截的内容不会出现在流里，
 * 打了旗标的照常展示但会在后台标出来供管理员复核。
 */
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { postApi } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/lib/toast';
import Avatar from '@/components/Avatar.vue';
import type { Moderation, Post } from '@/types';

const auth = useAuthStore();
const { ok, error } = useToast();

const loading = ref(true);
const posts = ref<Post[]>([]);
const topics = ref<{ name: string; count: number }[]>([]);
const activeTopic = ref('');
const draft = ref('');
const posting = ref(false);
const mod = ref<Moderation | null>(null);
const showComposer = ref(false);

const canPost = computed(() => draft.value.trim().length > 0 && !posting.value);

onMounted(async () => {
  await Promise.all([load(), loadTopics()]);
});

async function load() {
  loading.value = true;
  try {
    const res = await postApi.list(24, 0, activeTopic.value);
    posts.value = res.posts || [];
  } catch (e: any) {
    error(e?.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

async function loadTopics() {
  try {
    const res = await postApi.topics();
    topics.value = res.topics || [];
  } catch {
    /* 话题拿不到不影响主流程 */
  }
}

function pickTopic(t: string) {
  activeTopic.value = activeTopic.value === t ? '' : t;
  load();
}

async function publish() {
  if (!canPost.value) return;
  posting.value = true;
  mod.value = null;
  try {
    const res = await postApi.create(draft.value.trim());
    posts.value.unshift(res.post);
    draft.value = '';
    showComposer.value = false;
    if (res.moderation?.status === 'flagged') {
      mod.value = res.moderation;
      ok('已发布，但内容被标记为需要关注');
    } else {
      ok('已发布');
    }
  } catch (e: any) {
    // 被拦截时后端返回 422，附带审核详情
    const payload = e?.payload?.moderation;
    if (payload) {
      mod.value = payload;
      error('这条内容没有通过安全审核');
    } else {
      error(e?.message || '发布失败');
    }
  } finally {
    posting.value = false;
  }
}

async function toggleLike(p: Post) {
  try {
    const res = await postApi.like(p.id);
    p.liked = res.liked;
    p.likeCount = res.likeCount;
  } catch (e: any) {
    error(e?.message || '操作失败');
  }
}

async function remove(p: Post) {
  if (!confirm('确定删除这条动态？')) return;
  try {
    await postApi.remove(p.id);
    posts.value = posts.value.filter((x) => x.id !== p.id);
    ok('已删除');
  } catch (e: any) {
    error(e?.message || '删除失败');
  }
}

function relTime(ts: number) {
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
  if (d < 604800000) return `${Math.floor(d / 86400000)} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">校园社区</h1>
        <p class="page-sub">说说你在经历什么。所有内容都会经过安全审核</p>
      </div>
      <button v-if="auth.isLoggedIn" class="btn" @click="showComposer = !showComposer">
        {{ showComposer ? '收起' : '发一条' }}
      </button>
    </div>

    <!-- 发帖框 -->
    <div v-if="showComposer && auth.isLoggedIn" class="card pad-lg mb-3">
      <textarea
        v-model="draft"
        class="textarea"
        placeholder="今天发生了什么？不用组织语言，怎么想就怎么写"
      />
      <div class="row between mt-1">
        <span class="tiny dim">{{ draft.length }} / 2000</span>
        <button class="btn" :disabled="!canPost" @click="publish">
          <span v-if="posting" class="spinner" />
          <span v-else>发布</span>
        </button>
      </div>
      <div v-if="mod" class="alert" :class="mod.status === 'blocked' ? 'danger' : 'warn'" style="margin: 12px 0 0">
        <b>审核结果：{{ mod.status === 'blocked' ? '已拦截' : '已标记' }}</b>
        <div>{{ mod.reason }}</div>
        <div v-if="mod.labels.length" class="tag-row mt-1">
          <span v-for="l in mod.labels" :key="l" class="tag danger">{{ l }}</span>
        </div>
        <div v-if="mod.need_support" class="mt-1">
          如果最近状态不好，学校心理中心有免费咨询，随时可以去聊聊。
          <RouterLink to="/help">查看资源</RouterLink>
        </div>
      </div>
    </div>

    <!-- 话题筛选 -->
    <div v-if="topics.length" class="tag-row mb-3">
      <button
        v-for="t in topics"
        :key="t.name"
        class="topic-chip"
        :class="{ on: activeTopic === t.name }"
        @click="pickTopic(t.name)"
      >
        {{ t.name }} <span class="dim">{{ t.count }}</span>
      </button>
    </div>

    <div v-if="loading" class="col">
      <div v-for="i in 4" :key="i" class="skeleton" style="height: 130px" />
    </div>

    <div v-else-if="!posts.length" class="empty">
      <div class="empty-ico">🌱</div>
      <div class="empty-title">{{ activeTopic ? '这个话题下还没有内容' : '还没有人发动态' }}</div>
      <p class="small">成为第一个开口的人</p>
    </div>

    <div v-else class="col" style="gap: 13px">
      <article v-for="p in posts" :key="p.id" class="card">
        <div class="row mb-2">
          <RouterLink :to="`/user/${p.author.id}`">
            <Avatar :name="p.author.nickname" :avatar="p.author.avatar" />
          </RouterLink>
          <div class="grow" style="min-width: 0">
            <RouterLink :to="`/user/${p.author.id}`" class="bold" style="color: inherit; font-size: 0.92rem">
              {{ p.author.nickname }}
            </RouterLink>
            <div class="tiny dim">
              {{ p.author.college || '' }}{{ p.author.grade ? ' · ' + p.author.grade : '' }} ·
              {{ relTime(p.createdAt) }}
            </div>
          </div>
          <span v-if="p.modStatus === 'flagged'" class="tag warn" title="已被标记，等待人工复核">待复核</span>
          <button
            v-if="p.author.id === auth.user?.id || auth.isAdmin"
            class="link-btn"
            @click="remove(p)"
          >
            删除
          </button>
        </div>

        <RouterLink :to="`/post/${p.id}`" style="color: inherit">
          <p class="pre-wrap" style="margin: 0 0 10px">{{ p.content }}</p>
        </RouterLink>

        <div v-if="p.topics.length" class="tag-row mb-2">
          <RouterLink
            v-for="t in p.topics"
            :key="t"
            :to="`/community`"
            class="tag"
            @click="pickTopic(t)"
          >
            # {{ t }}
          </RouterLink>
        </div>

        <div class="row" style="gap: 16px">
          <button class="act-btn" :class="{ on: p.liked }" @click="toggleLike(p)">
            {{ p.liked ? '❤️' : '🤍' }} {{ p.likeCount || '' }}
          </button>
          <RouterLink :to="`/post/${p.id}`" class="act-btn">
            💬 {{ p.commentCount || '' }}
          </RouterLink>
        </div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.topic-chip {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-2);
  padding: 4px 11px;
  border-radius: 999px;
  font-size: 0.8rem;
  transition: all 0.14s;
}
.topic-chip:hover { border-color: var(--brand-400); }
.topic-chip.on {
  background: var(--brand-600);
  border-color: var(--brand-600);
  color: var(--on-brand);
  font-weight: 600;
}
.topic-chip.on .dim { color: rgba(255, 255, 255, 0.75); }
.act-btn {
  border: none;
  background: none;
  padding: 2px;
  color: var(--text-3);
  font-size: 0.85rem;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.act-btn:hover { color: var(--text); }
.act-btn.on { color: var(--danger); }
.link-btn {
  border: none;
  background: none;
  color: var(--text-3);
  font-size: 0.76rem;
  text-decoration: underline;
  flex-shrink: 0;
}
</style>
