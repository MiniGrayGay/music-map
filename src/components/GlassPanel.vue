<script setup>
import {onBeforeUnmount, ref} from 'vue';
import LiquidGlass from './LiquidGlass.vue';
import {useAnchoredPanel} from './panelMotion.js';

// Give a floating panel its trigger element as anchor. Inline panels reveal
// in place. Presence remains true until the closing glass has finished.
// Keep the material defaults in LiquidGlass, independent from the motion.
defineOptions({inheritAttrs: false});
const props = defineProps({
  open: {type: Boolean, required: true},
  anchor: {type: HTMLElement, default: null},
  inline: {type: Boolean, default: false},
  glass: {type: Boolean, default: true},
  appear: {type: Boolean, default: false},
  variant: {type: String, default: 'standard'},
  light: {type: Number, default: 1},
});
const emit = defineEmits(['presence']);
const element = ref(null);
const motion = useAnchoredPanel(() => props.anchor, {
  inline: props.inline,
  followSize: true,
});

defineExpose({element});
onBeforeUnmount(() => emit('presence', false));
</script>

<template>
  <Transition
    :css="false"
    :appear="appear"
    v-bind="glass ? motion : {}"
    @before-enter="emit('presence', true)"
    @after-leave="emit('presence', false)"
  >
    <div
      v-show="open"
      ref="element"
      v-bind="$attrs"
      :class="{ 'map-glass': glass, 'anchored-glass-panel': glass }"
      :inert="!open"
      :data-panel-open="open ? '' : undefined"
    >
      <LiquidGlass
        v-if="glass"
        :variant="variant"
        :light="light"
      />
      <div class="liquid-panel-body"><slot /></div>
    </div>
  </Transition>
</template>

<style scoped>
.anchored-glass-panel {
  pointer-events: none;
}

.anchored-glass-panel > .liquid-panel-body {
  pointer-events: auto;
}

.anchored-glass-panel[inert] > .liquid-panel-body {
  pointer-events: none;
}
</style>
