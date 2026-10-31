<script setup lang="ts">
/** 头像：有图显示图，没图用昵称首字取色块 */
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    name: string;
    avatar?: string | null;
    size?: 'sm' | 'md' | 'lg' | 'xl';
    online?: boolean;
  }>(),
  { size: 'md', online: false },
);

const initial = computed(() => (props.name || '?').trim().charAt(0).toUpperCase());
</script>

<template>
  <div class="avatar-wrap">
    <div class="avatar" :class="size">
      <img v-if="avatar" :src="avatar" :alt="name" style="width: 100%; height: 100%; object-fit: cover" />
      <template v-else>{{ initial }}</template>
    </div>
    <span v-if="online" class="presence" title="在线"></span>
  </div>
</template>
