import { createRouter, createWebHistory } from 'vue-router';
import { getToken } from './api';

/** 路由表。meta.public 的页面无需登录。 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { public: true } },
    { path: '/', name: 'home', component: () => import('./views/HomeView.vue') },
    { path: '/match', name: 'match', component: () => import('./views/MatchView.vue') },
    { path: '/explore', name: 'explore', component: () => import('./views/ExploreView.vue') },
    { path: '/persona', name: 'persona', component: () => import('./views/PersonaView.vue') },
    { path: '/graph', name: 'graph', component: () => import('./views/GraphView.vue') },
    { path: '/chat', name: 'chat', component: () => import('./views/ChatView.vue') },
    { path: '/chat/:id', name: 'chat-detail', component: () => import('./views/ChatView.vue') },
    { path: '/community', name: 'community', component: () => import('./views/CommunityView.vue') },
    { path: '/post/:id', name: 'post-detail', component: () => import('./views/PostDetailView.vue') },
    { path: '/groups', name: 'groups', component: () => import('./views/GroupsView.vue') },
    { path: '/group/:id', name: 'group-detail', component: () => import('./views/GroupDetailView.vue') },
    { path: '/group/:id/chat', name: 'group-chat', component: () => import('./views/GroupChatView.vue') },
    { path: '/notifications', name: 'notifications', component: () => import('./views/NotificationsView.vue') },
    { path: '/profile', name: 'profile', component: () => import('./views/ProfileView.vue') },
    { path: '/user/:id', name: 'user', component: () => import('./views/UserView.vue') },
    { path: '/admin', name: 'admin', component: () => import('./views/AdminView.vue') },
    { path: '/help', name: 'help', component: () => import('./views/HelpView.vue'), meta: { public: true } },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior() {
    return { top: 0 };
  },
});

router.beforeEach((to) => {
  if (to.meta.public) return true;
  if (!getToken()) return { name: 'login', query: { redirect: to.fullPath } };
  return true;
});
