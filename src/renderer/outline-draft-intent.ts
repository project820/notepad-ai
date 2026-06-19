/**
 * outline-draft-intent.ts
 *
 * Pure intent-detection function for the Outline→Draft agentic workflow.
 *
 * Given a Side Chat message string, classifies whether the user is expressing
 * an intent to start the Outline→Draft workflow — i.e. asking the AI to write
 * body content for each section of the current document's heading outline.
 *
 * Design constraints (from Seed v1.1):
 *  - PURE function: no imports from UI modules, no DOM, no window, no side effects.
 *  - Returns a structured result with both a boolean flag and a 0–1 confidence score
 *    so callers can apply their own threshold or show explanatory UI.
 *  - Independently disable-able: callers guard calls behind the
 *    `outlineDraftEnabled` feature-toggle preference — this file itself has no
 *    awareness of that toggle.
 *  - Bilingual (English + Korean) — the target user base writes in both languages.
 *  - Conservative: benign editorial questions must NOT trigger the workflow.
 *    False-positives are more harmful than false-negatives here because the
 *    workflow mutates the document; when in doubt, return isOutlineDraft=false.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OutlineDraftIntentResult {
  /** True when confidence ≥ CONFIDENCE_THRESHOLD */
  isOutlineDraft: boolean;
  /** Normalised score in [0, 1]. Values ≥ 0.6 trigger isOutlineDraft=true. */
  confidence: number;
  /**
   * Human-readable labels of the pattern groups that contributed to the score.
   * Useful for transparency UI ("AI detected: draft intent + section scope").
   */
  signals: string[];
}

// ---------------------------------------------------------------------------
// Threshold
// ---------------------------------------------------------------------------

/**
 * Confidence must reach this level for isOutlineDraft to be true.
 * Kept intentionally high (0.6) to minimise false-positives.
 */
export const CONFIDENCE_THRESHOLD = 0.6;

// ---------------------------------------------------------------------------
// Pattern groups
// ---------------------------------------------------------------------------

/**
 * Each group has a weight (its contribution to the total score when ANY
 * pattern in the group matches) and a label (used in signals[]).
 *
 * Score accumulates additively across groups; it is clamped to 1.0.
 *
 * Group weights are tuned so that:
 *   - A single "EXACT_TRIGGER" phrase alone exceeds the threshold.
 *   - A "DRAFT_VERB" alone does NOT (editing requests also use draft verbs).
 *   - "DRAFT_VERB" + "SECTION_SCOPE" exceeds the threshold.
 *   - "DRAFT_VERB" + "OUTLINE_REF" exceeds the threshold.
 *   - "DRAFT_VERB" alone is below threshold (prevents false-positives on
 *     "draft the introduction" or "write this sentence better").
 */
interface PatternGroup {
  label: string;
  weight: number;
  patterns: RegExp[];
}

