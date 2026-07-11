export type RendererModel = { id: string; label?: string; provider?: string; contextWindow?: number };

export function initModelCache(api: Pick<Window['api'], 'aiModels'>) {
  let rendererModels: RendererModel[] | null = null;
  let rendererModelsPromise: Promise<RendererModel[]> | null = null;

  async function loadModelsCached(force = false): Promise<RendererModel[]> {
    if (force) {
      rendererModelsPromise = api.aiModels(true).then((models) => {
        rendererModels = models;
        return models;
      });
      return rendererModelsPromise;
    }
    if (rendererModels) return rendererModels;
    if (!rendererModelsPromise) {
      rendererModelsPromise = api.aiModels(false).then((models) => {
        rendererModels = models;
        return models;
      });
    }
    return rendererModelsPromise;
  }

  function invalidateModels(): void {
    rendererModels = null;
    rendererModelsPromise = null;
  }

  void loadModelsCached();
  return { loadModelsCached, invalidateModels };
}
