<script setup>
defineProps({filled: Boolean});
const favoriteColor = '#ff6373';
</script>

<template>
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      :fill="filled ? favoriteColor : 'none'"
      :stroke="filled ? favoriteColor : 'currentColor'"
      d="M12 19.5C7 16 3.5 13.3 3.5 8.9a4.5 4.5 0 0 1 8.5-2.1 4.5 4.5 0 0 1 8.5 2.1c0 4.4-3.5 7.1-8.5 10.6Z"
    />
  </svg>
</template>
