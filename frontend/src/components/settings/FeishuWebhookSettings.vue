<script setup>
import { onMounted, reactive, ref } from 'vue';
import api from '../../api.js';
import { useI18n } from '../../i18n.js';

const { t } = useI18n();
const loaded = ref(false);
const saving = ref(false);
const testing = ref(false);
const info = ref('');
const error = ref('');
const form = reactive({ webhookUrl: '', enabled: true });

function applyConfig(config) {
  form.webhookUrl = config.webhookUrl || '';
  form.enabled = Boolean(config.enabled) && Boolean(config.webhookUrl);
}

async function load() {
  try {
    applyConfig(await api.feishuWebhook());
  } catch (currentError) {
    error.value = currentError.message || t('settings.feishuLoadFailed');
  } finally {
    loaded.value = true;
  }
}

async function save() {
  if (saving.value) return;
  saving.value = true;
  info.value = '';
  error.value = '';
  try {
    applyConfig(await api.saveFeishuWebhook({
      webhookUrl: form.webhookUrl.trim(),
      enabled: form.enabled
    }));
    info.value = form.webhookUrl ? t('settings.feishuSaved') : t('settings.feishuDisabled');
  } catch (currentError) {
    error.value = currentError.message;
  } finally {
    saving.value = false;
  }
}

async function sendTest() {
  if (testing.value) return;
  testing.value = true;
  info.value = '';
  error.value = '';
  try {
    await api.testFeishuWebhook({ webhookUrl: form.webhookUrl.trim() });
    info.value = t('settings.feishuTestSent');
  } catch (currentError) {
    error.value = currentError.message || t('settings.feishuTestFailed');
  } finally {
    testing.value = false;
  }
}

async function clear() {
  form.webhookUrl = '';
  form.enabled = false;
  await save();
}

onMounted(load);
</script>

<template>
  <section class="settings-section feishu-webhook-settings">
    <h2>{{ t('settings.feishuTitle') }}</h2>
    <p class="feishu-webhook-hint">{{ t('settings.feishuDescription') }}</p>
    <label class="field-compact">
      <span>{{ t('settings.feishuUrl') }}</span>
      <input
        v-model.trim="form.webhookUrl"
        type="url"
        inputmode="url"
        autocomplete="off"
        spellcheck="false"
        :placeholder="t('settings.feishuUrlPlaceholder')"
        :disabled="!loaded || saving"
      />
    </label>
    <small class="feishu-webhook-hint">{{ t('settings.feishuUrlHint') }}</small>
    <label class="feishu-webhook-toggle">
      <input v-model="form.enabled" type="checkbox" :disabled="!loaded || saving" />
      <span>{{ t('settings.feishuEnabled') }}</span>
    </label>
    <div class="feishu-webhook-actions">
      <button type="button" class="save-btn" :disabled="!loaded || saving || testing" @click="save">
        {{ saving ? t('settings.feishuSaving') : t('settings.feishuSave') }}
      </button>
      <button type="button" class="save-btn feishu-test-btn" :disabled="!loaded || saving || testing" @click="sendTest">
        {{ testing ? t('settings.feishuTesting') : t('settings.feishuTest') }}
      </button>
      <button
        v-if="form.webhookUrl"
        type="button"
        class="feishu-clear-btn"
        :disabled="saving || testing"
        @click="clear"
      >
        {{ t('settings.feishuClear') }}
      </button>
    </div>
    <p class="feishu-webhook-rules">{{ t('settings.feishuRules') }}</p>
    <p v-if="info" class="feishu-webhook-info" role="status">{{ info }}</p>
    <p v-if="error" class="feishu-webhook-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.feishu-webhook-settings { gap: 10px; }
.feishu-webhook-hint,
.feishu-webhook-rules {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--auth-muted, #6b8aab);
}
.feishu-webhook-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 32px;
  font-size: 13px;
  color: var(--auth-ink, #2c4a6e);
  cursor: pointer;
}
.feishu-webhook-toggle input {
  width: 18px;
  height: 18px;
  accent-color: var(--auth-brand, #5b8dbf);
}
.feishu-webhook-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.feishu-webhook-settings .field-compact {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.feishu-webhook-settings .field-compact span {
  font-size: 11px;
  font-weight: 600;
  color: var(--auth-muted, #6b8aab);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.feishu-webhook-settings .field-compact input {
  width: 100%;
  padding: 10px 14px;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  background: rgba(255, 255, 255, 0.6);
  color: var(--auth-ink, #2c4a6e);
  outline: none;
  box-sizing: border-box;
}
.feishu-webhook-settings .field-compact input:focus {
  border-color: rgba(var(--site-brand-rgb, 91, 141, 191), 0.35);
  box-shadow: 0 0 0 3px rgba(var(--site-brand-rgb, 91, 141, 191), 0.08);
  background: rgba(255, 255, 255, 0.9);
}
.feishu-webhook-actions .save-btn {
  padding: 10px 20px;
  border: none;
  border-radius: 12px;
  background: var(--site-button-background, linear-gradient(135deg, rgba(91, 141, 191, 0.85), rgba(69, 121, 186, 0.8)));
  color: var(--site-on-action, #fff);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(var(--site-brand-rgb, 91, 141, 191), 0.2);
}
.feishu-webhook-actions .save-btn:hover:not(:disabled) { transform: translateY(-1px); }
.feishu-webhook-actions .save-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.feishu-test-btn { opacity: 0.92; }
.feishu-clear-btn {
  min-height: 38px;
  padding: 0 12px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 12px;
  background: transparent;
  color: var(--auth-muted, #6b8aab);
  font-size: 13px;
  cursor: pointer;
}
.feishu-webhook-info { margin: 0; font-size: 13px; color: #4a8d6e; }
.feishu-webhook-error { margin: 0; font-size: 13px; color: #d9534f; }
.feishu-webhook-settings .field-compact input { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
</style>
