import { ref } from 'vue';

/** 极简全局提示。避免为一条消息引入整个 UI 库。 */

export interface ToastItem {
  id: number;
  text: string;
  kind: 'info' | 'ok' | 'warn' | 'danger';
}

const items = ref<ToastItem[]>([]);
let seq = 0;

export function useToast() {
  function push(text: string, kind: ToastItem['kind'] = 'info', ms = 2600) {
    const id = ++seq;
    items.value.push({ id, text, kind });
    setTimeout(() => {
      items.value = items.value.filter((t) => t.id !== id);
    }, ms);
  }
  return {
    items,
    toast: push,
    ok: (t: string) => push(t, 'ok'),
    warn: (t: string) => push(t, 'warn'),
    error: (t: string) => push(t, 'danger', 3600),
    info: (t: string) => push(t, 'info'),
  };
}
