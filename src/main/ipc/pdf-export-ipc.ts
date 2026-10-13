import { BrowserWindow, dialog } from 'electron';
import path from 'node:path';
import { atomicWrite, nodeAtomicBackend } from '../atomic-write';
import { handleTrusted } from '../ipc-guard';
import { PDF_EXPORT_MAX_HTML_LENGTH, buildPdfDocument, pdfDocumentName, renderPdf } from '../pdf-export';

type PdfExportRequest = { html: string; lang: string };
type PdfExportResult =
  | { status: 'saved'; fileName: string }
  | { status: 'canceled' }
  | { status: 'failed' };

export function registerPdfExportIpc(deps: { documentPathFor: (windowId: number) => string | null }): void {
  const inFlight = new Set<number>();

  handleTrusted('pdf:export', async (event, request: PdfExportRequest): Promise<PdfExportResult> => {
    if (typeof request?.html !== 'string' || request.html.length > PDF_EXPORT_MAX_HTML_LENGTH) return { status: 'failed' };
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || inFlight.has(win.id)) return { status: 'canceled' };
    inFlight.add(win.id);
    try {
      const documentPath = deps.documentPathFor(win.id);
      const name = pdfDocumentName(documentPath);
      const defaultPath = documentPath ? path.join(path.dirname(documentPath), `${name}.pdf`) : `${name}.pdf`;
      const choice = await dialog.showSaveDialog(win, { defaultPath, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
      if (choice.canceled || !choice.filePath) return { status: 'canceled' };
      const target = /\.pdf$/i.test(choice.filePath) ? choice.filePath : `${choice.filePath}.pdf`;
      const lang = typeof request.lang === 'string' ? request.lang : 'en';
      const pdf = await renderPdf(buildPdfDocument({ bodyHtml: request.html, title: name, lang }));
      await atomicWrite(target, pdf, { backend: nodeAtomicBackend(), mode: 0o644 });
      return { status: 'saved', fileName: path.basename(target) };
    } catch (error) {
      console.error('[pdf-export] failed:', error);
      return { status: 'failed' };
    } finally {
      inFlight.delete(win.id);
    }
  });
}
