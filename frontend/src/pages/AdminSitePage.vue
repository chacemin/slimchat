<script setup>
import AdminSiteAppearance from '../components/admin/AdminSiteAppearance.vue';
import { t } from '../i18n.js';
</script>

<template>
  <div class="admin-section">
    <header class="admin-section__header">
      <div class="admin-section__heading">
        <h2>{{ t('site.title') }}</h2>
        <p>{{ t('site.description') }}</p>
      </div>
    </header>

    <div class="admin-section__body">
      <section id="site-appearance" class="admin-anchor-section">
        <AdminSiteAppearance />
      </section>
      <section id="version-update" class="admin-anchor-section">
      </section>
    </div>
  </div>
</template>
