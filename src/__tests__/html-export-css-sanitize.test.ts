import { describe, expect, it } from 'vitest';
import {
  CSS_MAX_ANIMATIONS_PER_ELEMENT,
  CSS_MAX_COMPOUND_DEPTH,
  CSS_MAX_DECLARATIONS,
  CSS_MAX_DECLARATIONS_PER_RULE,
  CSS_MAX_FONT_SIZE_PX,
  CSS_MAX_FRAMES_PER_KEYFRAMES,
  CSS_MAX_KEYFRAMES,
  CSS_MAX_NESTING_DEPTH,
  CSS_MAX_RULES,
  CSS_MAX_SELECTORS_PER_RULE,
  CSS_MAX_STYLESHEET_BYTES,
  CSS_MAX_VALUE_TOKEN_LENGTH,
  CSS_MAX_Z_INDEX,
  CSS_MIN_ANIMATION_DURATION_MS,
  CSS_MIN_Z_INDEX,
  CSS_VIOLATION_CODES,
  createCssSanitizeContext,
  registerCssKeyframes,
  sanitizeDeclarationList,
  sanitizeStylesheet,
} from '../main/html-export-css-sanitize';

function failureCode(result: ReturnType<typeof sanitizeStylesheet>): string {
  return result.ok ? result.stripped[0]?.code ?? '' : result.violations[0].code;
}

function keyframes(name: string): string {
  return `@keyframes ${name}{from{opacity:0}to{opacity:1}}`;
}

