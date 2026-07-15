import { dialog, type BrowserWindow } from 'electron';
import { basename, dirname } from 'node:path';
import { handleTrusted } from '../ipc-guard';
import type { FileGrants } from '../file-grants';
import type { HtmlExportAssetRegistry } from '../html-export-asset-registry';
import type { HtmlExportAttemptRegistry } from '../html-export-attempt-registry';
import {
  HTML_ASSET_PICK_MAX_BASENAME_HINTS,
  HTML_ASSET_PICK_MAX_BASENAME_LENGTH,
  HTML_EXPORT_RETAINED_ASSET_MAX_COUNT,
  type HtmlAssetPickError,
  type HtmlAssetPickRejection,
  type PickHtmlAssetsRequest,
  type PickHtmlAssetsResponse,
} from '../../shared/html-export-assets';
import { isOpaqueHtmlExportId } from '../../shared/html-export-pipeline';

type HtmlExportAssetPicker = (
  ownerWindow: BrowserWindow,
  options: {
    properties: ['openFile', 'multiSelections'];
    filters: { name: string; extensions: string[] }[];
    defaultPath?: string;
  },
) => Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>;

type HtmlExportAssetIpcDeps = {
  windowForWebContents: (webContentsId: number) => BrowserWindow | null;
  currentDocumentPathForWebContents: (webContentsId: number) => string | null | undefined;
  fileGrants: Pick<FileGrants, 'authorizeExistingFile' | 'authorizeWriteTarget' | 'grantAssetSelection'>;
  assetRegistry: Pick<HtmlExportAssetRegistry, 'issueFromExplicitSelection' | 'invalidateAttempt'>;
  attemptRegistry: Pick<HtmlExportAttemptRegistry, 'getActiveAttempt'>;
  pickAssets?: HtmlExportAssetPicker;
};

type DefaultPathResult =
  | { readonly ok: true; readonly defaultPath?: string }
  | { readonly ok: false; readonly operation: 'current-document-authorization' | 'stale-attempt' };

function reportOperationFailure(operation: string, webContentsId: number): void {
  console.warn('[html-export-assets] operation failed', { operation, webContentsId });
}

const RASTER_FILTERS = [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }];

function isExactPlainObject(input: unknown): input is Record<string, unknown> {
  return !!input
    && typeof input === 'object'
    && !Array.isArray(input)
    && (Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null);
}

function isDisplayBasename(input: unknown): input is string {
  return typeof input === 'string'
    && input.length > 0
    && input.length <= HTML_ASSET_PICK_MAX_BASENAME_LENGTH
    && !input.includes('/')
    && !input.includes('\\')
    && !input.includes('\0');
}

// Basename hints are bounded display context only; they never select or authorize files.
function isPickHtmlAssetsRequest(input: unknown): input is PickHtmlAssetsRequest {
  if (!isExactPlainObject(input) || Object.getOwnPropertySymbols(input).length !== 0) return false;
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes('attemptId') || !keys.includes('basenameHints')) return false;
  if (!isOpaqueHtmlExportId(input.attemptId) || !Array.isArray(input.basenameHints)) return false;
  if (input.basenameHints.length > HTML_ASSET_PICK_MAX_BASENAME_HINTS) return false;

  for (const hint of input.basenameHints) {
    if (!isExactPlainObject(hint) || Object.getOwnPropertySymbols(hint).length !== 0) return false;
    const hintKeys = Object.keys(hint);
    if (hintKeys.length !== 1 || hintKeys[0] !== 'basename' || !isDisplayBasename(hint.basename)) {
      return false;
    }
  }
  return true;
}

function failure(error: HtmlAssetPickError): PickHtmlAssetsResponse {
  return { ok: false, error };
}
type HtmlExportAssetOwner = Parameters<HtmlExportAssetIpcDeps['assetRegistry']['invalidateAttempt']>[0];
const HTML_ASSET_PICK_MAX_PENDING_PER_SENDER = 1;
const HTML_ASSET_PICK_MAX_PENDING = 8;
const pendingPickerAttemptIdsByWebContents = new Map<number, Set<string>>();
let pendingPickerCount = 0;

