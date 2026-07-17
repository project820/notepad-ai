import type { AiProviderId, ModelRef } from './types';

type ModelDisplaySelection = Pick<ModelRef, 'provider' | 'id'>;

export type ModelDisplayPolicyContext = {
  /** Current selection for this picker. It is reinjected when its source is still available. */
  currentSelection?: ModelDisplaySelection;
};

const ALLOWED_CLOUD_MODEL_IDS: Readonly<Record<'chatgpt' | 'claude' | 'grok', readonly string[]>> = {
  chatgpt: [
    'gpt-5.6',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.3-codex-spark',
  ],
  claude: ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8'],
  grok: ['grok-4.5', 'grok-composer-2.5-fast'],
};

function humanizeEngineId(provider: AiProviderId): string {
  return provider === 'claude' ? 'claude' : provider === 'openrouter' ? 'openrouter' : 'openai';
}
function isCuratedCloudModel(selection: ModelDisplaySelection): boolean {
  const allowed = ALLOWED_CLOUD_MODEL_IDS[selection.provider as keyof typeof ALLOWED_CLOUD_MODEL_IDS];
  return !!allowed?.includes(selection.id);
}
function reinjectedSelection(selection: ModelDisplaySelection): ModelRef {
  return {
    provider: selection.provider,
    id: selection.id,
    label: selection.id,
    humanizeEngineId: humanizeEngineId(selection.provider),
    requiresAuth: true,
    custom: true,
  };
}

/**
 * Restrict catalog display to product-approved exact IDs. Ollama discovery is
 * deliberately passed through. Persisted/current selections are reinjected
 * after filtering when their source is still available, so catalog updates
 * never strand an existing user while route-hidden curated models stay hidden.
 */
export function applyModelDisplayPolicy(
  models: readonly ModelRef[],
  context: ModelDisplayPolicyContext = {},
): ModelRef[] {
  const visible = models.filter((model) => {
    if (model.provider === 'ollama') return true;
    if (model.provider === 'openrouter') return false;
    const allowed = ALLOWED_CLOUD_MODEL_IDS[model.provider as keyof typeof ALLOWED_CLOUD_MODEL_IDS];
    return !!allowed && allowed.includes(model.id);
  });

  const current = context.currentSelection;
  const selected = current
    ? models.find((model) => model.provider === current.provider && model.id === current.id)
    : undefined;
  if (
    current
    && !visible.some((model) => model.provider === current.provider && model.id === current.id)
    && (selected || !isCuratedCloudModel(current))
  ) {
    visible.push(selected ? { ...selected, custom: true } : reinjectedSelection(current));
  }
  return visible;
}
