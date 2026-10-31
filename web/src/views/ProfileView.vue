<script setup lang="ts">
/**
 * 个人资料页。
 * 除了基础资料，还允许手动微调画像向量 ——
 * AI 的判断不一定对，用户应该有最终话语权，否则画像错了会一直影响推荐。
 */
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { authApi, personaApi } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/lib/toast';
import Avatar from '@/components/Avatar.vue';
import type { Dimension } from '@/types';

const auth = useAuthStore();
const { ok, error } = useToast();

const tab = ref<'profile' | 'persona'>('profile');
const saving = ref(false);
const personas = ref<any>(null);
const dimensions = ref<Dimension[]>([]);
const vectorDraft = ref<number[]>([]);
const rhythmDraft = ref('灵活');

const GRADES = ['大一', '大二', '大三', '大四', '研一', '研二', '研三'];
const RHYTHMS = ['早起型', '夜猫型', '灵活'];
const CONTACTS = ['线上', '线下', '都可'];

const form = ref({
  nickname: '',
  avatar: '',
  school: '',
  college: '',
  major: '',
  grade: '大一',
  gender: '',
  bio: '',
  contact_pref: '都可',
});

const hasPersona = computed(() => auth.hasPersona && personas.value);

onMounted(async () => {
  await auth.refreshUser();
  const u = auth.user;
  if (u) {
    form.value = {
      nickname: u.nickname || '',
      avatar: u.avatar || '',
      school: u.school || '',
      college: u.college || '',
      major: u.major || '',
      grade: u.grade || '大一',
      gender: u.gender || '',
      bio: u.bio || '',
      contact_pref: u.contact_pref || '都可',
    };
  }
  try {
    const res = await personaApi.me();
    personas.value = res.persona;
    dimensions.value = res.dimensions || [];
    if (res.persona) {
      vectorDraft.value = [...(res.persona.vector || [])];
      rhythmDraft.value = res.persona.rhythm || '灵活';
    }
  } catch {
    /* 忽略 */
  }
});

