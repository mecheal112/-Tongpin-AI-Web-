<script setup lang="ts">
/**
 * 登录 / 注册页。
 * 评审需要能快速进入，所以下面直接列出体验账号，一键登录。
 */
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { authApi } from '@/api';
import { useToast } from '@/lib/toast';
import type { DemoAccount } from '@/types';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const { error, ok } = useToast();

const mode = ref<'login' | 'register'>('login');
const busy = ref(false);
const demoAccounts = ref<DemoAccount[]>([]);
const demoPassword = ref('Tongpin@2026');
const showDemo = ref(false);

const form = ref({
  email: '',
  password: '',
  nickname: '',
  school: '',
  college: '',
  major: '',
  grade: '大一',
  gender: '',
});

const GRADES = ['大一', '大二', '大三', '大四', '研一', '研二', '研三'];

onMounted(async () => {
  try {
    const res = await authApi.demoAccounts();
    demoAccounts.value = res.accounts || [];
    demoPassword.value = res.password || demoPassword.value;
  } catch {
    /* 拿不到就不显示体验入口 */
  }
});

function go() {
  const target = (route.query.redirect as string) || '/';
  router.push(target);
}

async function submit() {
  if (busy.value) return;
  busy.value = true;
  try {
    if (mode.value === 'login') {
      if (!form.value.email || !form.value.password) {
        error('请填写邮箱和密码');
        return;
      }
      await auth.login(form.value.email, form.value.password);
      ok('登录成功');
    } else {
      if (!form.value.email || !form.value.password || !form.value.nickname) {
        error('邮箱、密码、昵称都要填');
        return;
      }
      if (form.value.password.length < 6) {
        error('密码至少 6 位');
        return;
      }
      await auth.register({ ...form.value });
      ok('注册成功，先来做个人格画像吧');
      router.push('/persona');
      return;
    }
    go();
  } catch (e: any) {
    error(e?.message || '操作失败');
  } finally {
    busy.value = false;
  }
}

async function quickLogin(acc: DemoAccount) {
  if (busy.value) return;
  busy.value = true;
  try {
    await auth.demoLogin(acc.email);
    ok(`已进入 ${acc.nickname} 的账号`);
    go();
  } catch (e: any) {
    error(e?.message || '登录失败');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="login-wrap">
    <div class="login-card">
      <div class="center mb-3">
        <div class="brand-dot" style="width: 46px; height: 46px; font-size: 22px; margin: 0 auto 12px">频</div>
        <h1 style="margin-bottom: 4px">同频</h1>
        <p class="muted small" style="margin: 0">
          大学里最难的不是认识人，是找到<span class="bold">同频</span>的人
        </p>
      </div>

      <div class="seg mb-2">
        <button :class="{ on: mode === 'login' }" @click="mode = 'login'">登录</button>
        <button :class="{ on: mode === 'register' }" @click="mode = 'register'">注册</button>
      </div>

      <div class="field">
        <label class="label">邮箱</label>
        <input v-model="form.email" class="input" type="email" placeholder="you@example.com" @keyup.enter="submit" />
      </div>

      <div class="field">
        <label class="label">密码</label>
        <input
          v-model="form.password"
          class="input"
          type="password"
          :placeholder="mode === 'register' ? '至少 6 位' : '请输入密码'"
          @keyup.enter="submit"
        />
      </div>

      <template v-if="mode === 'register'">
        <div class="field">
          <label class="label">昵称</label>
          <input v-model="form.nickname" class="input" placeholder="别人怎么称呼你" />
        </div>
        <div class="grid-2">
          <div class="field">
            <label class="label">学校</label>
            <input v-model="form.school" class="input" placeholder="选填" />
          </div>
          <div class="field">
            <label class="label">学院</label>
            <input v-model="form.college" class="input" placeholder="选填" />
          </div>
          <div class="field">
            <label class="label">专业</label>
            <input v-model="form.major" class="input" placeholder="选填" />
          </div>
          <div class="field">
            <label class="label">年级</label>
            <select v-model="form.grade" class="select">
              <option v-for="g in GRADES" :key="g" :value="g">{{ g }}</option>
            </select>
          </div>
        </div>
        <p class="hint mb-2">这些信息会影响匹配结果，填得越准匹配越靠谱。</p>
      </template>

      <button class="btn block lg" :disabled="busy" @click="submit">
        <span v-if="busy" class="spinner" />
        <span v-else>{{ mode === 'login' ? '登录' : '注册并开始' }}</span>
      </button>

      <div v-if="demoAccounts.length" class="mt-3">
        <div class="divider" />
        <button class="demo-toggle" @click="showDemo = !showDemo">
          <span>🎬 评审体验账号</span>
          <span class="dim">{{ showDemo ? '收起' : '展开' }}</span>
        </button>
        <div v-if="showDemo" class="mt-1">
          <p class="hint mb-1">
            密码统一为 <code>{{ demoPassword }}</code>，点一下直接进入对应视角。
          </p>
          <div class="demo-list">
            <button v-for="a in demoAccounts" :key="a.email" class="demo-row" :disabled="busy" @click="quickLogin(a)">
              <span class="demo-name">{{ a.nickname }}</span>
              <span class="demo-meta">{{ a.major || a.college || a.email }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.login-wrap {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 22px 16px;
  background: radial-gradient(1200px 600px at 50% -10%, var(--brand-50), transparent 70%), var(--bg);
}
.login-card {
  width: 100%;
  max-width: 420px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 30px 26px;
  box-shadow: var(--shadow);
}
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
  transition: background 0.15s, color 0.15s;
}
.seg button.on {
  background: var(--surface);
  color: var(--brand-600);
  box-shadow: var(--shadow);
}
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 12px;
}
@media (max-width: 420px) {
  .grid-2 { grid-template-columns: 1fr; }
}
.demo-toggle {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border: none;
  background: none;
  padding: 6px 2px;
  font-weight: 600;
  font-size: 0.87rem;
  color: var(--text-2);
}
.demo-list {
  max-height: 230px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.demo-row {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 10px;
  padding: 9px 12px;
  border: none;
  border-bottom: 1px solid var(--border);
  background: none;
  text-align: left;
  transition: background 0.13s;
}
.demo-row:last-child { border-bottom: none; }
.demo-row:hover { background: var(--brand-50); }
.demo-name { font-weight: 600; font-size: 0.88rem; }
.demo-meta { font-size: 0.76rem; color: var(--text-3); }
code {
  background: var(--surface-2);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.85em;
}
</style>
