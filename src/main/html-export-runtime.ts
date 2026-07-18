import { sha256Base64 } from '../shared/sha256';

export type HtmlExportRuntimeMode = 'scroll' | 'slide';

const HTML_EXPORT_INTERACTIVE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";
const HTML_EXPORT_INTERACTIVE_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${HTML_EXPORT_INTERACTIVE_CSP}">`;

function runtimeSource(mode: HtmlExportRuntimeMode): string {
  const slide = mode === 'slide' ? 'true' : 'false';
  return `(function(){var root=document.documentElement,content=document.querySelector('[data-he-content]');if(root.dataset.naiRuntime)return;root.dataset.naiRuntime='true';var button=document.createElement('button'),style=document.createElement('style');button.id='nai-runtime-toggle';button.type='button';button.className='nai-theme-toggle';button.style.cssText='position:fixed;top:12px;right:12px;z-index:2147483647;border:0;border-radius:999px;padding:8px 10px;cursor:pointer;background:#111;color:#fff';function setTheme(theme){root.dataset.theme=theme;if(content)content.dataset.theme=theme;try{localStorage.setItem('nai-theme',theme)}catch(_e){}button.textContent=theme==='dark'?'☀':'🌙';button.setAttribute('aria-label',theme==='dark'?'Switch to light theme':'Switch to dark theme')}var saved;try{saved=localStorage.getItem('nai-theme')}catch(_e){}setTheme(saved==='light'||saved==='dark'?saved:(matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'));button.addEventListener('click',function(){setTheme(root.dataset.theme==='dark'?'light':'dark')});document.body.appendChild(button);function hasAuthoredTheme(rule){if(rule.cssRules&&rule.cssRules.length)return Array.prototype.some.call(rule.cssRules,hasAuthoredTheme);if(!rule.selectorText||rule.selectorText.indexOf('data-he-content')===-1||!/\\[\\s*data-theme\\s*(?:[~|^$*]?=|\\])/i.test(rule.selectorText)||!Array.prototype.some.call(rule.style||[],function(name){return String(name).indexOf('--')===0}))return false;var theme=content.dataset.theme;var matches=['light','dark'].some(function(value){content.dataset.theme=value;return content.matches(rule.selectorText)});content.dataset.theme=theme;return matches}var authored=content&&Array.prototype.some.call(document.styleSheets,function(sheet){try{return Array.prototype.some.call(sheet.cssRules||[],hasAuthoredTheme)}catch(_e){return false}});if(!authored){style.id='nai-theme-fallback';style.textContent='[data-he-content][data-theme="dark"]{filter:invert(1) hue-rotate(180deg)}[data-he-content][data-theme="dark"] img,[data-he-content][data-theme="dark"] video{filter:invert(1) hue-rotate(180deg)}';document.head.appendChild(style)}if(${slide}){var slides=Array.prototype.slice.call(document.querySelectorAll('section.slide'));if(!slides.length){slides=Array.prototype.slice.call((content||document.body).children).filter(function(node){return node.tagName==='SECTION'})}if(!slides.length)return;var index=0,controls=document.createElement('div'),previous=document.createElement('button'),next=document.createElement('button'),indicator=document.createElement('span');controls.className='nai-slide-nav';controls.style.cssText='position:fixed;bottom:12px;right:12px;z-index:2147483647;display:flex;gap:8px;align-items:center;background:#111;color:#fff;padding:8px;border-radius:999px';previous.type=next.type='button';previous.textContent='‹';next.textContent='›';function show(n){index=(n+slides.length)%slides.length;slides.forEach(function(s,i){s.style.display=i===index?'':'none';s.style.minHeight='100vh'});indicator.textContent=(index+1)+'/'+slides.length;slides[index].scrollIntoView({block:'start'})}previous.addEventListener('click',function(){show(index-1)});next.addEventListener('click',function(){show(index+1)});controls.append(previous,indicator,next);document.body.appendChild(controls);document.addEventListener('keydown',function(event){var target=event.target;if(target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement||target instanceof HTMLButtonElement||target instanceof HTMLSelectElement||target&&target.tagName==='SUMMARY'||target&&target instanceof Element&&target.closest('[contenteditable]'))return;if(['ArrowRight','PageDown',' '].includes(event.key)){event.preventDefault();show(index+1)}else if(['ArrowLeft','PageUp'].includes(event.key)){event.preventDefault();show(index-1)}});show(0)}})();`;
}

export function htmlExportRuntimeSha256(mode: HtmlExportRuntimeMode = 'scroll'): string {
  return sha256Base64(runtimeSource(mode));
}

/** Adds or replaces the app-owned runtime after sanitization. */
export function injectHtmlExportRuntime(html: string, mode: HtmlExportRuntimeMode = 'scroll'): string {
  let output = html.replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>\s*/gi, '');
  output = /<\/head\s*>/i.test(output)
    ? output.replace(/<\/head\s*>/i, `${HTML_EXPORT_INTERACTIVE_CSP_META}</head>`)
    : `${HTML_EXPORT_INTERACTIVE_CSP_META}${output}`;
  const script = `<script id="nai-runtime">${runtimeSource(mode)}</script>`;
  output = /<script\s+id=["']nai-runtime["'][^>]*>[\s\S]*?<\/script\s*>/i.test(output)
    ? output.replace(/<script\s+id=["']nai-runtime["'][^>]*>[\s\S]*?<\/script\s*>/i, script)
    : /<\/body\s*>/i.test(output) ? output.replace(/<\/body\s*>/i, `${script}</body>`) : `${output}${script}`;
  const manifestScript = /(<script\b(?=[^>]*\bid=["']he-manifest["'])[^>]*>)([\s\S]*?)(<\/script\s*>)/i;
  return output.replace(manifestScript, (_match, open, manifest, close) => {
    const patchedManifest = manifest.replace(
      /("runtimeSha256"\s*:\s*")[^"]*(")/,
      `$1${htmlExportRuntimeSha256(mode)}$2`,
    );
    return `${open}${patchedManifest}${close}`;
  });
}
