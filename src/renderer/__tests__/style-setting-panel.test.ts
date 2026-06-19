import { describe, expect, it } from 'vitest';

import { renderStyleSettingPanel } from '../style-setting-panel';
import { DEFAULT_STYLE } from '../humanize-engine';

describe('renderStyleSettingPanel', () => {
  it('renders one difficulty select and one naturalness select', () => {
    const html = renderStyleSettingPanel({ setting: DEFAULT_STYLE });
    expect(html).toContain('data-style="difficulty"');
    expect(html).toContain('data-style="naturalness"');
  });

  it('offers all five difficulty levels and four naturalness levels', () => {
    const html = renderStyleSettingPanel({ setting: DEFAULT_STYLE });
    for (const v of ['elementary', 'highschool', 'college', 'professor', 'professional']) {
      expect(html).toContain(`value="${v}"`);
    }
    for (const v of ['off', 'light', 'balanced', 'strong']) {
      expect(html).toContain(`value="${v}"`);
    }
  });

  it('marks the current setting as selected', () => {
    const html = renderStyleSettingPanel({ setting: { difficulty: 'professional', naturalness: 'strong' } });
    expect(html).toMatch(/value="professional" selected/);
    expect(html).toMatch(/value="strong" selected/);
    expect(html).not.toMatch(/value="college" selected/);
  });

  it('defaults (college/balanced) are reflected as selected', () => {
    const html = renderStyleSettingPanel({ setting: DEFAULT_STYLE });
    expect(html).toMatch(/value="college" selected/);
    expect(html).toMatch(/value="balanced" selected/);
  });

  it('always returns a string', () => {
    expect(typeof renderStyleSettingPanel({ setting: DEFAULT_STYLE })).toBe('string');
  });
});
