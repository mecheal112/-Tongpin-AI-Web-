<script setup lang="ts">
/**
 * 匹配分圆环。颜色按分数分档，
 * 用 conic-gradient 画环，避免引入图表库。
 */
import { computed } from 'vue';

const props = defineProps<{ score: number }>();

const level = computed(() => (props.score >= 80 ? 'high' : props.score >= 62 ? 'mid' : 'low'));
const ringColor = computed(() =>
  level.value === 'high' ? '#059669' : level.value === 'mid' ? '#d97706' : '#5f7d77',
);
const style = computed(() => ({
  background: `conic-gradient(${ringColor.value} ${props.score * 3.6}deg, var(--surface-2) 0deg)`,
}));
</script>

<template>
  <div class="score-ring" :class="`score-${level}`" :style="style" :title="`匹配度 ${score}`">
    <span>{{ score }}</span>
  </div>
</template>
