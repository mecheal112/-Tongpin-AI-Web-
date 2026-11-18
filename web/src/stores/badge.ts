import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { groupApi, notifApi } from '@/api';

/**
 * 导航栏红点的唯一数据源。
 *
 * 三类未读是彼此独立的事，混用会让红点点亮错误的入口：
 *   notif      通知中心未读（点赞、评论、系统消息）
 *   chat       1:1 私信里别人发来还没看的内容
 *   approvals  我发起的小组里等待审批的入组申请
 *   groupChat  我所在小组的群聊里还没看的消息
 *
 * 同频局（groups）那一个角标由 approvals + groupChat 相加得出：
 * 两者都指向「同频局里有事等你」，拆成两个角标反而没有地方放。
 * 但内部仍然分开存 —— 页面各自只关心其中一个时不该被另一个带偏。
 *
 * 页面里读完之后调用对应的 set 就地更新，不必等下一次轮询。
 */
export const useBadgeStore = defineStore('badge', () => {
  const notif = ref(0);
  const chat = ref(0);
  const approvals = ref(0);
  const groupChat = ref(0);

  /** 同频局角标：待审批 + 群聊未读 */
  const group = computed(() => approvals.value + groupChat.value);

  const hasNotif = computed(() => notif.value > 0);
  const hasChat = computed(() => chat.value > 0);
  const hasGroup = computed(() => group.value > 0);

  function setNotif(n: number) {
    notif.value = Math.max(0, n | 0);
  }
  function setChat(n: number) {
    chat.value = Math.max(0, n | 0);
  }
  function setApprovals(n: number) {
    approvals.value = Math.max(0, n | 0);
  }
  function setGroupChat(n: number) {
    groupChat.value = Math.max(0, n | 0);
  }
  function reset() {
    notif.value = 0;
    chat.value = 0;
    approvals.value = 0;
    groupChat.value = 0;
  }

  /** 从服务端拉一次汇总，轮询和 socket 推送后都用它对齐 */
  async function refresh() {
    try {
      const [n, g] = await Promise.all([notifApi.unread(), groupApi.summary()]);
      setNotif(n.unread ?? 0);
      setChat(n.chat ?? 0);
      setApprovals(g.total ?? 0);
      setGroupChat(g.chatUnread ?? 0);
    } catch {
      /* 静默失败，不打扰用户 */
    }
  }

  return {
    notif,
    chat,
    approvals,
    groupChat,
    group,
    hasNotif,
    hasChat,
    hasGroup,
    setNotif,
    setChat,
    setApprovals,
    setGroupChat,
    reset,
    refresh,
  };
});
