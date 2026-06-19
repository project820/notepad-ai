/**
 * AI-tell taxonomy re-expressed as prompt/rule data.
 *
 * The Korean taxonomy is derived from the im-not-ai project (MIT) — see NOTICE.
 * im-not-ai is a Python/Claude-Code skill, so its taxonomy/playbook is here
 * re-expressed as static TypeScript directive data (no code is copied verbatim).
 *
 * The English taxonomy is intentionally MINIMAL and EXPERIMENTAL: im-not-ai is
 * Korean-only, so English humanization is a small best-effort set and must be
 * presented as experimental (no parity claims).
 */

export type TaxonomyCategory = {
  id: string;
  /** Short label shown in directives. */
  label: string;
  /** One-line corrective instruction injected into the system prompt. */
  directive: string;
};

/** Korean AI-tell categories (the 10 im-not-ai macro categories, summarized). */
export const KO_CATEGORIES: ReadonlyArray<TaxonomyCategory> = [
  { id: 'A', label: '번역투', directive: "'~를 통해/~에 대해/~에 있어서/~에 의해' 같은 번역투와 이중 피동('~되어진다')을 자연스러운 한국어로 바꾼다." },
  { id: 'B', label: '영어 과다', directive: '불필요한 영어 병기와 번역 가능한 영어 용어를 한국어로 정리한다.' },
  { id: 'C', label: '기계적 구조', directive: "기계적 '첫째/둘째/셋째' 나열과 과도한 불릿·헤딩·이모지를 줄인다." },
  { id: 'D', label: 'AI 관용구', directive: "'결론적으로/시사하는 바가 크다/주목할 만하다/혁신적인' 같은 AI 특유 관용구를 제거한다." },
  { id: 'E', label: '리듬 균일성', directive: '문장 길이를 다양하게 하고 동일 종결어미 반복을 피한다.' },
  { id: 'F', label: '수식·중복', directive: "'매우/정말' 같은 과한 수식과 '~적/~성/~화' 남발을 줄인다." },
  { id: 'G', label: 'Hedging', directive: "'~할 수 있을 것으로 보인다' 같은 다중 완곡 표현을 단정적으로 정리한다." },
  { id: 'H', label: '접속사 남발', directive: "문두 '또한/따라서/즉/나아가' 연속 사용을 줄인다." },
  { id: 'I', label: '형식명사', directive: "'것이다/점/수/바/~할 필요가 있다' 같은 형식명사 과다를 정리한다." },
  { id: 'J', label: '시각 장식', directive: '과도한 볼드/따옴표/대시(—) 사용을 줄인다.' },
];

/** English AI-tell categories — MINIMAL, EXPERIMENTAL (im-not-ai is Korean-only). */
export const EN_EXPERIMENTAL = true;

export const EN_CATEGORIES: ReadonlyArray<TaxonomyCategory> = [
  { id: 'en-transitions', label: 'generic transitions', directive: 'Avoid formulaic transitions ("Moreover", "Furthermore", "In conclusion").' },
  { id: 'en-hedging', label: 'excessive hedging', directive: 'Cut piled-up hedges ("it could be argued that", "it is worth noting that").' },
];

export function categoriesFor(language: 'ko' | 'en'): ReadonlyArray<TaxonomyCategory> {
  return language === 'ko' ? KO_CATEGORIES : EN_CATEGORIES;
}
