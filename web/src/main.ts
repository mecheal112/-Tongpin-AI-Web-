import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import { setUnauthorizedHandler } from './api';
import './styles/main.css';

const app = createApp(App);
app.use(createPinia());
app.use(router);

// 令牌失效时统一跳登录，避免每个页面各写一遍
setUnauthorizedHandler(() => {
  if (router.currentRoute.value.name !== 'login') {
    router.push('/login');
  }
});

app.mount('#app');
