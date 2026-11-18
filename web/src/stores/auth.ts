import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { authApi, clearToken, getToken, setToken } from '@/api';
import type { AiStatus, User } from '@/types';

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null);
  const ai = ref<AiStatus | null>(null);
  const ready = ref(false);

  const isLoggedIn = computed(() => Boolean(user.value));
  const isAdmin = computed(() => user.value?.role === 'admin');
  /** 画像是否已完成 —— 决定能不能用匹配功能 */
  const hasPersona = computed(() => (user.value?.persona_stage ?? 0) >= 2);

  async function bootstrap() {
    if (!getToken()) {
      ready.value = true;
      return;
    }
    try {
      const res = await authApi.me();
      user.value = res.user;
      ai.value = res.ai;
    } catch {
      clearToken();
      user.value = null;
    } finally {
      ready.value = true;
    }
  }

  async function login(email: string, password: string) {
    const res = await authApi.login(email, password);
    setToken(res.token);
    user.value = res.user;
    await refreshAi();
  }

  async function demoLogin(email: string) {
    const res = await authApi.demoLogin(email);
    setToken(res.token);
    user.value = res.user;
    await refreshAi();
  }

  async function register(payload: Record<string, unknown>) {
    const res = await authApi.register(payload);
    setToken(res.token);
    user.value = res.user;
    await refreshAi();
  }

  async function refreshAi() {
    try {
      const res = await authApi.me();
      ai.value = res.ai;
      user.value = res.user;
    } catch {
      /* 忽略 */
    }
  }

  async function refreshUser() {
    try {
      const res = await authApi.me();
      user.value = res.user;
    } catch {
      /* 忽略 */
    }
  }

  function logout() {
    clearToken();
    user.value = null;
  }

  return {
    user,
    ai,
    ready,
    isLoggedIn,
    isAdmin,
    hasPersona,
    bootstrap,
    login,
    demoLogin,
    register,
    refreshAi,
    refreshUser,
    logout,
  };
});
