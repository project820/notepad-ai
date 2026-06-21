import { t } from './i18n';

export type ManualExplanationQuestion = 'purpose' | 'folder_scope' | 'constraints';

const manualQuestionKey: Record<ManualExplanationQuestion, string> = {
  purpose: 'pw.manual.purpose',
  folder_scope: 'pw.manual.folderScope',
  constraints: 'pw.manual.constraints',
};

function escapeHTML(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderProjectWizardConsent(projectFolder: string): string {
  const folder = escapeHTML(projectFolder);
  const copy = t('pw.consent.copy').replace('{folder}', `<strong>${folder}</strong>`);

  return `<div class="pw-card">
  <h3 class="pw-title">${escapeHTML(t('pw.consent.title'))}</h3>
  <p class="pw-copy">${copy}</p>
  <div class="pw-actions">
    <button class="pw-btn pw-primary" data-pw-action="start" type="button">${escapeHTML(t('pw.btn.start'))}</button>
    <button class="pw-btn" data-pw-action="later" type="button">${escapeHTML(t('pw.btn.later'))}</button>
    <button class="pw-btn" data-pw-action="never" type="button">${escapeHTML(t('pw.btn.never'))}</button>
  </div>
</div>`;
}

export function renderManualExplanationPrompt(question: ManualExplanationQuestion): string {
  const label = escapeHTML(t(manualQuestionKey[question]));

  return `<div class="pw-card">
  <h3 class="pw-title">${label}</h3>
  <p class="pw-copy">${escapeHTML(t('pw.manual.copy'))}</p>
  <textarea class="pw-draft pw-answer" rows="6" data-pw-field="manual-answer" aria-label="${label}"></textarea>
  <div class="pw-actions">
    <button class="pw-btn pw-primary" data-pw-action="manual-next" type="button">${escapeHTML(t('pw.btn.next'))}</button>
    <button class="pw-btn" data-pw-action="cancel-draft" type="button">${escapeHTML(t('pw.btn.saveLater'))}</button>
  </div>
</div>`;
}

export function renderEditableDraft(body: string): string {
  return `<div class="pw-card">
  <h3 class="pw-title">${escapeHTML(t('pw.draft.title'))}</h3>
  <textarea class="pw-draft" rows="14" spellcheck="true">${escapeHTML(body)}</textarea>
  <div class="pw-actions">
    <button class="pw-btn pw-primary" data-pw-action="approve-draft" type="button">${escapeHTML(t('pw.btn.approve'))}</button>
    <button class="pw-btn" data-pw-action="cancel-draft" type="button">${escapeHTML(t('pw.btn.saveLater'))}</button>
  </div>
</div>`;
}
