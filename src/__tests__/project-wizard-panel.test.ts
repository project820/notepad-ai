import { describe, it, expect } from 'vitest';
import {
  renderProjectWizardConsent,
  renderManualExplanationPrompt,
  renderEditableDraft,
} from '../renderer/project-wizard-panel';

describe('project wizard panel render helpers', () => {
  it('renders consent actions without writing Overview.md', () => {
    const html = renderProjectWizardConsent('/project');
    expect(html).toContain('Overview.md');
    expect(html).toContain('Start setup');
    expect(html).toContain('Later');
  });

  it('renders Q&A manual explanation prompt fields', () => {
    const html = renderManualExplanationPrompt('purpose');
    expect(html).toContain('What is this project or folder for?');
    expect(html).toContain('data-pw-field="manual-answer"');
    expect(html).toContain('aria-label="What is this project or folder for?"');
    expect(html).toContain('data-pw-action="manual-next"');
  });

  it('renders all manual explanation questions', () => {
    expect(renderManualExplanationPrompt('folder_scope')).toContain('Which files and folders belong');
    expect(renderManualExplanationPrompt('constraints')).toContain('sensitive boundaries');
  });

  it('escapes project folder HTML in consent copy', () => {
    const html = renderProjectWizardConsent('/project/<script>alert("x")</script>');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert("x")</script>');
  });

  it('escapes editable draft body inside textarea', () => {
    const html = renderEditableDraft('</textarea><script>alert("x")</script>');
    expect(html).toContain('&lt;/textarea&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).not.toContain('</textarea><script>alert("x")</script>');
  });
});
