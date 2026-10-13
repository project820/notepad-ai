import { createMarkdownIt } from './markdown-it';
import { t, getLocale } from './i18n';

type PdfExportResult = { status: 'saved'; fileName: string } | { status: 'canceled' } | { status: 'failed' };
type PdfExportApi = {
  onMenuExportPdf: (cb: () => void) => void;
  exportPdf: (request: { html: string; lang: string }) => Promise<PdfExportResult>;
};

/** Markdown is the source of truth: export renders the current source, never the editable preview DOM. */
function renderPdfBody(markdown: string): string {
  return createMarkdownIt().render(markdown);
}

export function wirePdfExport(api: PdfExportApi, getDoc: () => string, setStatus: (message: string) => void): void {
  api.onMenuExportPdf(async () => {
    setStatus(t('status.pdfExporting'));
    try {
      const result = await api.exportPdf({ html: renderPdfBody(getDoc()), lang: getLocale() });
      if (result.status === 'saved') setStatus(t('status.pdfExported').replace('{fileName}', result.fileName));
      else if (result.status === 'failed') setStatus(t('status.pdfExportFailed'));
      else setStatus('');
    } catch {
      setStatus(t('status.pdfExportFailed'));
    }
  });
}