function admitPendingPicker(owner: HtmlExportAssetOwner): boolean {
  const pendingAttemptIds = pendingPickerAttemptIdsByWebContents.get(owner.webContentsId);
  if (
    pendingPickerCount >= HTML_ASSET_PICK_MAX_PENDING
    || pendingAttemptIds?.has(owner.attemptId)
    || (pendingAttemptIds?.size ?? 0) >= HTML_ASSET_PICK_MAX_PENDING_PER_SENDER
  ) {
    return false;
  }

  const attemptIds = pendingAttemptIds ?? new Set<string>();
  attemptIds.add(owner.attemptId);
  pendingPickerAttemptIdsByWebContents.set(owner.webContentsId, attemptIds);
  pendingPickerCount += 1;
  return true;
}

function releasePendingPicker(owner: HtmlExportAssetOwner): void {
  const pendingAttemptIds = pendingPickerAttemptIdsByWebContents.get(owner.webContentsId);
  if (!pendingAttemptIds?.delete(owner.attemptId)) return;

  if (pendingAttemptIds.size === 0) {
    pendingPickerAttemptIdsByWebContents.delete(owner.webContentsId);
  }
  pendingPickerCount = Math.max(0, pendingPickerCount - 1);
}

function staleAttemptFailure(
  assetRegistry: HtmlExportAssetIpcDeps['assetRegistry'],
  owner: HtmlExportAssetOwner,
): PickHtmlAssetsResponse {
  try {
    assetRegistry.invalidateAttempt(owner);
  } catch {
    // Stale cleanup is best-effort and must not expose private registry failures.
  }
  return failure('stale-attempt');
}

function rejectionFor(basenameHint: string, error: HtmlAssetPickRejection['error']): HtmlAssetPickRejection {
  return { basename: basenameHint, error };
}

function issueError(error: string): HtmlAssetPickRejection['error'] {
  if (error === 'asset-too-large' || error === 'encoded-too-large') return 'asset-too-large';
  if (error === 'identity-mismatch' || error === 'changed-during-read') return 'asset-changed';
  if (error === 'asset-budget-exceeded') return 'asset-budget-exceeded';
  if (
    error === 'unsupported-magic'
    || error === 'extension-mismatch'
    || error === 'malformed-header'
    || error === 'dimension-limit'
    || error === 'pixel-limit'
  ) {
    return 'asset-invalid';
  }
  return 'asset-operation-failed';
}

async function defaultPathForCurrentDocument(
  webContentsId: number,
  currentDocumentPathForWebContents: HtmlExportAssetIpcDeps['currentDocumentPathForWebContents'],
  fileGrants: HtmlExportAssetIpcDeps['fileGrants'],
  isAttemptActive: () => boolean,
): Promise<DefaultPathResult> {
  try {
    const currentPath = currentDocumentPathForWebContents(webContentsId);
    if (!currentPath) return { ok: true };

    const existing = await fileGrants.authorizeExistingFile(webContentsId, currentPath);
    if (!isAttemptActive()) return { ok: false, operation: 'stale-attempt' };
    if (existing) return { ok: true, defaultPath: dirname(existing.grant.realpath) };

    const writeTarget = await fileGrants.authorizeWriteTarget(webContentsId, currentPath);
    if (!isAttemptActive()) return { ok: false, operation: 'stale-attempt' };
    if (writeTarget?.scope === 'save-target') {
      return { ok: true, defaultPath: dirname(writeTarget.canonicalTarget) };
    }
    return { ok: true };
  } catch {
    if (!isAttemptActive()) return { ok: false, operation: 'stale-attempt' };
    // Deliberately do not retain or log private filesystem error details.
    return { ok: false, operation: 'current-document-authorization' };
  }
}

function selectedBasename(selectedPath: string): string {
  const selected = basename(selectedPath).split('\\').at(-1) ?? '';
  return isDisplayBasename(selected) ? selected : 'asset';
}

