/**
 * restore-banner.ts — DOM builder for the crash/quit restore banner (Phase 0 seam).
 *
 * The previous `showRestoreBanner` interpolated the persisted document preview
 * (attacker-influenceable Markdown source) straight into `root.innerHTML`, which
 * bypasses the preview's `html:false` defense and parses any `<a>`/`<form>`/style
 * payload as live DOM. This builder constructs the same banner with createElement
 * + textContent only, so document content can never become active DOM.
 *
 * Pure aside from the injected `Document`, so it is unit-testable under happy-dom.
 */

export interface RestoreBannerLabels {
  title: string;
  yes: string;
  no: string;
}

export interface RestoreBannerData {
  doc?: string;
  savedAt?: number;
}

/** Build the restore-banner element. Caller wires click handlers to `.restore-yes` / `.restore-no`. */
export function buildRestoreBanner(
  data: RestoreBannerData,
  labels: RestoreBannerLabels,
  doc: Document = document,
): HTMLElement {
  const root = doc.createElement('div');
  root.className = 'restore-banner';

  const textWrap = doc.createElement('div');
  textWrap.className = 'restore-banner-text';

  const strong = doc.createElement('strong');
  strong.textContent = labels.title;

  const span = doc.createElement('span');
  const preview = (typeof data.doc === 'string' ? data.doc : '')
    .slice(0, 80)
    .replace(/\n+/g, ' • ')
    .trim();
  const when = typeof data.savedAt === 'number' ? new Date(data.savedAt).toLocaleString() : '';
  span.textContent = `${preview || '(empty)'}${when ? ` · ${when}` : ''}`;

  textWrap.append(strong, span);

  const actions = doc.createElement('div');
  actions.className = 'restore-banner-actions';

  const yes = doc.createElement('button');
  yes.className = 'restore-yes';
  yes.textContent = labels.yes;

  const no = doc.createElement('button');
  no.className = 'restore-no';
  no.textContent = labels.no;

  actions.append(yes, no);
  root.append(textWrap, actions);
  return root;
}
