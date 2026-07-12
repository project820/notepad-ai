import type { AiChatRequest } from './types';

type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ReasoningCapabilityContext = {
  featureEnabled: boolean;
  accountAvailableModels: ReadonlySet<string>;
  transportVerifiedEffortsByModel: Readonly<Record<string, readonly ReasoningEffort[]>>;
  snapshotGeneration: number;
};

export type ReasoningCapabilitiesSnapshot = {
  featureEnabled: boolean;
  snapshotGeneration: number;
  models: Array<{ modelId: string; efforts: ReasoningEffort[] }>;
  accountModels: string[];
};

const ALLOWED_EFFORTS: readonly ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Fail closed: only independently verified non-max effort is eligible for transport. */
export function sanitizeReasoning(req: AiChatRequest, ctx: ReasoningCapabilityContext): AiChatRequest {
  const effort = req.reasoningEffort;
  const allowed = typeof effort === 'string'
    && (ALLOWED_EFFORTS as readonly string[]).includes(effort)
    && effort !== 'max'
    && req.surfaceMode !== 'html'
    && ctx.featureEnabled
    && req.model.provider === 'chatgpt'
    && ctx.accountAvailableModels.has(req.model.id)
    && (ctx.transportVerifiedEffortsByModel[req.model.id] ?? []).includes(effort as ReasoningEffort);

  return allowed ? req : { ...req, reasoningEffort: undefined };
}
