<script setup>
// `label` 用于可访问名称，滚动和焦点转移交给浏览器。
defineProps({label: {type: String, required: true}});
</script>

<template>
  <div class="scroll-pane" role="group" :aria-label="label">
    <div class="scroll-viewport">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.scroll-pane {
  min-width: 0;
}

.scroll-viewport {
  min-width: 0;
  min-height: 0;
  max-height: var(--pane-limit, 320px);
  overflow: auto;
  overscroll-behavior: contain;
}
</style>
