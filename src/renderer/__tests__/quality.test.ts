import { describe, expect, it } from 'vitest';
import { qualityDirective, type Quality } from '../quality';

const directives: Record<Quality, string> = {
  elementary: 'Write at an elementary-school reading level: very short sentences, common words, concrete examples, no jargon, friendly tone.',
  highschool: 'Write at a high-school reading level: clear sentences, define any technical term, conversational but informative tone.',
  college: 'Write at a college reading level: precise sentences, allow domain vocabulary with brief context, neutral professional tone.',
  professor: 'Write at an academic/professor reading level: dense, precise, use domain vocabulary freely, allow nuance and qualifications.',
  professional: 'Write at a senior-practitioner reading level: terse, opinionated, assume the reader is fluent in the domain, prefer specifics over qualifiers.',
};

describe('qualityDirective', () => {
  it.each(Object.entries(directives) as [Quality, string][])('returns the prompt directive for %s', (quality, directive) => {
    expect(qualityDirective(quality)).toBe(directive);
  });
});