/** Registers only the explicit, main-owned HTML export asset picker. */
export function registerHtmlExportAssetIpc({
  windowForWebContents,
  currentDocumentPathForWebContents,
  fileGrants,
  assetRegistry,
  attemptRegistry,
  pickAssets = (ownerWindow, options) => dialog.showOpenDialog(ownerWindow, options),
}: HtmlExportAssetIpcDeps): void {
  handleTrusted('html:asset:pick', async (event, input: unknown): Promise<PickHtmlAssetsResponse> => {
    if (!isPickHtmlAssetsRequest(input)) return failure('asset-invalid');

    const senderId = event.sender.id;
    const owner = { webContentsId: senderId, attemptId: input.attemptId };
    if (!admitPendingPicker(owner)) return failure('asset-budget-exceeded');

    try {
      const ownerWindow = windowForWebContents(senderId);
      if (!ownerWindow) return failure('no-window');
      if (attemptRegistry.getActiveAttempt(senderId) !== input.attemptId) {
        return staleAttemptFailure(assetRegistry, owner);
      }

      const defaultPathResult = await defaultPathForCurrentDocument(
        senderId,
        currentDocumentPathForWebContents,
        fileGrants,
        () => attemptRegistry.getActiveAttempt(senderId) === input.attemptId,
      );
      if (attemptRegistry.getActiveAttempt(senderId) !== input.attemptId) {
        return staleAttemptFailure(assetRegistry, owner);
      }
      if (!defaultPathResult.ok) {
        if (defaultPathResult.operation === 'stale-attempt') return staleAttemptFailure(assetRegistry, owner);
        reportOperationFailure(defaultPathResult.operation, senderId);
        return failure('asset-operation-failed');
      }
      const { defaultPath } = defaultPathResult;

      let selection: { readonly canceled: boolean; readonly filePaths: readonly string[] };
      try {
        selection = await pickAssets(ownerWindow, {
          properties: ['openFile', 'multiSelections'],
          filters: RASTER_FILTERS,
          ...(defaultPath ? { defaultPath } : {}),
        });
      } catch {
        if (attemptRegistry.getActiveAttempt(senderId) !== input.attemptId) {
          return staleAttemptFailure(assetRegistry, owner);
        }
        return failure('picker-failed');
      }

      if (attemptRegistry.getActiveAttempt(senderId) !== input.attemptId) {
        return staleAttemptFailure(assetRegistry, owner);
      }
      if (selection.canceled) return failure('cancelled');
      if (selection.filePaths.length > HTML_EXPORT_RETAINED_ASSET_MAX_COUNT) {
        return failure('asset-budget-exceeded');
      }

      const assets = [] as Extract<PickHtmlAssetsResponse, { ok: true }>['assets'][number][];
      const rejected: HtmlAssetPickRejection[] = [];
      for (const selectedPath of selection.filePaths) {
        const selected = selectedBasename(selectedPath);
        if (attemptRegistry.getActiveAttempt(senderId) !== input.attemptId) {
          return staleAttemptFailure(assetRegistry, owner);
        }

        let grant;
        try {
          grant = await fileGrants.grantAssetSelection(senderId, selectedPath);
        } catch {
          if (attemptRegistry.getActiveAttempt(senderId) !== input.attemptId) {
            return staleAttemptFailure(assetRegistry, owner);
          }
          reportOperationFailure('asset-selection-grant', senderId);
          rejected.push(rejectionFor(selected, 'asset-operation-failed'));
          continue;
        }
        if (attemptRegistry.getActiveAttempt(senderId) !== input.attemptId) {
          return staleAttemptFailure(assetRegistry, owner);
        }
        if (!grant) {
          rejected.push(rejectionFor(selected, 'asset-invalid'));
          continue;
        }

        let issued;
        try {
          issued = await assetRegistry.issueFromExplicitSelection(owner, grant);
        } catch {
          issued = { ok: false as const, error: 'asset-operation-failed' };
        }
        if (attemptRegistry.getActiveAttempt(senderId) !== input.attemptId) {
          return staleAttemptFailure(assetRegistry, owner);
        }
        if (issued.ok) {
          assets.push(issued.asset);
        } else if (issued.error === 'stale-attempt') {
          return staleAttemptFailure(assetRegistry, owner);
        } else {
          const error = issueError(issued.error);
          if (error === 'asset-operation-failed') reportOperationFailure('asset-registry-issue', senderId);
          rejected.push(rejectionFor(selected, error));
        }
      }

      if (attemptRegistry.getActiveAttempt(senderId) !== input.attemptId) {
        return staleAttemptFailure(assetRegistry, owner);
      }
      return { ok: true, assets, rejected };
    } finally {
      releasePendingPicker(owner);
    }
  });
}
