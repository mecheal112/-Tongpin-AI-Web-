import { Router } from 'express';
import { wrap } from '../utils/helpers.js';
import { requireAuth } from '../middleware/auth.js';
import { listNotifications, unreadCount, chatUnreadCount, markRead } from '../services/notify-service.js';
import { pagination } from '../utils/helpers.js';

export const router = Router();
router.use(requireAuth);

/** 未读数汇总：unread 是通知未读数，chat 是私信未读数，两者互相独立 */
function unreadSummary(userId) {
  return { unread: unreadCount(userId), chat: chatUnreadCount(userId) };
}

router.get(
  '/',
  wrap(async (req, res) => {
    const { limit, offset } = pagination(req.query, { limit: 30 });
    res.json({
      ok: true,
      notifications: listNotifications(req.user.id, { limit, offset }),
      ...unreadSummary(req.user.id),
    });
  }),
);

router.get(
  '/unread-count',
  wrap(async (req, res) => res.json({ ok: true, ...unreadSummary(req.user.id) })),
);

router.post(
  '/read',
  wrap(async (req, res) => {
    markRead(req.user.id, req.body?.ids);
    res.json({ ok: true, ...unreadSummary(req.user.id) });
  }),
);
