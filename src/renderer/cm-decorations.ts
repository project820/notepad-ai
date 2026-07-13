import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder } from '@codemirror/state';

/**
 * Obsidian-flavored "live preview" decorations for source editing.
 * - Heading lines get bigger font + bold
 * - Inline strong/emphasis/code get visual emphasis
 * - Task markers `- [ ]` / `- [x]` become real clickable checkboxes
 */

const markdownHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.7em', fontWeight: '700', color: 'var(--color-ink)' },
  { tag: t.heading2, fontSize: '1.45em', fontWeight: '700', color: 'var(--color-ink)' },
  { tag: t.heading3, fontSize: '1.25em', fontWeight: '700', color: 'var(--color-ink)' },
  { tag: t.heading4, fontSize: '1.1em', fontWeight: '600', color: 'var(--color-ink)' },
  { tag: t.heading5, fontSize: '1.05em', fontWeight: '600', color: 'var(--color-ink)' },
  { tag: t.heading6, fontWeight: '600', color: 'var(--color-ink)' },
  { tag: t.strong, fontWeight: '700', color: 'var(--color-ink)' },
  { tag: t.emphasis, fontStyle: 'italic', color: 'var(--color-ink)' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--color-charcoal)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)', color: 'var(--color-primary)' },
  { tag: t.link, color: 'var(--color-link)' },
  { tag: t.url, color: 'var(--color-mute)', textDecoration: 'underline' },
  { tag: t.quote, color: 'var(--color-charcoal)', fontStyle: 'italic' },
  { tag: t.list, color: 'var(--color-mute)' },
  { tag: t.meta, color: 'var(--color-mute)' },
  // Code blocks rendered inside the editor — keep readable, not muted.
  { tag: t.content, color: 'var(--color-ink)' },
]);

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly from: number, readonly to: number) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.from === this.from;
  }
  toDOM() {
    const wrap = document.createElement('span');
    wrap.className = 'cm-task-checkbox';
    wrap.setAttribute('aria-hidden', 'false');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this.checked;
    input.tabIndex = -1;
    wrap.appendChild(input);
    return wrap;
  }
  ignoreEvent(event: Event) {
    // Let CodeMirror place a caret for every non-input pointer target in the
    // replacement widget. The plugin intercepts only the checkbox input below.
    return event.type !== 'mousedown' && event.type !== 'click';
  }

}

function buildTaskDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    // match the "[ ]" or "[x]" marker that appears in task list items: e.g. "- [ ]" or "* [x]"
    const re = /(^|[\n])[\t ]*[-*+] (\[[ xX]\])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      // index of "[" in absolute doc coords
      const markerStart = from + m.index + m[0].length - 3; // we want to replace 3 chars: "[", " "|"x", "]"
      const markerEnd = markerStart + 3;
      const checked = /\[[xX]\]/.test(m[2]);
      builder.add(
        markerStart,
        markerEnd,
        Decoration.replace({
          widget: new CheckboxWidget(checked, markerStart, markerEnd),
        }),
      );
    }
  }
  return builder.finish();
}

const taskCheckboxPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildTaskDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildTaskDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousedown(event, view) {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') return false;
        const wrap = target.closest('.cm-task-checkbox') as HTMLElement | null;
        if (!wrap) return false;
        const pos = view.posAtDOM(wrap, 0);
        // The widget replaces exactly the three-character task marker.
        const slice = view.state.doc.sliceString(pos, pos + 3);
        if (!/\[[ xX]\]/.test(slice)) return false;
        event.preventDefault();
        const checked = /\[[xX]\]/.test(slice);
        view.dispatch({
          changes: { from: pos, to: pos + 3, insert: checked ? '[ ]' : '[x]' },
        });
        return true;
      },
    },
  },
);

export const markdownLiveDecorations = [
  syntaxHighlighting(markdownHighlight),
  taskCheckboxPlugin,
];

// Silence unused-import warning if needed
void syntaxTree;
