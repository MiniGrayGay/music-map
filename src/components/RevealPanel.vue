<script setup>
import {useDrawerMotion} from './panelMotion.js';

defineProps({
  open: {type: Boolean, required: true},
  liquid: {type: Boolean, default: false},
});
defineEmits(['shown']);

const drawerMotion = useDrawerMotion();
</script>

<template>
  <Transition name="reveal" :css="!liquid" v-bind="liquid ? drawerMotion : {}"
              @after-enter="$emit('shown')">
    <div v-show="open" class="reveal-panel" :inert="!open">
      <div class="reveal-content"><slot /></div>
    </div>
  </Transition>
</template>

<style scoped>
.reveal-panel {
  --reveal-duration: 300ms;
  --reveal-easing: cubic-bezier(.8, .3, .5, .8);
  position: relative;
  display: grid;
  grid-template-rows: 1fr;
  min-width: 0;
}

.reveal-content {
  position: relative;
  min-block-size: 0;
  min-width: 0;
}

[data-liquid-drawer] { overflow: clip; flex-shrink: 0; }

.reveal-enter-active:not([data-liquid-drawer]),
.reveal-leave-active:not([data-liquid-drawer]) {
  transition: grid-template-rows var(--reveal-duration) var(--reveal-easing),
    margin-block-start var(--reveal-duration) var(--reveal-easing);
}

.reveal-leave-active:not([data-liquid-drawer]) {
  --reveal-duration: 250ms;
  --reveal-easing: ease-out;
}

.reveal-enter-active > .reveal-content,
.reveal-leave-active > .reveal-content {
  overflow: clip;
}

.reveal-enter-from,
.reveal-leave-to {
  grid-template-rows: 0fr;
  margin-block-start: calc(-1 * var(--reveal-gap, 0px));
}

@media (prefers-reduced-motion: reduce) {
  .reveal-enter-active:not([data-liquid-drawer]),
  .reveal-leave-active:not([data-liquid-drawer]) {
    transition: none;
  }

  .reveal-enter-from,
  .reveal-leave-to {
    grid-template-rows: 1fr;
    margin-block-start: 0;
  }
}
</style>