const PATTERN_GROUPS: PatternGroup[] = [
  // -------------------------------------------------------------------------
  // Group 1 — Exact trigger phrases (either language)
  // These alone are sufficient to reach the threshold.
  // -------------------------------------------------------------------------
  {
    label: 'exact_trigger',
    weight: 0.9,
    patterns: [
      // English exact triggers
      /\boutline\s*(?:to|-?>\s*|→\s*)draft\b/i,
      /\bdraft\s+(?:each|every|all\s+the?)\s+section/i,
      /\bwrite\s+(?:each|every|all\s+the?)\s+section/i,
      /\bfill\s+(?:in|out)\s+(?:(?:each|every|all|the)\s+)*sections?/i,
      /\bgenerate\s+(?:content\s+for\s+(?:each|every|all\s+the?)\s+section|the\s+(?:full\s+)?draft)/i,
      /\bexpand\s+(?:the\s+)?outline\s+into\b/i,
      /\bturn\s+(?:this\s+)?outline\s+into\b/i,
      /\bwrite\s+(?:the\s+)?(?:full\s+)?(?:document|doc)\s+(?:based\s+on|from)\s+(?:this\s+)?outline/i,
      /\bdraft\s+(?:the\s+)?(?:full\s+)?document\s+(?:based\s+on|from)\s+(?:this\s+)?outline/i,
      /\bwrite\s+content\s+for\s+(?:each|every|all\s+the?)\s+(?:heading|section|part)/i,
      /\bfill\s+in\s+(?:the\s+)?(?:body|content|sections?)\s+(?:for|of)\s+(?:each|every)/i,
      /\bgenerate\s+(?:section|draft)\s+by\s+section\b/i,
      /\bwrite\s+(?:each|every)\s+(?:heading|part|chapter)/i,

      // Korean exact triggers
      // "각 섹션 작성" / "각 항목 작성" — write each section/item
      /각\s*(?:섹션|항목|장|절|부분)\s*(?:을|를)?\s*(?:작성|써|적어|써줘|작성해)/,
      // "아웃라인대로 써줘" — write according to the outline
      /아웃라인\s*(?:에\s*맞게|대로|을|를)?\s*(?:작성|써|적어|초안)/,
      // "개요대로 써줘" — write according to the outline (개요 = outline/overview)
      /개요\s*(?:에\s*맞게|대로|를|을)?\s*(?:작성|써|적어|초안)/,
      // "초안을 써줘 / 초안 작성해줘" — write the draft
      /(?:전체\s*)?(?:문서|글)\s*(?:의)?\s*초안\s*(?:을|를)?\s*(?:작성|써|적어|써줘)/,
      // "섹션별로 작성" — draft section by section
      /섹션\s*별\s*(?:로)?\s*(?:작성|써|초안)/,
      // "내용 채워줘 / 본문 채워줘" — fill in the content/body
      /(?:내용|본문)\s*(?:을|를)?\s*(?:채워|작성해|써줘|적어줘)/,
      // "각 헤딩 / 각 제목에 맞게 작성"
      /각\s*(?:헤딩|제목|소제목)\s*(?:에\s*맞게|대로|별로)?\s*(?:작성|써|초안)/,
      // "전체 초안 작성" — write the full draft
      /전체\s*초안\s*(?:을|를)?\s*(?:작성|써|적어)/,
    ],
  },

  // -------------------------------------------------------------------------
  // Group 2 — Draft/write action verbs (English)
  // Alone these are NOT sufficient (editing tools also use "write/draft").
  // They push the score towards threshold when combined with Group 3 or 4.
  // -------------------------------------------------------------------------
  {
    label: 'draft_verb_en',
    weight: 0.35,
    patterns: [
      /\b(?:draft|write\s+up|compose|author)\b/i,
      /\bfill\s+(?:in|out)\b/i,
    ],
  },

  // -------------------------------------------------------------------------
  // Group 3 — Section/outline scope references (English)
  // Signals that the user is talking about the whole document structure.
  // -------------------------------------------------------------------------
  {
    label: 'section_scope_en',
    weight: 0.35,
    patterns: [
      /\b(?:each|every|all)\s+(?:of\s+the\s+)?sections?\b/i,
      /\b(?:the\s+)?sections?\s+(?:of\s+the\s+)?(?:document|doc|outline)\b/i,
      /\boutline\b/i,
      /\bheadings?\b/i,
      /\bsection[\s-]by[\s-]section\b/i,
      /\beach\s+part\b/i,
    ],
  },

  // -------------------------------------------------------------------------
  // Group 4 — Outline/document reference as object (English)
  // Catches "write the document based on this outline", "draft from outline".
  // -------------------------------------------------------------------------
  {
    label: 'outline_ref_en',
    weight: 0.3,
    patterns: [
      /\b(?:based\s+on|from|using|following)\s+(?:this\s+|the\s+)?outline\b/i,
      /\baccording\s+to\s+(?:this\s+|the\s+)?outline\b/i,
      /\busing\s+(?:this\s+|the\s+)?structure\b/i,
      /\bexpand\s+(?:this|the)\b/i,
      /\bthe\s+(?:full\s+)?document\b/i,
    ],
  },

  // -------------------------------------------------------------------------
  // Group 5 — Korean draft verbs
  // -------------------------------------------------------------------------
  {
    label: 'draft_verb_ko',
    weight: 0.35,
    patterns: [
      // 작성해줘 / 써줘 / 적어줘 / 초안 작성
      /(?:작성|써|적어|초안\s*작성)\s*(?:해줘|해주세요|주세요|주길)/,
      /\b초안\b/,
    ],
  },

  // -------------------------------------------------------------------------
  // Group 6 — Korean section/outline scope references
  // -------------------------------------------------------------------------
  {
    label: 'section_scope_ko',
    weight: 0.35,
    patterns: [
      /각\s*(?:섹션|항목|장|절|부분|헤딩|제목)/,
      /섹션\s*별/,
      /(?:전체|모든)\s*(?:섹션|항목|내용)/,
      /문서\s*(?:전체|구조|개요)/,
    ],
  },
];

