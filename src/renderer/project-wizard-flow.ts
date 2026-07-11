import {
  renderEditableDraft,
  renderManualExplanationPrompt,
  renderProjectWizardConsent,
  type ManualExplanationQuestion,
} from './project-wizard-panel';
import { retryProjectWizardAfterFolderGrant } from './project-wizard-access-recovery';
import { savePrefs, type Prefs } from './prefs';
import type { AppContext } from './app-context';
import type { t } from './i18n';
import type { ToolPanelGuard, UnifiedChatHandle } from './unified-chat';

type ProjectWizardFlowDeps = {
  prefs: Prefs;
  t: typeof t;
  unifiedChat: UnifiedChatHandle;
  setUnifiedChatOpen: (open: boolean) => void;
  setWorkspaceRoot: (path: string | null) => void;
};

export function folderFromFilePath(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  if (slash < 0) return '';
  return slash === 0 ? '/' : filePath.slice(0, slash);
}

export function initProjectWizardFlow(ctx: AppContext, deps: ProjectWizardFlowDeps) {
  const wizardQuestions: ManualExplanationQuestion[] = ['purpose', 'folder_scope', 'constraints'];

  async function startProjectWizard(guard: ToolPanelGuard) {
    if (!guard.isCurrent()) return;
    const folder = ctx.currentPath ? folderFromFilePath(ctx.currentPath) : '';
    if (!folder) {
      deps.setUnifiedChatOpen(true);
      deps.unifiedChat.showPanel(`<div class="uc-notice">${deps.t('uc.project.noFile')}</div>`);
      ctx.setStatus(deps.t('uc.project.noFile'));
      return;
    }
    try {
      await window.api.projectWizardStart(folder);
      if (!guard.isCurrent()) return;
      deps.setUnifiedChatOpen(true);
      showProjectWizardConsent(folder);
      ctx.setStatus(deps.t('pw.status.started'));
    } catch (error) {
      if (!guard.isCurrent()) return;
      if (error instanceof Error && error.message === 'Project folder is not authorized') {
        try {
          const projectFolder = await retryProjectWizardAfterFolderGrant(folder, {
            openFolder: () => window.api.openFolder(),
            grantWorkspace: (grantedFolder) => {
              deps.prefs.workspaceRoot = grantedFolder;
              savePrefs(deps.prefs);
              deps.setWorkspaceRoot(grantedFolder);
            },
            startProjectWizard: (projectFolder) => window.api.projectWizardStart(projectFolder),
          });
          if (!projectFolder) return;
          if (!guard.isCurrent()) return;
          deps.setUnifiedChatOpen(true);
          showProjectWizardConsent(projectFolder);
          ctx.setStatus(deps.t('pw.status.started'));
        } catch (retryError) {
          console.error('Project Wizard failed', retryError);
          ctx.setStatus(deps.t('pw.status.failed'));
        }
        return;
      }
      console.error('Project Wizard failed', error);
      ctx.setStatus(deps.t('pw.status.failed'));
    }
  }

  function showProjectWizardConsent(folder: string) {
    deps.unifiedChat.showPanel(renderProjectWizardConsent(folder), (action) => {
      if (action === 'start') {
        showProjectWizardQuestion(folder, 0, {});
        return;
      }
      if (action === 'later') {
        ctx.setStatus(deps.t('pw.status.savedLater'));
        return;
      }
      if (action === 'never') ctx.setStatus(deps.t('pw.status.disabled'));
    });
  }

  function showProjectWizardQuestion(
    folder: string,
    index: number,
    answers: Partial<Record<ManualExplanationQuestion, string>>,
  ) {
    const question = wizardQuestions[index];
    deps.unifiedChat.showPanel(renderManualExplanationPrompt(question), (action, panel) => {
      if (action === 'cancel-draft') {
        ctx.setStatus(deps.t('pw.status.draftSaved'));
        return;
      }
      if (action !== 'manual-next') return;
      const answer = (panel.querySelector('[data-pw-field="manual-answer"]') as HTMLTextAreaElement | null)?.value.trim() ?? '';
      if (!answer) {
        ctx.setStatus(deps.t('pw.status.answerRequired'));
        return;
      }
      const nextAnswers = { ...answers, [question]: answer };
      const nextIndex = index + 1;
      if (nextIndex < wizardQuestions.length) {
        showProjectWizardQuestion(folder, nextIndex, nextAnswers);
        return;
      }
      showProjectWizardDraft(folder, buildProjectWizardDraft(nextAnswers));
    });
  }

  function showProjectWizardDraft(folder: string, body: string) {
    deps.unifiedChat.showPanel(renderEditableDraft(body), (action, panel) => {
      if (action === 'cancel-draft') {
        ctx.setStatus(deps.t('pw.status.draftSaved'));
        return;
      }
      if (action !== 'approve-draft') return;
      const draftBody = (panel.querySelector('.pw-draft') as HTMLTextAreaElement | null)?.value ?? body;
      void window.api.projectWizardSaveApprovedDraft({
        projectFolder: folder,
        body: draftBody,
        frontmatter: {},
        inherits: true,
        lastScanned: null,
      }).then((result) => {
        ctx.setStatus(deps.t('pw.status.saved').replace('{status}', result.status.replace('_', ' ')));
      }).catch((error) => {
        console.error('Project Wizard save failed', error);
        ctx.setStatus(deps.t('pw.status.saveFailed'));
      });
    });
  }

  return { startProjectWizard };
}

function buildProjectWizardDraft(answers: Partial<Record<ManualExplanationQuestion, string>>): string {
  const purpose = answers.purpose?.trim() || 'Describe this project.';
  const scope = answers.folder_scope?.trim() || 'Describe the folder scope.';
  const constraints = answers.constraints?.trim() || 'List constraints, risks, or things AI should not assume.';
  return [
    '## Purpose', purpose, '', '## Background', '', '## Current Goals', '', '## Writing Rules', constraints, '',
    '## Key Entities', '', '## Source Map', '| File | Role | Notes |', '|---|---|---|',
    `| ${folderLabelFromScope(scope)} | Project scope | ${scope} |`, '', '## Open Questions', '',
    '## Context Inbox Notes', '', '## Do Not Assume', constraints, '',
  ].join('\n');
}

function folderLabelFromScope(scope: string): string {
  return scope.replace(/\|/g, '/').replace(/\n+/g, ' ').slice(0, 80) || 'Project folder';
}
