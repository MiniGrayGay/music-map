<script setup>
import {computed, onBeforeUnmount, onMounted, ref, useId} from 'vue';
import {pushEscapeHandler} from './escapeStack.js';

const props = defineProps({author: {type: Object, required: true}});
const emit = defineEmits(['dismiss']);
const dialog = ref(null);
const titleId = useId();
const navigationError = ref(false);
const followers = computed(() => Number.isFinite(props.author.followers)
  ? new Intl.NumberFormat('zh-CN', {notation: 'compact', maximumFractionDigits: 1})
    .format(props.author.followers) : null);
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
      <div class="toy-follow-author">
        <span class="toy-follow-avatar" aria-hidden="true">
          <img v-if="author.avatar" :src="author.avatar" alt="" referrerpolicy="no-referrer"
               @error="$event.target.hidden = true">
        </span>
        <div class="toy-follow-profile">
          <h2 :id="titleId" tabindex="-1" autofocus>{{ author.name }}</h2>
          <p v-if="followers !== null">{{ followers }}粉丝</p>
        </div>
        <component
          :is="author.href ? 'a' : 'button'"
          class="toy-follow-action"
          :type="author.href ? undefined : 'button'"
          :href="author.href"
          :target="author.href ? '_blank' : undefined"
          :rel="author.href ? 'noopener noreferrer' : undefined"
          @click="!author.href && follow()"
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M8 2.75v10.5m-5.25-5.25h10.5" fill="none" stroke="currentColor"
                  stroke-width="1.5" stroke-linecap="round" />
          </svg>
          去关注
        </component>
      </div>
      <p v-if="navigationError" class="toy-follow-error" role="status">暂时打不开 UP 主空间</p>
    </dialog>
  </Teleport>
</template>

<style scoped>
.toy-follow {
  --bili-follow-accent: #ff6699;
  --bili-follow-hover: #e84b85;
  inline-size: min(360px, 70vw);
  max-block-size: calc(100% - 32px);
  padding: 0;
  border: 0;
  border-radius: 12px;
  background: #fff;
  color: #18191c;
  box-shadow: 0 8px 32px rgb(0 0 0 / .2);
  color-scheme: light;
}

.toy-follow::backdrop {
  background: rgb(12 18 26 / .48);
}

.toy-follow-author {
  display: grid;
  justify-items: center;
  gap: 16px;
  padding: 28px 20px 20px;
  text-align: center;
}

.toy-follow-avatar {
  inline-size: 64px;
  block-size: 64px;
  overflow: hidden;
  border-radius: 50%;
  background: #e3e5e7;
}

.toy-follow-avatar img {
  inline-size: 100%;
  block-size: 100%;
  object-fit: cover;
}

.toy-follow-profile {
  max-inline-size: 100%;
}

.toy-follow h2 {
  margin: 0;
  overflow: hidden;
  font-size: 18px;
  font-weight: 600;
  line-height: 24px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toy-follow h2:focus { outline: none; }

.toy-follow-profile p {
  margin: 4px 0 0;
  color: #61666d;
  font-size: 14px;
  line-height: 20px;
}

.toy-follow-action {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  inline-size: 100%;
  min-block-size: 44px;
  padding: 0 12px;
  border: 0;
  border-radius: 8px;
  background: var(--bili-follow-accent);
  color: #fff;
  font: inherit;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
  transition: background-color 150ms ease;
}

@media (hover: hover) {
  .toy-follow-action:hover { background: var(--bili-follow-hover); }
}

.toy-follow-action:focus { outline: none; }

.toy-follow-action:focus-visible {
  outline: 2px solid var(--bili-follow-hover);
  outline-offset: 3px;
}

.toy-follow-error {
  margin: 0;
  padding: 0 20px 16px;
  color: #61666d;
  font-size: 13px;
  text-align: center;
}

@media (prefers-reduced-motion: no-preference) {
  .toy-follow[open] { animation: ui-fade-up 180ms ease-out both; }
}
</style>
