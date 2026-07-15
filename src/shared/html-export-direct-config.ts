/**
 * html-export-direct-config.ts — frozen §5.14 / AC-M1a config for the
 * direct-authoring HTML export redesign (R1).
 *
 * Pure shared module: purpose-derived defaults + deterministic resolve.
 * Additive only — coexists with the legacy JSON content-model path.
 */

export type DirectExportPurpose = 'presentation' | 'document' | 'report' | 'landing';

export type DirectExportOrientation = 'landscape' | 'portrait';

export type DirectExportMode = 'slide' | 'scroll';

export type DirectExportDensity = 'minimal' | 'balanced' | 'full';

export type DirectExportConfig = {
  purpose: DirectExportPurpose;
  orientation: DirectExportOrientation;
  mode: DirectExportMode;
  density: DirectExportDensity;
  designId?: string;
  designMd?: string;
  userRequest?: string;
  model?: string;
  /** A/B/C/D summary/visualization strength — the wizard's core control. */
  summaryChartMode?: 'A' | 'B' | 'C' | 'D';
  /** Advanced knob: preferred reading measure for scroll/document layouts. */
  readableWidth?: 'narrow' | 'normal' | 'wide';
  /** Advanced knob: allow tasteful CSS-only interactivity vs a static document. */
  interactive?: boolean;
  /** Free-text purpose override when the wizard purpose is a custom brief. */
  customPurpose?: string;
};

export const PURPOSE_DEFAULTS: Record<
  DirectExportPurpose,
  {
    orientation: DirectExportOrientation;
    mode: DirectExportMode;
    density: DirectExportDensity;
  }
> = {
  presentation: { orientation: 'landscape', mode: 'slide', density: 'minimal' },
  document: { orientation: 'portrait', mode: 'scroll', density: 'full' },
  report: { orientation: 'portrait', mode: 'scroll', density: 'balanced' },
  landing: { orientation: 'portrait', mode: 'scroll', density: 'minimal' },
};

/**
 * Resolve a full DirectExportConfig from a purpose plus optional overrides.
 * Starts from PURPOSE_DEFAULTS[purpose], then applies any explicit
 * orientation / mode / density override. Passes through designId, designMd,
 * userRequest, and model. Deterministic pure function.
 */
export function resolveDirectExportConfig(input: {
  purpose: DirectExportPurpose;
  orientation?: DirectExportOrientation;
  mode?: DirectExportMode;
  density?: DirectExportDensity;
  designId?: string;
  designMd?: string;
  userRequest?: string;
  model?: string;
  summaryChartMode?: 'A' | 'B' | 'C' | 'D';
  readableWidth?: 'narrow' | 'normal' | 'wide';
  interactive?: boolean;
  customPurpose?: string;
}): DirectExportConfig {
  const defaults = PURPOSE_DEFAULTS[input.purpose];
  const config: DirectExportConfig = {
    purpose: input.purpose,
    orientation: input.orientation ?? defaults.orientation,
    mode: input.mode ?? defaults.mode,
    density: input.density ?? defaults.density,
  };
  // Empty / whitespace optionals are treated as absent so the 1:1 prompt mapping
  // never emits a directive for a value the user did not actually provide.
  const designId = input.designId?.trim();
  const designMd = input.designMd?.trim();
  const userRequest = input.userRequest?.trim();
  const model = input.model?.trim();
  if (designId) config.designId = designId;
  if (designMd) config.designMd = designMd;
  if (userRequest) config.userRequest = userRequest;
  if (model) config.model = model;
  if (input.summaryChartMode) config.summaryChartMode = input.summaryChartMode;
  if (input.readableWidth) config.readableWidth = input.readableWidth;
  if (typeof input.interactive === 'boolean') config.interactive = input.interactive;
  const customPurpose = input.customPurpose?.trim();
  if (customPurpose) config.customPurpose = customPurpose;
  return config;
}
