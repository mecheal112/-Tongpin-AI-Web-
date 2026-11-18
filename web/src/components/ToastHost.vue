<script setup lang="ts">
import { useToast } from '@/lib/toast';
const { items } = useToast();
</script>

<template>
  <div class="toast-wrap">
    <div v-for="t in items" :key="t.id" class="toast">{{ t.text }}</div>
  </div>
</template>