// ---------------------------------------------------------------------------
// Negation guards
// ---------------------------------------------------------------------------

/**
 * If ANY negation pattern matches, we halve the accumulated score.
 * This handles phrases like "don't draft yet", "not asking you to write the
 * full document", "should I draft each section myself?".
 *
 * We use halving rather than zeroing because a negated request can still
 * carry secondary signals useful to downstream logic.
 */
const NEGATION_PATTERNS: RegExp[] = [
  /\b(?:don'?t|do\s+not|shouldn'?t|should\s+not|won'?t|will\s+not|can'?t|cannot)\b/i,
  /\bnot\s+(?:yet|now|asking|ready)\b/i,
  // Korean negation
  /(?:하지\s*마|하지\s*말|안\s*해도|필요\s*없어|아직)/,
];

/**
 * Pure editorial / advisory phrases that strongly indicate the user is NOT
 * requesting drafting but rather asking for advice. These zero the score.
 */
const ADVISORY_OVERRIDE_PATTERNS: RegExp[] = [
  /\b(?:how\s+should\s+I|what\s+do\s+you\s+think|any\s+(?:suggestions?|advice|tips?|ideas?)|should\s+I\s+(?:add|include|change|use))\b/i,
  /\b(?:review|proofread|check|evaluate|assess|critique|feedback)\b/i,
  /\b(?:improve|fix|correct|refine|polish|edit)\s+(?:this|the|my)\b/i,
  /\b(?:is\s+(?:this|it)\s+(?:good|ok|okay|correct|clear|right))\b/i,
  /\bhelp\s+me\s+(?:understand|think|figure|decide|plan)\b/i,
  // "myself" / "on my own" — user explicitly says they will do the writing themselves
  /\b(?:myself|yourself|on\s+my\s+own)\b/i,
  // "내가 직접" — Korean "I'll do it myself"
  /내가\s*직접/,
  // Korean advisory
  /(?:어떻게\s*생각|의견\s*주세요|피드백|어떤\s*게\s*좋을|어떤\s*거\s*넣을|수정해줘|고쳐줘|검토해)/,
];

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Detects whether a Side Chat message expresses an Outline→Draft trigger intent.
 *
 * @param message - Raw user message string from Side Chat input.
 * @returns Structured detection result with boolean flag, confidence, and signals.
 *
 * @example
 * detectOutlineDraftIntent("Please draft each section based on the outline")
 * // → { isOutlineDraft: true, confidence: 0.9, signals: ['exact_trigger'] }
 *
 * @example
 * detectOutlineDraftIntent("What do you think about the structure?")
 * // → { isOutlineDraft: false, confidence: 0, signals: [] }
 */
export function detectOutlineDraftIntent(message: string): OutlineDraftIntentResult {
  if (!message || typeof message !== 'string') {
    return { isOutlineDraft: false, confidence: 0, signals: [] };
  }

  const normalised = message.trim();
  if (normalised.length === 0) {
    return { isOutlineDraft: false, confidence: 0, signals: [] };
  }

  // ── Phase 0: Advisory override — if user is clearly asking for advice/review,
  //    short-circuit immediately regardless of any drafting vocabulary.
  for (const pat of ADVISORY_OVERRIDE_PATTERNS) {
    if (pat.test(normalised)) {
      return { isOutlineDraft: false, confidence: 0, signals: ['advisory_override'] };
    }
  }

  // ── Phase 1: Check negation (used in Phase 3 to halve score if needed)
  const hasNegation = NEGATION_PATTERNS.some((pat) => pat.test(normalised));

  // ── Phase 2: Score accumulation across pattern groups
  let score = 0;
  const signals: string[] = [];

  for (const group of PATTERN_GROUPS) {
    const matched = group.patterns.some((pat) => pat.test(normalised));
    if (matched) {
      score += group.weight;
      signals.push(group.label);
    }
  }

  // ── Phase 3: Apply negation penalty
  if (hasNegation && score > 0) {
    score = score * 0.5;
    signals.push('negation_halved');
  }

  // ── Phase 4: Clamp to [0, 1]
  const confidence = Math.min(1.0, Math.max(0, score));

  return {
    isOutlineDraft: confidence >= CONFIDENCE_THRESHOLD,
    confidence,
    signals,
  };
}
