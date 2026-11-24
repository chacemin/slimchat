<script setup>
import ChunkLoadNotice from './components/ChunkLoadNotice.vue';
import store from './store.js';
import { useI18n } from './i18n.js';

const { t } = useI18n();
</script>

<template>
  <div v-if="!store.ready" class="app-loading" role="status" aria-live="polite">
    {{ t('common.loading') }}
  </div>
  <router-view v-else v-slot="{ Component, route }">
    <Transition :name="route.meta.transition || 'page'" mode="out-in">
      <component :is="Component" :key="route.meta.workspace ? 'workspace' : route.path" />
    </Transition>
  </router-view>
  <ChunkLoadNotice />
</template>

<style>
.app-loading {
  position: relative;
  display: grid;
  min-height: 100dvh;
  place-items: center;
  color: var(--text);
}

/* 页面切换 — 丝滑淡入淡出 */
.page-enter-active,
.page-leave-active {
  transition: opacity 240ms cubic-bezier(0.37, 0, 0.63, 1),
              transform 240ms cubic-bezier(0.37, 0, 0.63, 1);
}

.page-enter-from {
  opacity: 0;
  transform: translateY(10px);
}

.page-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
