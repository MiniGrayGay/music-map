<script setup>
import {onBeforeUnmount, onMounted, ref, useId} from 'vue';
import {pushEscapeHandler} from './escapeStack.js';

const props = defineProps({author: {type: Object, required: true}});
const emit = defineEmits(['dismiss']);
const dialog = ref(null);
const titleId = useId();
const navigationError = ref(false);
let releaseEscape;

onMounted(() => {
  dialog.value.showModal();
  releaseEscape = pushEscapeHandler(() => true);
});
onBeforeUnmount(() => releaseEscape?.());

function onBackdrop(event) {
  const {left, right, top, bottom} = dialog.value.getBoundingClientRect();
  if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) {
    emit('dismiss');
  }
}

async function follow() {
  navigationError.value = false;
  try {
    await props.author.openSpace();
  } catch {
    navigationError.value = true;
  }
}
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="toy-follow" :aria-labelledby="titleId"
            @click.self="onBackdrop" @cancel.prevent>
      <div class="toy-follow-content">
        <img v-if="author.avatar" class="toy-follow-avatar" :src="author.avatar" alt="">
        <h2 :id="titleId">关注 {{ author.name }}</h2>
        <button type="button" @click="follow">去关注</button>
        <p v-if="navigationError" role="status">暂时打不开 UP 主空间</p>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.toy-follow {
  inline-size: min(320px, 70vw);
  max-block-size: calc(100% - 32px);
  padding: 0;
  border: 0;
  border-radius: 16px;
  background: #fff;
  color: #18191c;
  box-shadow: 0 8px 32px rgb(0 0 0 / .2);
  color-scheme: light;
}

.toy-follow::backdrop {
  background: rgb(12 18 26 / .48);
}

.toy-follow-content {
  display: grid;
  justify-items: center;
  gap: 12px;
  padding: 24px;
  text-align: center;
}

.toy-follow-avatar {
  inline-size: 52px;
  block-size: 52px;
  border-radius: 50%;
  object-fit: cover;
}

.toy-follow h2 {
  margin: 0;
  font-size: 18px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.toy-follow p {
  margin: 0;
  color: #61666d;
  font-size: 14px;
}

.toy-follow button {
  inline-size: 100%;
  min-block-size: 44px;
  margin-block-start: 4px;
  border: 0;
  border-radius: 8px;
  background: #c62d63;
  color: #fff;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.toy-follow button:focus-visible {
  outline: 2px solid #942349;
  outline-offset: 3px;
}
</style>
