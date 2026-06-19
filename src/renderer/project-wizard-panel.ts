export type ManualExplanationQuestion = 'purpose' | 'folder_scope' | 'constraints';

const manualQuestionCopy: Record<ManualExplanationQuestion, string> = {
  purpose: 'What is this project or folder for?',
  folder_scope: 'Which files and folders belong in this project context?',
  constraints: 'What constraints, rules, or sensitive boundaries should the AI know?',
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

  return `<div class="pw-card">
  <h3 class="pw-title">Set up Overview.md?</h3>
  <p class="pw-copy">Create a project overview draft for <strong>${folder}</strong>. Nothing is written until you approve the draft.</p>
  <div class="pw-actions">
    <button class="pw-btn pw-primary" data-pw-action="start" type="button">Start setup</button>
    <button class="pw-btn" data-pw-action="later" type="button">Later</button>
    <button class="pw-btn" data-pw-action="never" type="button">Do not ask for this folder</button>
  </div>
</div>`;
}

export function renderManualExplanationPrompt(question: ManualExplanationQuestion): string {
  return `<div class="pw-card">
  <h3 class="pw-title">${escapeHTML(manualQuestionCopy[question])}</h3>
  <p class="pw-copy">Answer briefly so the Project Wizard can prepare the Overview.md draft.</p>
  <textarea class="pw-draft pw-answer" rows="6" data-pw-field="manual-answer" aria-label="${escapeHTML(manualQuestionCopy[question])}"></textarea>
  <div class="pw-actions">
    <button class="pw-btn pw-primary" data-pw-action="manual-next" type="button">Next</button>
    <button class="pw-btn" data-pw-action="cancel-draft" type="button">Save draft for later</button>
  </div>
</div>`;
}

export function renderEditableDraft(body: string): string {
  return `<div class="pw-card">
  <h3 class="pw-title">Review Overview.md draft</h3>
  <textarea class="pw-draft" rows="14" spellcheck="true">${escapeHTML(body)}</textarea>
  <div class="pw-actions">
    <button class="pw-btn pw-primary" data-pw-action="approve-draft" type="button">Approve and save</button>
    <button class="pw-btn" data-pw-action="cancel-draft" type="button">Save draft for later</button>
  </div>
</div>`;
}
