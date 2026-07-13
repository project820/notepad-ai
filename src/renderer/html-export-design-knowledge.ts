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
1. Classify the screen by reader task: narrative/marketing, report/dashboard, article/reference, instruction, or command. Turn supplied material into jobs—introduce, explain, substantiate, compare, decide, orient, retain—and sequence sections for that job, not fashion.
2. Preserve reading order and distinguish titles, prose, lists, tables, quotations, code, and data. Keep evidence adjacent to its claim; do not let grouping obscure priority, source order, or keyboard reading order.
3. Name the layout problem—flow, repetition, comparison, or primary/supporting context—then choose blocks that solve it. Use restrained flow for explanation, parallel items for repeated facts, and tables or charts for comparison.
4. Treat design.md as an editorial system: reflect its mood through hierarchy. Use kickers and decisive headings for editorial structure, cards for repeated evidence, and callouts only for genuinely exceptional material. Do not turn every paragraph into a card.
5. SCROLL is one top-to-bottom document: no sideways or nested scrolling, with a readable lead and predictable sections. SLIDES need independently understandable, low-density sections with one primary claim; the engine paginates. Never invent fixed, sticky, overlay, or scrollable regions.
6. Keep sections adaptable to their available container. Prefer concise labels and intrinsic grouping; make long names, dense data, empty optional material, and long prose survivable. Retain a table when a chart loses fidelity.
7. Before finalizing, check decision-path order, emphasis, and layout fit. Output only content structure; never encode CSS, HTML, dimensions, color, position, or brand treatment.`;
