/**
 * Quality dial (F6) — five levels mapped to ChatGPT Canvas-style "reading level".
 * Injected into every AI system prompt to match the chosen sophistication.
 */

export type Quality = 'elementary' | 'highschool' | 'college' | 'professor' | 'professional';

export const QUALITY_ORDER: Quality[] = [
  'elementary',
  'highschool',
  'college',
  'professor',
  'professional',
];


/**
 * Returns a system-prompt-ready directive describing the target reading level.
 * Empty string for the default (college) — assistants behave naturally at that level.
 */
export function qualityDirective(q: Quality): string {
  switch (q) {
    case 'elementary':
      return 'Write at an elementary-school reading level: very short sentences, common words, concrete examples, no jargon, friendly tone.';
    case 'highschool':
      return 'Write at a high-school reading level: clear sentences, define any technical term, conversational but informative tone.';
    case 'college':
      return 'Write at a college reading level: precise sentences, allow domain vocabulary with brief context, neutral professional tone.';
    case 'professor':
      return 'Write at an academic/professor reading level: dense, precise, use domain vocabulary freely, allow nuance and qualifications.';
    case 'professional':
      return 'Write at a senior-practitioner reading level: terse, opinionated, assume the reader is fluent in the domain, prefer specifics over qualifiers.';
  }
}
