/**
 * Renderer-safe HTML export asset protocol and limits.
 *
 * Filesystem paths, identities, and bytes remain main-process-only.
 */

export const ASSET_SOURCE_READ_MAX_BYTES = 1_572_864;
export const ASSET_BASE64_ENCODED_MAX_BYTES = 2 * 1024 * 1024;
export const RASTER_MAX_WIDTH = 8_192;
export const RASTER_MAX_HEIGHT = 8_192;
export const RASTER_MAX_PIXELS = 32_000_000;
export const HTML_EXPORT_RETAINED_ASSET_MAX_COUNT = 64;


export const HTML_ASSET_PICK_MAX_BASENAME_HINTS = 64;
export const HTML_ASSET_PICK_MAX_BASENAME_LENGTH = 255;

export type RasterMime =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif';



declare const htmlAssetIdBrand: unique symbol;

/** Opaque ID meaningful only to the main-owned asset registry. */
export type HtmlAssetId = string & { readonly [htmlAssetIdBrand]: true };

/**
 * The complete renderer-visible representation of a selected HTML asset.
 * It intentionally excludes paths, filesystem identities, and image bytes.
 */
export interface HtmlAssetSummary {
  readonly assetId: HtmlAssetId;
  readonly basename: string;
  readonly mime: RasterMime;
  readonly width: number;
  readonly height: number;
  readonly encodedBytes: number;
}

/** Renderer-safe warning for a required image without a selected asset. */
export interface HtmlAssetWarning {
  readonly kind: 'missing-asset';
  readonly hintId: string;
  readonly basename: string;
}

/** Display-only names parsed from Markdown; they are never filesystem authority. */
export interface HtmlAssetBasenameHint {
  readonly basename: string;
}

/**
 * Pathless request for main-owned multi-file selection. Basename hints provide
 * bounded display-only context and are validated at the IPC boundary, but are
 * never used as filesystem selection or authority.
 */
export interface PickHtmlAssetsRequest {
  readonly attemptId: string;
  readonly basenameHints: readonly HtmlAssetBasenameHint[];
}

export type HtmlAssetPickError =
  | 'asset-too-large'
  | 'asset-invalid'
  | 'asset-changed'
  | 'asset-budget-exceeded'
  | 'asset-operation-failed'
  | 'cancelled'
  | 'no-window'
  | 'picker-failed'
  | 'stale-attempt';

export interface HtmlAssetPickRejection {
  readonly basename: string;
  readonly error: Extract<
    HtmlAssetPickError,
    | 'asset-too-large'
    | 'asset-invalid'
    | 'asset-changed'
    | 'asset-budget-exceeded'
    | 'asset-operation-failed'
  >;
}


export type PickHtmlAssetsResponse =
  | {
      readonly ok: true;
      readonly assets: readonly HtmlAssetSummary[];
      readonly rejected: readonly HtmlAssetPickRejection[];
    }
  | { readonly ok: false; readonly error: HtmlAssetPickError };
export interface HtmlExportAssetApi {
  pickHtmlExportAssets: (request: PickHtmlAssetsRequest) => Promise<PickHtmlAssetsResponse>;
}
