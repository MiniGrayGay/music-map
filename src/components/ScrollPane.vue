<script setup>
// 轻量滚动容器：滚动行为全部交给浏览器原生实现（滚轮、触屏、拖动原生
// 滚动条、键盘滚动焦点内元素），组件只负责稳定的预留槽位与细滑块外观。
// 不自绘轨道，不把焦点转给滚动层；`label` 仍用于可访问名称。
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
  /* 无条件预留滑块槽位，列表增减时内容宽度不跳动；轨道本身透明无边线。 */
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: #637e8d transparent;
}

.scroll-viewport::-webkit-scrollbar {
  width: 10px;
}

.scroll-viewport::-webkit-scrollbar-track {
  background: transparent;
}

.scroll-viewport::-webkit-scrollbar-thumb {
  border: 3px solid transparent;
  border-radius: 6px;
  background: #637e8d;
  background-clip: content-box;
}

.scroll-viewport::-webkit-scrollbar-thumb:hover {
  background-color: #9db4be;
}

@media (forced-colors: active) {
  .scroll-viewport {
    scrollbar-color: auto;
  }
}
</style>
