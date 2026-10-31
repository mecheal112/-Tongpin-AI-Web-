<script setup lang="ts">
/**
 * 同频局详情。
 * 发起人可以用 AI 推荐人选 —— 这是「组队场景下的匹配」，
 * 逻辑和交友匹配不同：不是找最像你的人，而是找让这个组更好的组合，
 * 所以会刻意引入能力互补的人，避免一组人高度同质。
 */
import { onMounted, onUnmounted, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { groupApi } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { useBadgeStore } from '@/stores/badge';
import { connectSocket, getSocket } from '@/lib/socket';
import { useToast } from '@/lib/toast';
import Avatar from '@/components/Avatar.vue';
import type { Group, RecommendedMember } from '@/types';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const badges = useBadgeStore();
const { ok, error } = useToast();

const loading = ref(true);
const group = ref<Group | null>(null);
const picks = ref<RecommendedMember[]>([]);
const loadingPicks = ref(false);
const inviting = ref<string | null>(null);
const joining = ref(false);
const requests = ref<any[]>([]);
const loadingRequests = ref(false);
const deciding = ref<string | null>(null);
const showJoinForm = ref(false);
const joinMessage = ref('');

onMounted(async () => {
  connectSocket();
  const s = getSocket();
  s?.on('group:join-request', onGroupEvent);
  s?.on('group:member-changed', onGroupEvent);
  s?.on('group:closed', onClosed);
  await load();
});

onUnmounted(() => {
  const s = getSocket();
  s?.off('group:join-request', onGroupEvent);
  s?.off('group:member-changed', onGroupEvent);
  s?.off('group:closed', onClosed);
});

/** 有人申请或审批结果变化时，正在看这个小组的发起人立刻看到 */
function onGroupEvent(payload: any) {
  if (!group.value || payload?.groupId !== group.value.id) return;
  if (group.value.isOwner) loadRequests();
}

/**
 * 管理员在我看着这个页面时把小组关了。
 * 不做静默重载 —— 页面突然变成「小组不存在」会让人以为是自己点坏了，
 * 先说清楚发生了什么，再送回列表。
 */
function onClosed(payload: any) {
  if (!group.value || payload?.groupId !== group.value.id) return;
  error('该小组已被管理员关闭');
  router.push('/groups');
}

async function load() {
  loading.value = true;
  try {
    const res = await groupApi.detail(route.params.id as string);
    group.value = res.group;
    // 发起人顺手把待审批拉出来，进来就能处理
    if (res.group.isOwner) await loadRequests();
    badges.refresh();
  } catch (e: any) {
    error(e?.message || '小组不存在');
    router.push('/groups');
  } finally {
    loading.value = false;
  }
}

async function loadRequests() {
  if (!group.value) return;
  loadingRequests.value = true;
  try {
    const res = await groupApi.requests(group.value.id);
    requests.value = res.requests || [];
  } catch {
    /* 拿不到申请不影响看小组 */
  } finally {
    loadingRequests.value = false;
  }
}

/** 提交入组申请。此时还没进组，等发起人通过。 */
async function applyJoin() {
  if (!group.value || joining.value) return;
  joining.value = true;
  try {
    await groupApi.join(group.value.id, joinMessage.value.trim());
    showJoinForm.value = false;
    joinMessage.value = '';
    ok('申请已提交，等发起人通过');
    await load();
  } catch (e: any) {
    error(e?.message || '申请失败');
  } finally {
    joining.value = false;
  }
}

async function cancelJoin() {
  if (!group.value) return;
  try {
    await groupApi.cancelJoin(group.value.id);
    ok('已撤回申请');
    await load();
  } catch (e: any) {
    error(e?.message || '撤回失败');
  }
}

async function decide(r: any, action: 'approve' | 'reject') {
  if (!group.value || deciding.value) return;
  deciding.value = r.user_id;
  try {
    await groupApi.decide(group.value.id, r.user_id, action);
    ok(action === 'approve' ? `已通过 ${r.nickname} 的申请` : `已拒绝 ${r.nickname} 的申请`);
    requests.value = requests.value.filter((x) => x.user_id !== r.user_id);
    await load();
  } catch (e: any) {
    error(e?.message || '操作失败');
  } finally {
    deciding.value = null;
  }
}
async function leave() {
  if (!group.value || !confirm('确定退出这个小组？')) return;
  try {
    await groupApi.leave(group.value.id);
    ok('已退出');
    await load();
  } catch (e: any) {
    error(e?.message || '退出失败');
  }
}

/**
 * 关闭小组：发起人关自己的，管理员关违规的。
 * 管理员操作时额外提醒一句，因为这不是「我的小组」页面上的常规动作，
 * 点错了就把别人的小组关没了。
 */
async function close() {
  if (!group.value) return;
  const byAdmin = !group.value.isOwner;
  const tip = byAdmin
    ? `你正在以管理员身份关闭「${group.value.title}」。关闭后组内所有人都会收到通知，确定？`
    : '关闭后其他人将看不到这个小组，确定？';
  if (!confirm(tip)) return;
  try {
    const res = await groupApi.close(group.value.id);
    ok(res.closedByAdmin ? '已作为管理员关闭该小组' : '已关闭');
    router.push('/groups');
  } catch (e: any) {
    error(e?.message || '操作失败');
  }
}

async function recommend() {
  if (!group.value) return;
  loadingPicks.value = true;
  try {
    const res = await groupApi.recommend(group.value.id);
    picks.value = res.picks || [];
    if (!picks.value.length) ok('暂时没有合适的人选，社区里的人还不够多');
  } catch (e: any) {
    error(e?.message || '推荐失败');
  } finally {
    loadingPicks.value = false;
  }
}

async function invite(m: RecommendedMember) {
  if (!group.value) return;
  inviting.value = m.id;
  try {
    await groupApi.invite(group.value.id, m.id);
    ok(`已邀请 ${m.nickname}`);
    picks.value = picks.value.filter((p) => p.id !== m.id);
  } catch (e: any) {
    error(e?.message || '邀请失败');
  } finally {
    inviting.value = null;
  }
}

function fmtDate(ts?: number | null) {
  if (!ts) return '待定';
  return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
</script>

<template>
  <div class="page narrow">
    <button class="btn ghost sm mb-2" @click="router.push('/groups')">← 返回</button>

    <div v-if="loading" class="skeleton" style="height: 300px" />

    <template v-else-if="group">
      <div class="card pad-lg mb-3">
        <div class="row between mb-2">
          <span class="tag brand">{{ group.category }}</span>
          <span class="tiny dim">{{ group.memberCount }} / {{ group.capacity }} 人</span>
        </div>

        <h1 style="font-size: 1.35rem">{{ group.title }}</h1>
        <p class="pre-wrap muted">{{ group.description || '发起人没有写说明' }}</p>

        <div class="divider" />

        <div class="meta-grid">
          <div><span class="dim tiny">发起人</span><div>{{ group.owner.nickname }}</div></div>
          <div><span class="dim tiny">形式</span><div>{{ group.isOnline ? '线上' : '线下' }}</div></div>
          <div v-if="group.location"><span class="dim tiny">地点</span><div>{{ group.location }}</div></div>
          <div v-if="group.meetAt"><span class="dim tiny">时间</span><div>{{ fmtDate(group.meetAt) }}</div></div>
        </div>

        <div v-if="group.wanted" class="alert info mt-2 mb-0">
          <b>希望找这样的人：</b>{{ group.wanted }}
        </div>

        <div class="row mt-3">
          <template v-if="group.isOwner">
            <RouterLink :to="`/group/${group.id}/chat`" class="btn">进入群聊</RouterLink>
            <button class="btn ghost danger" @click="close">关闭小组</button>
          </template>
          <template v-else-if="group.isMember">
            <RouterLink :to="`/group/${group.id}/chat`" class="btn">进入群聊</RouterLink>
            <button class="btn ghost" @click="leave">退出小组</button>
            <!-- 管理员对任意小组都有下架权，但这是治理手段不是日常操作，收在右侧 -->
            <button v-if="auth.isAdmin" class="btn ghost danger sm" @click="close">以管理员身份关闭</button>
          </template>

          <!-- 已申请：把状态说清楚，而不是让按钮变回「加入」 -->
          <template v-else-if="group.joinPending">
            <span class="tag warn" style="padding: 9px 14px">申请待发起人通过</span>
            <button class="btn ghost" @click="cancelJoin">撤回申请</button>
          </template>

          <template v-else-if="auth.isLoggedIn">
            <template v-if="group.memberCount >= group.capacity">
              <button class="btn" disabled>人数已满</button>
            </template>
            <template v-else-if="!showJoinForm">
              <button class="btn" @click="showJoinForm = true">申请加入</button>
            </template>
            <template v-else>
              <div class="grow">
                <textarea
                  v-model="joinMessage"
                  class="textarea"
                  style="min-height: 64px"
                  maxlength="200"
                  placeholder="说一句想加入的理由，发起人更容易通过（选填）"
                />
                <div class="row mt-1">
                  <button class="btn" :disabled="joining" @click="applyJoin">
                    <span v-if="joining" class="spinner" />
                    <span v-else>提交申请</span>
                  </button>
                  <button class="btn ghost" :disabled="joining" @click="showJoinForm = false">取消</button>
                </div>
              </div>
            </template>
            <button v-if="auth.isAdmin && showJoinForm" class="btn ghost danger sm" @click="close">以管理员身份关闭</button>
          </template>
        </div>
      </div>

      <!-- 待审批（仅发起人）。即使没有申请也占位，让发起人知道审批入口在这里 -->
      <template v-if="group.isOwner">
        <div class="row between mb-2">
          <h3 class="mb-0">入组申请</h3>
          <span v-if="requests.length" class="tag warn">{{ requests.length }} 条待处理</span>
        </div>

        <div v-if="loadingRequests" class="skeleton mb-3" style="height: 90px" />

        <div v-else-if="!requests.length" class="card muted mb-3">
          <p class="small mb-0">暂时没有新的申请。有人申请加入时会出现在这里，同时也会收到通知。</p>
        </div>

        <div v-else class="col mb-3" style="gap: 10px">
          <div v-for="r in requests" :key="r.user_id" class="card">
            <div class="row mb-1">
              <RouterLink :to="`/user/${r.user_id}`">
                <Avatar :name="r.nickname" :avatar="r.avatar" />
              </RouterLink>
              <div class="grow" style="min-width: 0">
                <RouterLink :to="`/user/${r.user_id}`" style="color: inherit">
                  <b style="font-size: 0.92rem">{{ r.nickname }}</b>
                </RouterLink>
                <div class="tiny dim">
                  {{ r.college }}{{ r.major ? ' · ' + r.major : '' }}{{ r.grade ? ' · ' + r.grade : '' }}
                </div>
              </div>
            </div>

            <p v-if="r.message" class="small pre-wrap" style="margin: 0 0 8px">
              <span class="dim">申请留言：</span>{{ r.message }}
            </p>

            <div class="row">
              <button class="btn sm" :disabled="deciding === r.user_id" @click="decide(r, 'approve')">通过</button>
              <button class="btn ghost sm" :disabled="deciding === r.user_id" @click="decide(r, 'reject')">拒绝</button>
            </div>
          </div>
        </div>
      </template>

      <!-- 成员 -->
      <h3 class="mb-2">成员</h3>
      <div class="card mb-3">
        <div class="col" style="gap: 12px">
          <div v-for="m in group.members || []" :key="m.id" class="row">
            <RouterLink :to="`/user/${m.id}`">
              <Avatar :name="m.nickname" :avatar="m.avatar" />
            </RouterLink>
            <div class="grow" style="min-width: 0">
              <RouterLink :to="`/user/${m.id}`" style="color: inherit">
                <b style="font-size: 0.92rem">{{ m.nickname }}</b>
              </RouterLink>
              <div class="tiny dim">{{ m.college }}{{ m.major ? ' · ' + m.major : '' }}</div>
            </div>
            <span v-if="m.role === 'owner'" class="tag brand">发起人</span>
          </div>
        </div>
      </div>

      <!-- AI 推荐人选（仅发起人可见） -->
      <template v-if="group.isOwner">
        <div class="row between mb-2">
          <h3 class="mb-0">AI 推荐人选</h3>
          <button class="btn subtle sm" :disabled="loadingPicks" @click="recommend">
            <span v-if="loadingPicks" class="spinner" />
            <span v-else>{{ picks.length ? '换一批' : '推荐合适的人' }}</span>
          </button>
        </div>

        <div v-if="loadingPicks" class="col">
          <div v-for="i in 3" :key="i" class="skeleton" style="height: 80px" />
        </div>

        <div v-else-if="!picks.length" class="card muted">
          <p class="small mb-0">
            点上面的按钮，AI 会从社区里挑出适合这个小组的人 ——
            不只是和你像的人，也包括能补足这个组合的人。
          </p>
        </div>

        <div v-else class="col" style="gap: 10px">
          <div v-for="p in picks" :key="p.id" class="card">
            <div class="row mb-1">
              <Avatar :name="p.nickname" :avatar="p.avatar" />
              <div class="grow" style="min-width: 0">
                <RouterLink :to="`/user/${p.id}`" style="color: inherit">
                  <b style="font-size: 0.92rem">{{ p.nickname }}</b>
                </RouterLink>
                <div class="tiny dim clamp-2">{{ p.summary }}</div>
              </div>
            </div>

            <p class="tiny" style="margin: 0 0 6px">
              <span class="dim">推荐理由：</span>{{ p.reason }}
            </p>
            <p v-if="p.role_hint" class="tiny" style="margin: 0 0 8px">
              <span class="dim">能给小组带来：</span>{{ p.role_hint }}
            </p>

            <div v-if="p.interests.length" class="tag-row mb-2">
              <span v-for="i in p.interests" :key="i" class="tag">{{ i }}</span>
            </div>

            <button class="btn sm" :disabled="inviting === p.id" @click="invite(p)">
              <span v-if="inviting === p.id" class="spinner" />
              <span v-else>邀请加入</span>
            </button>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.meta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 12px;
  font-size: 0.9rem;
}
</style>
