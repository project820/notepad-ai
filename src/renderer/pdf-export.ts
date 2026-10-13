import { createMarkdownIt } from './markdown-it';
import { t, getLocale, onLocaleChange } from './i18n';

type PdfExportResult = { status: 'saved'; fileName: string } | { status: 'canceled' } | { status: 'failed' };
type PdfExportApi = {
  onMenuExportPdf: (cb: () => void) => void;
  setMenuLabels: (labels: { exportPdf: string }) => void;
  exportPdf: (request: { html: string; lang: string }) => Promise<PdfExportResult>;
};

/** Markdown is the source of truth: export renders the current source, never the editable preview DOM. */
function renderPdfBody(markdown: string): string {
  return createMarkdownIt().render(markdown);
}

/**
 * `getSource` returns the canonical Markdown after flushing pending preview
 * edits, or null when the source cannot be brought up to date.
 */
export function wirePdfExport(api: PdfExportApi, getSource: () => string | null, setStatus: (message: string) => void): void {
  const publishLabels = () => api.setMenuLabels({ exportPdf: t('menu.exportPdf') });
  publishLabels();
  onLocaleChange(publishLabels);
  api.onMenuExportPdf(async () => {
    const source = getSource();
    if (source === null) {
      setStatus(t('status.pdfExportFailed'));
      return;
    }
    setStatus(t('status.pdfExporting'));
    try {
      const result = await api.exportPdf({ html: renderPdfBody(source), lang: getLocale() });
      if (result.status === 'saved') setStatus(t('status.pdfExported').replace('{fileName}', result.fileName));
      else if (result.status === 'failed') setStatus(t('status.pdfExportFailed'));
      else setStatus('');
    } catch {
      setStatus(t('status.pdfExportFailed'));
    }
  });
}