async function saveProfile() {
  saving.value = true;
  try {
    await authApi.updateMe({ ...form.value });
    await auth.refreshUser();
    ok('已保存');
  } catch (e: any) {
    error(e?.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

async function savePersona() {
  saving.value = true;
  try {
    await personaApi.tune({ vector: vectorDraft.value, rhythm: rhythmDraft.value });
    const res = await personaApi.me();
    personas.value = res.persona;
    ok('画像已更新，之后的推荐会按新画像算');
  } catch (e: any) {
    error(e?.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

function resetVector() {
  if (personas.value) vectorDraft.value = [...(personas.value.vector || [])];
}
</script>

<template>
  <div class="page narrow">
    <div class="page-head">
      <div>
        <h1 class="page-title">个人资料</h1>
        <p class="page-sub">资料填得越准，匹配越靠谱</p>
      </div>
    </div>

    <div class="tag-row mb-3">
      <button class="chip" :class="{ on: tab === 'profile' }" @click="tab = 'profile'">基础资料</button>
      <button class="chip" :class="{ on: tab === 'persona' }" @click="tab = 'persona'">人格画像</button>
    </div>

    <!-- 基础资料 -->
    <div v-if="tab === 'profile'" class="card pad-lg">
      <div class="row mb-3">
        <Avatar :name="form.nickname || '?'" :avatar="auth.user?.avatar" size="xl" />
        <div class="grow">
          <div class="bold">{{ form.nickname }}</div>
          <div class="tiny dim">{{ auth.user?.email }}</div>
          <div class="tag-row mt-1">
            <span v-if="auth.isAdmin" class="tag brand">管理员</span>
            <span v-if="auth.user?.is_demo" class="tag">体验账号</span>
          </div>
        </div>
      </div>

      <div class="field">
        <label class="label">昵称</label>
        <input v-model="form.nickname" class="input" maxlength="20" />

        <label class="label">头像链接</label>
        <input v-model="form.avatar" class="input" placeholder="https://… 图片地址（留空使用文字头像）" />
      </div>

      <div class="field">
        <label class="label">一句话介绍自己</label>
        <textarea v-model="form.bio" class="textarea" style="min-height: 68px" placeholder="别人看到你的第一印象" maxlength="200" />
      </div>

      <div class="grid-2">
        <div class="field">
          <label class="label">学校</label>
          <input v-model="form.school" class="input" />
        </div>
        <div class="field">
          <label class="label">学院</label>
          <input v-model="form.college" class="input" />
        </div>
        <div class="field">
          <label class="label">专业</label>
          <input v-model="form.major" class="input" />
        </div>
        <div class="field">
          <label class="label">年级</label>
          <select v-model="form.grade" class="select">
            <option v-for="g in GRADES" :key="g" :value="g">{{ g }}</option>
          </select>
        </div>
        <div class="field">
          <label class="label">性别</label>
          <select v-model="form.gender" class="select">
            <option value="">不填</option>
            <option value="男">男</option>
            <option value="女">女</option>
            <option value="其他">其他</option>
          </select>
        </div>
        <div class="field">
          <label class="label">更愿意怎么相处</label>
          <select v-model="form.contact_pref" class="select">
            <option v-for="c in CONTACTS" :key="c" :value="c">{{ c }}</option>
          </select>
        </div>
      </div>

      <button class="btn block" :disabled="saving" @click="saveProfile">
        <span v-if="saving" class="spinner" />
        <span v-else>保存</span>
      </button>
    </div>

    <!-- 人格画像 -->
    <div v-else>
      <div v-if="!hasPersona" class="card pad-lg center">
        <div class="empty-ico">🧭</div>
        <h3>还没有人格画像</h3>
        <RouterLink to="/persona" class="btn">去做画像</RouterLink>
      </div>

      <template v-else>
        <div class="card pad-lg mb-3">
          <div class="row between mb-1">
            <h3 class="mb-0">AI 眼中的你</h3>
            <span class="tiny dim">v{{ personas.version }}</span>
          </div>
          <p class="muted small">{{ personas.summary }}</p>

          <div class="divider" />
          <div class="row between mb-2">
            <span class="small bold">六维画像（可拖动微调）</span>
            <button class="link-btn" @click="resetVector">还原</button>
          </div>

          <div v-for="(d, i) in dimensions" :key="d.key" class="slider-row">
            <div class="row between tiny">
              <span>{{ d.label }}</span>
              <span class="dim">{{ d.low }} ← → {{ d.high }}</span>
            </div>
            <input v-model.number="vectorDraft[i]" type="range" min="0" max="100" class="range" />
            <div class="center tiny bold">{{ vectorDraft[i] }}</div>
          </div>

          <div class="field mt-2">
            <label class="label">作息类型</label>
            <select v-model="rhythmDraft" class="select">
              <option v-for="r in RHYTHMS" :key="r" :value="r">{{ r }}</option>
            </select>
            <p class="hint">作息会直接影响匹配里的「现实兼容」分数。</p>
          </div>

          <button class="btn block" :disabled="saving" @click="savePersona">
            <span v-if="saving" class="spinner" />
            <span v-else>保存画像调整</span>
          </button>
        </div>

        <div class="card">
          <div class="mb-2">
            <div class="small bold mb-1">兴趣爱好</div>
            <div class="tag-row">
              <span v-for="i in personas.interests || []" :key="i.name" class="tag brand">{{ i.name }}</span>
            </div>
          </div>
          <div v-if="(personas.values || []).length">
            <div class="small bold mb-1">在意的价值</div>
            <div class="tag-row">
              <span v-for="v in personas.values" :key="v" class="tag">{{ v }}</span>
            </div>
          </div>
          <div class="divider" />
          <RouterLink to="/persona" class="small">重新做一次访谈 →</RouterLink>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.chip {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-2);
  padding: 4px 12px;
  border-radius: 999px;
  font-size: 0.8rem;
}
.chip.on {
  background: var(--brand-600);
  border-color: var(--brand-600);
  color: var(--on-brand);
  font-weight: 600;
}
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 12px;
}
@media (max-width: 480px) {
  .grid-2 { grid-template-columns: 1fr; }
}
.slider-row { margin-bottom: 13px; }
.range {
  width: 100%;
  accent-color: var(--brand-600);
  margin: 3px 0;
}
.link-btn {
  border: none;
  background: none;
  color: var(--text-3);
  font-size: 0.76rem;
  text-decoration: underline;
}
</style>
