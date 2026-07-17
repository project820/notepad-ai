import { t } from './i18n';

const AI_CHAT_ERROR_KEYS: Record<string, string> = {
  grok_composer_requires_api_key: 'error.grokComposerRequiresApiKey',
};

/** Returns localized copy for stable errors, preserving provider detail otherwise. */
export function aiChatErrorMessage(error: { errorCode?: string; message?: string }): string {
  const key = error.errorCode && AI_CHAT_ERROR_KEYS[error.errorCode];
  return key ? t(key) : error.message ?? t('status.aiError');
}
