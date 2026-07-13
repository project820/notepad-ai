/**
 * Condensed design-planning guidance, independently restated for content-model
 * generation. It deliberately contains no vendored StyleGallery CSS or prose.
 *
 * Sources consulted (ideas only; no text/CSS copied):
 * - https://github.com/changeroa/StyleGallery/blob/main/guides/webpage-generation-workflow.md
 * - https://github.com/changeroa/StyleGallery/blob/main/guides/decision-tree.md
 * - https://github.com/changeroa/StyleGallery/blob/main/guides/layout-brief.md
 * - https://github.com/changeroa/StyleGallery/blob/main/patterns/index.md
 * - https://github.com/changeroa/StyleGallery/blob/main/recipes/index.md
 */
export const HTML_EXPORT_DESIGN_KNOWLEDGE = `CONTENT DESIGN GUIDE:
1. Classify the screen by its reader task before arranging content: narrative/marketing, report/dashboard, article/reference, form-like instruction, or command-oriented material. Turn supplied blocks into jobs such as introduce, explain, substantiate, compare, decide, orient, or retain. Select the section sequence for that task, not for a fashionable visual style.
2. Start with meaning: preserve reading order and make titles, prose, lists, tables, quotations, code, and data distinct. Give repeated evidence comparable sections; keep supporting context adjacent to the claim it explains. Do not let decoration or a visual grouping obscure priority, source order, or keyboard reading order.
3. After classification, name the layout problem—reading flow, repetition, comparison, or primary/supporting context—then choose blocks and grouping to answer it. Linear explanation needs a restrained flow; repeated facts need parallel items; comparison needs a table or chart. Reject grouping that weakens comprehension, order, or content resilience.
4. Name scroll ownership before composing content. SCROLL has one top-to-bottom document and must not imply sideways or nested scrolling. SLIDES require independently understandable, low-density sections that the engine can paginate. Never invent fixed, sticky, overlay, or scrollable regions in the content model; the deterministic renderer owns those behaviors.
5. Keep sections adaptable to their available container. Prefer concise labels and intrinsic grouping over assumptions about a wide viewport or a fixed column count. Make long names, dense data, empty optional material, and long prose survivable; retain a table when a chart would hide necessary detail.
6. Before finalizing, check that the section order follows the reader's decision path, important material has more emphasis than supporting material, and the chosen blocks still fit the selected layout. Output only content structure; never encode CSS, HTML, dimensions, color, position, or brand treatment.`;