describe('html export CSS sanitizer', () => {
  it('exports stable violation codes for downstream pipeline errors', () => {
    expect(CSS_VIOLATION_CODES.parseError).toBe('css_parse_error');
    expect(CSS_VIOLATION_CODES.internal).toBe('css_internal');
    expect(CSS_VIOLATION_CODES.unsafePosition).toBe('css_unsafe_position');
  });
  it('scopes stylesheet selectors and preserves source cascade order', () => {
    expect(sanitizeStylesheet('p{color:red}p{color:blue}')).toMatchObject({
      ok: true,
      css: '[data-he-content] p{color:red}[data-he-content] p{color:blue}',
      ruleCount: 2,
      declarationCount: 2,
    });
  });
  it('strips invalid at-rules without discarding valid sibling rules', () => {
    const result = sanitizeStylesheet('@import url(x);p{color:red}.note{font-weight:700}span{color:blue}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.css).toContain('[data-he-content] p{color:red}');
    expect(result.css).toContain('[data-he-content] .note{font-weight:700}');
    expect(result.css).toContain('[data-he-content] span{color:blue}');
    expect(result.css).not.toContain('@import');
    expect(result.stripped).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: CSS_VIOLATION_CODES.disallowedAtRule }),
    ]));
  });
  it('accepts main and aside type selectors scoped to the content root', () => {
    expect(sanitizeStylesheet('main{color:red}')).toMatchObject({
      ok: true,
      css: '[data-he-content] main{color:red}',
      ruleCount: 1,
      declarationCount: 1,
    });
    expect(sanitizeStylesheet('aside{color:red}')).toMatchObject({
      ok: true,
      css: '[data-he-content] aside{color:red}',
      ruleCount: 1,
      declarationCount: 1,
    });
  });

  it('parses inline declarations and preserves duplicate shorthand/longhand order', () => {
    expect(sanitizeDeclarationList('margin:1px;margin-left:4px;color:red;color:blue')).toMatchObject({
      ok: true,
      css: 'margin:1px;margin-left:4px;color:red;color:blue',
      ruleCount: 0,
      declarationCount: 4,
    });
  });

  it('drops unsupported properties but hard-fails unsafe values', () => {
    expect(sanitizeDeclarationList('appearance:none;clip-path:none;color:red')).toMatchObject({
      ok: true,
      css: 'color:red',
      ruleCount: 0,
      declarationCount: 1,
    });
    expect(failureCode(sanitizeDeclarationList('background:url(https://example.test/a.png)'))).toBe('css_network_function_not_allowed');
    expect(sanitizeDeclarationList('color:var(--accent)').ok).toBe(true);
    expect(sanitizeDeclarationList('color:red!important').ok).toBe(true);
  });

  it('enforces the frozen selector, pseudo, and at-rule grammar', () => {
    expect(failureCode(sanitizeStylesheet('head{color:red}'))).toBe('css_reserved_selector');
    expect(failureCode(sanitizeStylesheet('style{color:red}'))).toBe('css_reserved_selector');
    expect(failureCode(sanitizeStylesheet('[data-he-layout]{color:red}'))).toBe('css_reserved_selector');
    expect(failureCode(sanitizeStylesheet('.he-scaler{color:red}'))).toBe('css_reserved_selector');
    expect(sanitizeStylesheet('p:active{color:red}').ok).toBe(true);
    expect(sanitizeStylesheet('p::placeholder{color:red}').ok).toBe(true);
    expect(failureCode(sanitizeStylesheet('@layer model{p{color:red}}'))).toBe('css_disallowed_at_rule');
    expect(failureCode(sanitizeStylesheet('@-webkit-keyframes fade{from{opacity:0}}'))).toBe('css_disallowed_at_rule');
    expect(failureCode(sanitizeStylesheet('@media (color){p{color:red}}'))).toBe('css_disallowed_at_rule');
    expect(failureCode(sanitizeStylesheet('@supports selector(p){p{color:red}}'))).toBe('css_disallowed_at_rule');
    expect(sanitizeStylesheet('@supports (display:grid){p{display:grid}}').ok).toBe(true);
  });
  it('scopes compound accounting independently for nested selector lists', () => {
    const nestedAtCap = `:is(${Array.from({ length: CSS_MAX_COMPOUND_DEPTH }, (_, index) => `.n${index}`).join('')})`;
    const nestedOverCap = `:is(${Array.from({ length: CSS_MAX_COMPOUND_DEPTH + 1 }, (_, index) => `.n${index}`).join('')})`;
    const outerOverCap = `${Array.from({ length: CSS_MAX_COMPOUND_DEPTH }, (_, index) => `.o${index}`).join('')}:where(.nested)`;
    expect(sanitizeStylesheet(`${nestedAtCap}{color:red}`).ok).toBe(true);
    expect(failureCode(sanitizeStylesheet(`${nestedOverCap}{color:red}`))).toBe('css_selector_too_deep');
    expect(failureCode(sanitizeStylesheet(`${outerOverCap}{color:red}`))).toBe('css_selector_too_deep');
    const nthAtCap = `:nth-child(1 of ${Array.from({ length: CSS_MAX_COMPOUND_DEPTH }, (_, index) => `.q${index}`).join('')})`;
    const nthOverCap = `:nth-child(1 of ${Array.from({ length: CSS_MAX_COMPOUND_DEPTH + 1 }, (_, index) => `.q${index}`).join('')})`;
    expect(sanitizeStylesheet(`${nthAtCap}{color:red}`).ok).toBe(true);
    expect(failureCode(sanitizeStylesheet(`${nthOverCap}{color:red}`))).toBe('css_selector_too_deep');
    expect(failureCode(sanitizeStylesheet(':nth-child(1 of [data-he-layout]){color:red}'))).toBe('css_reserved_selector');
  });

  it('allows content strings or none only', () => {
    expect(sanitizeDeclarationList('content:"a" "b"').ok).toBe(true);
    expect(sanitizeDeclarationList('content:none').ok).toBe(true);
    expect(failureCode(sanitizeDeclarationList('content:open-quote'))).toBe('css_content_not_allowed');
    expect(failureCode(sanitizeDeclarationList('content:normal'))).toBe('css_content_not_allowed');
    expect(failureCode(sanitizeDeclarationList('content:inherit'))).toBe('css_content_not_allowed');
    expect(failureCode(sanitizeDeclarationList('content:counter(item)'))).toBe('css_disallowed_function');
  });

  it('accepts every newly-required frozen function family', () => {
    const css = [
      'transform:translateX(1px) translateY(1px) translateZ(1px) translate3d(1px,2px,3px)',
      'transform:scaleX(1) scaleY(1) scaleZ(1) scale3d(1,1,1)',
      'transform:rotateX(1deg) rotateY(1deg) rotateZ(1deg) rotate3d(1,0,0,1deg) skewX(1deg) skewY(1deg) perspective(1px)',
      'background:conic-gradient(red,blue),repeating-conic-gradient(red,blue)',
      'filter:blur(1px) brightness(1) contrast(1) drop-shadow(0 0 1px black) grayscale(0) hue-rotate(0deg) invert(0) opacity(1) saturate(1) sepia(0)',
      'transition-timing-function:steps(2)',
    ].join(';');
    expect(sanitizeDeclarationList(css).ok).toBe(true);
  });

  it('namespaces keyframes and rewrites registered forward references deterministically', () => {
    const context = createCssSanitizeContext();
    expect(registerCssKeyframes(keyframes('fade'), context)).toEqual({ ok: true });
    expect(sanitizeDeclarationList('animation:fade 50ms', context)).toMatchObject({
      ok: true,
      css: 'animation:he-k0 50ms',
      ruleCount: 0,
      declarationCount: 1,
    });
    expect(sanitizeDeclarationList('animation-name:fade', context)).toMatchObject({
      ok: true,
      css: 'animation-name:he-k0',
      ruleCount: 0,
      declarationCount: 1,
    });
    expect(sanitizeStylesheet(keyframes('fade'), context)).toMatchObject({ ok: true, css: '@keyframes he-k0{from{opacity:0}to{opacity:1}}' });
    expect(failureCode(sanitizeDeclarationList('animation-name:linear', context))).toBe('css_unresolved_animation');
    expect(failureCode(sanitizeDeclarationList('animation:100ms linear linear', context))).toBe('css_unresolved_animation');
    expect(sanitizeDeclarationList('animation:none 100ms', context)).toMatchObject({ ok: true, css: 'animation:none 100ms' });
    expect(sanitizeDeclarationList('animation:100ms linear fade', context)).toMatchObject({ ok: true, css: 'animation:100ms linear he-k0' });
  });
  it('only registers keyframes with surviving frames', () => {
    const rejected = '.x{animation:fade 100ms}@keyframes fade{from{background:url(https://example.test/x)}}';
    const rejectedContext = createCssSanitizeContext();
    expect(registerCssKeyframes(rejected, rejectedContext)).toEqual({ ok: true });
    const rejectedResult = sanitizeStylesheet(rejected, rejectedContext);
    expect(rejectedResult).toMatchObject({ ok: true, css: '' });
    expect(rejectedResult.ok && rejectedResult.stripped.map((violation) => violation.code)).toContain('css_unresolved_animation');
    expect(JSON.stringify(rejectedResult)).not.toContain('he-k0');

    const accepted = '.x{animation:fade 100ms}@keyframes fade{from{opacity:0}to{opacity:1}}';
    const acceptedContext = createCssSanitizeContext();
    expect(registerCssKeyframes(accepted, acceptedContext)).toEqual({ ok: true });
    expect(sanitizeStylesheet(accepted, acceptedContext)).toMatchObject({
      ok: true,
      css: '[data-he-content] .x{animation:he-k0 100ms}@keyframes he-k0{from{opacity:0}to{opacity:1}}',
    });
  });

  it('rejects unresolved, duplicate, reserved, and ambiguous keyframe names', () => {
    expect(failureCode(sanitizeDeclarationList('animation:missing 50ms'))).toBe('css_unresolved_animation');
    const duplicate = createCssSanitizeContext();
    expect(sanitizeStylesheet(keyframes('fade'), duplicate).ok).toBe(true);
    expect(failureCode(sanitizeStylesheet(keyframes('fade'), duplicate))).toBe('css_duplicate_keyframes');
    expect(failureCode(sanitizeStylesheet(keyframes('he-spin')))).toBe('css_reserved_keyframes');
    const ambiguous = registerCssKeyframes(keyframes('linear'), createCssSanitizeContext());
    expect(ambiguous.ok ? '' : ambiguous.violations[0].code).toBe('css_reserved_keyframes');
    expect(failureCode(sanitizeStylesheet(keyframes('inherit')))).toBe('css_reserved_keyframes');
  });

  it('is deterministic', () => {
    const first = sanitizeStylesheet('p,h1{color:rgb(255,0,0);margin:1px 2px}');
    const second = sanitizeStylesheet('p,h1{color:rgb(255,0,0);margin:1px 2px}');
    expect(first).toEqual(second);
  });

  it('enforces stylesheet byte limits across a shared context', () => {
    const context = createCssSanitizeContext();
    expect(sanitizeDeclarationList(' '.repeat(CSS_MAX_STYLESHEET_BYTES), context).ok).toBe(true);
    expect(failureCode(sanitizeDeclarationList(' ', context))).toBe('css_too_large');
  });
  it('charges the aggregate byte budget for truncated surfaces', () => {
    const context = createCssSanitizeContext();
    const junk = '@'.repeat(CSS_MAX_STYLESHEET_BYTES + 1);
    const safeRule = 'p{color:red}';
    const safeSurface = `${' '.repeat(CSS_MAX_STYLESHEET_BYTES - Buffer.byteLength(safeRule, 'utf8'))}${safeRule}`;
    const truncated = sanitizeStylesheet(junk, context);
    const following = sanitizeStylesheet(safeSurface, context);

    expect(failureCode(truncated)).toBe('css_too_large');
    expect(failureCode(following)).toBe('css_too_large');
    expect(context.rawBytes).toBe(CSS_MAX_STYLESHEET_BYTES);
    expect(truncated.ok && following.ok ? Buffer.byteLength(`${truncated.css}${following.css}`, 'utf8') : 0)
      .toBeLessThanOrEqual(CSS_MAX_STYLESHEET_BYTES);
  });

  it('enforces a separate aggregate registration byte budget', () => {
    const context = createCssSanitizeContext();
    expect(registerCssKeyframes(' '.repeat(CSS_MAX_STYLESHEET_BYTES), context)).toEqual({ ok: true });
    const result = registerCssKeyframes(' ', context);
    expect(result.ok ? '' : result.violations[0].code).toBe('css_too_large');
    expect(context.rawBytes).toBe(0);
    expect(context.registrationBytes).toBe(CSS_MAX_STYLESHEET_BYTES + 1);
  });

  it('counts every qualified rule and at-rule against the aggregate cap', () => {
    const exact = 'p{}'.repeat(CSS_MAX_RULES);
    expect(sanitizeStylesheet(exact).ok).toBe(true);
    expect(failureCode(sanitizeStylesheet(`${exact}@media (width:1px){}`))).toBe('css_too_many_rules');
    const context = createCssSanitizeContext();
    expect(sanitizeStylesheet('p{}'.repeat(CSS_MAX_RULES - 1), context).ok).toBe(true);
    expect(failureCode(sanitizeStylesheet('@media (width:1px){}@supports (display:grid){}', context))).toBe('css_too_many_rules');
  });

  it('enforces nesting depth at and above the cap', () => {
    const nested = (count: number) => '@media (width:1px){'.repeat(count) + 'p{color:red}' + '}'.repeat(count);
    expect(sanitizeStylesheet(nested(CSS_MAX_NESTING_DEPTH)).ok).toBe(true);
    expect(failureCode(sanitizeStylesheet(nested(CSS_MAX_NESTING_DEPTH + 1)))).toBe('css_nesting_too_deep');
  });

  it('enforces keyframe definition and effective frame-selector caps', () => {
    const names = Array.from({ length: CSS_MAX_KEYFRAMES }, (_, index) => keyframes(`k${index}`)).join('');
    expect(sanitizeStylesheet(names).ok).toBe(true);
    expect(failureCode(sanitizeStylesheet(`${names}${keyframes('overflow')}`))).toBe('css_too_many_keyframes');
    const frames = Array.from({ length: CSS_MAX_FRAMES_PER_KEYFRAMES / 2 }, () => 'from,to{opacity:0}').join('');
    expect(sanitizeStylesheet(`@keyframes cap{${frames}}`).ok).toBe(true);
    expect(failureCode(sanitizeStylesheet(`@keyframes overflow{${frames}from,to{opacity:0}}`))).toBe('css_too_many_frames');
  });

  it('enforces selector, compound, and declaration-per-rule caps', () => {
    const selectors = Array.from({ length: CSS_MAX_SELECTORS_PER_RULE }, (_, index) => `.s${index}`).join(',');
    expect(sanitizeStylesheet(`${selectors}{color:red}`).ok).toBe(true);
    expect(failureCode(sanitizeStylesheet(`${selectors},.extra{color:red}`))).toBe('css_too_many_selectors');
    const compound = Array.from({ length: CSS_MAX_COMPOUND_DEPTH }, (_, index) => `.c${index}`).join('');
    expect(sanitizeStylesheet(`${compound}{color:red}`).ok).toBe(true);
    expect(failureCode(sanitizeStylesheet(`${compound}.extra{color:red}`))).toBe('css_selector_too_deep');
    const declarations = 'top:0;'.repeat(CSS_MAX_DECLARATIONS_PER_RULE);
    expect(sanitizeDeclarationList(declarations).ok).toBe(true);
    expect(failureCode(sanitizeDeclarationList(`${declarations}top:0`))).toBe('css_too_many_declarations_per_rule');
  });

  it('counts dropped declarations toward the shared total declaration cap', () => {
    const context = createCssSanitizeContext();
    const sixty = 'top:0;'.repeat(CSS_MAX_DECLARATIONS_PER_RULE);
    const fullCalls = Math.floor(CSS_MAX_DECLARATIONS / CSS_MAX_DECLARATIONS_PER_RULE);
    for (let index = 0; index < fullCalls; index++) expect(sanitizeDeclarationList(sixty, context).ok).toBe(true);
    const remainder = CSS_MAX_DECLARATIONS % CSS_MAX_DECLARATIONS_PER_RULE;
    if (remainder) expect(sanitizeDeclarationList('appearance:none;'.repeat(remainder), context).ok).toBe(true);
    expect(context.seenDeclarations).toBe(CSS_MAX_DECLARATIONS);
    expect(failureCode(sanitizeDeclarationList('appearance:none', context))).toBe('css_too_many_declarations');
  });

  it('enforces animation count and duration boundaries', () => {
    const context = createCssSanitizeContext();
    const definitions = Array.from({ length: CSS_MAX_ANIMATIONS_PER_ELEMENT }, (_, index) => keyframes(`a${index}`)).join('');
    expect(registerCssKeyframes(definitions, context)).toEqual({ ok: true });
    const animations = Array.from({ length: CSS_MAX_ANIMATIONS_PER_ELEMENT }, (_, index) => `a${index} ${CSS_MIN_ANIMATION_DURATION_MS}ms`).join(',');
    expect(sanitizeDeclarationList(`animation:${animations}`, context).ok).toBe(true);
    expect(failureCode(sanitizeDeclarationList(`animation:${animations},a0 ${CSS_MIN_ANIMATION_DURATION_MS}ms`, context))).toBe('css_too_many_animations');
    expect(failureCode(sanitizeDeclarationList(`animation-duration:${CSS_MIN_ANIMATION_DURATION_MS - 1}ms`))).toBe('css_animation_duration_too_short');
  });

  it('enforces z-index, safe font-size, fixed/sticky, and value-token bounds', () => {
    expect(sanitizeDeclarationList(`z-index:${CSS_MIN_Z_INDEX}`).ok).toBe(true);
    expect(sanitizeDeclarationList(`z-index:${CSS_MAX_Z_INDEX}`).ok).toBe(true);
    expect(failureCode(sanitizeDeclarationList(`z-index:${CSS_MIN_Z_INDEX - 1}`))).toBe('css_z_index_out_of_range');
    expect(failureCode(sanitizeDeclarationList(`z-index:${CSS_MAX_Z_INDEX + 1}`))).toBe('css_z_index_out_of_range');
    expect(sanitizeDeclarationList('font-size:0').ok).toBe(true);
    expect(sanitizeDeclarationList(`font-size:${CSS_MAX_FONT_SIZE_PX}px`).ok).toBe(true);
    expect(failureCode(sanitizeDeclarationList(`font-size:${CSS_MAX_FONT_SIZE_PX + 1}px`))).toBe('css_font_size_too_large');
    expect(sanitizeDeclarationList('font-size:1em')).toMatchObject({ ok: true });
    expect(sanitizeDeclarationList('font-size:1rem')).toMatchObject({ ok: true });
    expect(sanitizeDeclarationList('font-size:50%')).toMatchObject({ ok: true });
    expect(sanitizeDeclarationList(`font:italic ${CSS_MAX_FONT_SIZE_PX}px serif`).ok).toBe(true);
    expect(failureCode(sanitizeDeclarationList(`font:${CSS_MAX_FONT_SIZE_PX + 1}px serif`))).toBe('css_font_size_too_large');
    expect(sanitizeDeclarationList('font:1em serif')).toMatchObject({ ok: true });
    expect(sanitizeDeclarationList('font:50% serif')).toMatchObject({ ok: true });
    expect(failureCode(sanitizeDeclarationList('font:inherit'))).toBe('css_font_size_not_allowed');
    expect(sanitizeDeclarationList('position:fixed').ok).toBe(true);
    expect(sanitizeDeclarationList('position:sticky').ok).toBe(true);
    expect(sanitizeDeclarationList(`font-family:${'a'.repeat(CSS_MAX_VALUE_TOKEN_LENGTH)}`).ok).toBe(true);
    expect(failureCode(sanitizeDeclarationList(`font-family:${'a'.repeat(CSS_MAX_VALUE_TOKEN_LENGTH + 1)}`))).toBe('css_value_token_too_long');
  });
  it('reports unexpected runtime failures as css_internal without throwing', () => {
    expect(() => sanitizeDeclarationList('color:red', null as never)).not.toThrow();
    expect(failureCode(sanitizeDeclarationList('color:red', null as never))).toBe('css_internal');
  });

  it('returns parse diagnostics without throwing', () => {
    expect(() => sanitizeStylesheet('p{color:red}}')).not.toThrow();
    expect(failureCode(sanitizeStylesheet('p{color:red}}'))).toBe('css_parse_error');
  });
});
describe('global selector rewrite', () => {
  it('scopes exact universal selectors under the content root', () => {
    const result = sanitizeStylesheet('*{box-sizing:border-box}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.css).toContain('[data-he-content] *');
  });

  it('rewrites html/body selector lists to the content root without double-scoping', () => {
    const result = sanitizeStylesheet('html,body{margin:0}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.css).toContain('[data-he-content]');
    expect(result.css).not.toContain('[data-he-content] body');
    expect(result.css).not.toContain('[data-he-content] html');
  });

  it('accepts body rules with layout properties intact', () => {
    const result = sanitizeStylesheet('body{background:#fff}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.css).toBe('[data-he-content]{background:#fff}');
  });

  it('accepts themed custom-property declarations without failing the stylesheet', () => {
    const result = sanitizeStylesheet('[data-theme="dark"]{--brand:#4f46e5}');
    expect(result.ok).toBe(true);
  });

  it('rewrites compound global-root selectors without doubled content-root prefixes', () => {
    const result = sanitizeStylesheet('body>.card{color:red}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.css).not.toContain('[data-he-content] [data-he-content]');
    expect(result.css).toContain('[data-he-content]>.card');
  });

  it('rejects model-authored content-root forgery as reserved', () => {
    expect(failureCode(sanitizeStylesheet('[data-he-content] .x{color:red}'))).toBe(CSS_VIOLATION_CODES.reservedSelector);
  });

  it('is deterministic for rewritten global selectors', () => {
    const input = 'html,body{margin:0}*{box-sizing:border-box}body>.card{color:red}';
    const first = sanitizeStylesheet(input);
    const second = sanitizeStylesheet(input);
    expect(first).toEqual(second);
  });

  it('rejects root-led sibling combinators that would escape the content root', () => {
    expect(failureCode(sanitizeStylesheet('body+*{color:red}'))).toBe(CSS_VIOLATION_CODES.disallowedSelector);
    expect(failureCode(sanitizeStylesheet('body~.x{color:red}'))).toBe(CSS_VIOLATION_CODES.disallowedSelector);
  });

  it('rejects the functional :root(...) pseudo (laundering guard)', () => {
    expect(failureCode(sanitizeStylesheet(':root([data-he-content]){color:red}'))).toBe(
      CSS_VIOLATION_CODES.disallowedSelector,
    );
  });

  it('rejects escaped reserved identifiers (canonicalized before the reserved check)', () => {
    // `\\64 ` is the CSS hex escape for `d`, so this decodes to `.data-he-content`.
    expect(failureCode(sanitizeStylesheet('.\\64 ata-he-content{color:red}'))).toBe(
      CSS_VIOLATION_CODES.reservedSelector,
    );
    expect(failureCode(sanitizeStylesheet('[class=\\64 ata-he-content]{color:red}'))).toBe(
      CSS_VIOLATION_CODES.reservedSelector,
    );
  });

  it('rejects global roots outside the leading position (non-leading / repeated / nested)', () => {
    expect(failureCode(sanitizeStylesheet('.x:root{color:red}'))).toBe(CSS_VIOLATION_CODES.disallowedSelector);
    expect(failureCode(sanitizeStylesheet('html body{margin:0}'))).toBe(CSS_VIOLATION_CODES.disallowedSelector);
  });

  it('keeps rejecting nesting selectors', () => {
    expect(failureCode(sanitizeStylesheet('&{color:red}'))).toBe(CSS_VIOLATION_CODES.disallowedSelector);
  });

  it('emits exact bytes for accepted leading-root shapes', () => {
    const r = sanitizeStylesheet('body.dark>.card{color:red}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.css).toBe('[data-he-content].dark>.card{color:red}');
  });

  it('canonicalizes CRLF-terminated hex escapes before the reserved check', () => {
    // css-tree/browsers consume `\\r\\n` as one escape terminator, so both decode to
    // `.data-he-content` / class value `data-he-content`.
    expect(failureCode(sanitizeStylesheet('.\\64\r\nata-he-content{color:red}'))).toBe(
      CSS_VIOLATION_CODES.reservedSelector,
    );
    expect(failureCode(sanitizeStylesheet('[class=\\64\r\nata-he-content]{color:red}'))).toBe(
      CSS_VIOLATION_CODES.reservedSelector,
    );
  });

  it('rejects global roots hidden in :nth-child(... of S) selector fields', () => {
    expect(failureCode(sanitizeStylesheet(':nth-child(1 of body){color:red}'))).toBe(
      CSS_VIOLATION_CODES.disallowedSelector,
    );
    expect(failureCode(sanitizeStylesheet('body:nth-child(1 of :root){color:red}'))).toBe(
      CSS_VIOLATION_CODES.disallowedSelector,
    );
  });
});
  it('compounds leading theme selectors with the content root', () => {
    const result = sanitizeStylesheet('[data-theme="dark"]{--bg:#111}:root[data-theme="light"]{--bg:#fff}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.css).toContain('[data-he-content][data-theme="dark"]{--bg:#111}');
    expect(result.css).toContain('[data-he-content][data-theme="light"]{--bg:#fff}');
  });
