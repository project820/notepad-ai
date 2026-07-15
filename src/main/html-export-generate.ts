/**
 * html-export-generate.ts — main-owned HTML export generation runner (PR-R1 cutover).
 *
 * Composes the pinned no-fallback transport (createHtmlExportTransport) with the
 * generation-attempt orchestrator so a single call drives the WHOLE main-owned
 * trust chain for one attempt: begin -> generate (model streamed IN MAIN) ->
 * storeRaw -> sanitize -> resolve -> pre-finalization quarantine -> finalize.
 *
 * The renderer never streams the model or supplies model output bytes; it submits
 * only the prompt and receives renderer-safe opaque IDs. Per (webContentsId), a new
 * run supersedes any in-flight one, and cancel() aborts cooperatively.
 */

import {
  HtmlExportGenerationOrchestrator,
  type GenerationAttemptResult,
  type OrchestratorPipeline,
  type QuarantineMeasureFn,
} from './html-export-generation-orchestrator';
import { createHtmlExportTransport, type PinnedTransportStream } from './html-export-transport';
import type { AiProviderId } from './ai/types';

type HtmlGenerateModel = { provider: AiProviderId; id: string };

type HtmlGenerateInput = {
  prompt: string;
  model: HtmlGenerateModel;
  instructions?: string;
};

export type HtmlExportGeneratorDeps = {
  pipeline: OrchestratorPipeline;
  quarantine: QuarantineMeasureFn;
  /** Single, fallback-suppressed provider stream (routes by req.model). */
  stream: PinnedTransportStream;
  /** Escalated HTML-export output cap for the selected model. */
  maxOutputTokens?: (model: HtmlGenerateModel) => number | undefined;
};

export type HtmlExportGenerator = {
  run(webContentsId: number, input: HtmlGenerateInput): Promise<GenerationAttemptResult>;
  cancel(webContentsId: number): void;
};

/** Claude and Grok stream over the local CLI on the HTML surface; others over the API. */
function routeTransport(provider: AiProviderId): 'cli' | 'api' {
  return provider === 'claude' || provider === 'grok' ? 'cli' : 'api';
}

export function createHtmlExportGenerator(deps: HtmlExportGeneratorDeps): HtmlExportGenerator {
  const controllers = new Map<number, AbortController>();

  return {
    async run(webContentsId, input) {
      // A fresh generation supersedes any in-flight one for this sender.
      controllers.get(webContentsId)?.abort();
      const controller = new AbortController();
      controllers.set(webContentsId, controller);

      const generate = createHtmlExportTransport({
        model: input.model,
        transport: routeTransport(input.model.provider),
        stream: deps.stream,
        instructions: input.instructions,
        maxOutputTokens: deps.maxOutputTokens?.(input.model),
      });
      const orchestrator = new HtmlExportGenerationOrchestrator({
        pipeline: deps.pipeline,
        generate,
        quarantine: deps.quarantine,
      });

      try {
        return await orchestrator.run(webContentsId, input.prompt, { signal: controller.signal });
      } finally {
        if (controllers.get(webContentsId) === controller) controllers.delete(webContentsId);
      }
    },

    cancel(webContentsId) {
      controllers.get(webContentsId)?.abort();
    },
  };
}
