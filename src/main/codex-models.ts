import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getAccessToken } from './codex-auth';
import { applyModelDisplayPolicy } from './ai/model-display-policy';
import type { ModelRef } from './ai/types';

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const CACHE_PATH = () => path.join(app.getPath('userData'), 'codex-models-cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const FALLBACK_MODELS = [
  'gpt-5.6',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
];


export type ModelInfo = { id: string; label?: string };

type Cache = { fetchedAt: number; models: ModelInfo[] };

function decodeJwt(jwt: string): any {
  try {
    const parts = jwt.split('.');
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}

function cloudflareHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'codex_cli_rs/0.0.0 (notepad-ai)',
    originator: 'codex_cli_rs',
  };
  const claims = decodeJwt(token);
  const acctId =
    claims?.['https://api.openai.com/auth']?.chatgpt_account_id ?? claims?.chatgpt_account_id;
  if (acctId) headers['ChatGPT-Account-ID'] = String(acctId);
  return headers;
}

async function readCache(): Promise<Cache | null> {
  try {
    return JSON.parse(await fs.readFile(CACHE_PATH(), 'utf-8'));
  } catch {
    return null;
  }
}

async function writeCache(cache: Cache) {
  try {
    await fs.mkdir(path.dirname(CACHE_PATH()), { recursive: true });
    await fs.writeFile(CACHE_PATH(), JSON.stringify(cache, null, 2));
  } catch {
    /* ignore */
  }
}
function parseModels(payload: any): ModelInfo[] {
  const raw: any[] =
    (Array.isArray(payload?.data) && payload.data) ||
    (Array.isArray(payload?.models) && payload.models) ||
    (Array.isArray(payload) && payload) ||
    [];
  return raw
    .map((m: any) => (typeof m === 'string' ? { id: m } : { id: m?.id, label: m?.display_name ?? m?.label }))
    .filter((m: ModelInfo) => typeof m.id === 'string' && m.id);
}
function applyChatGptDisplayPolicy(models: ModelInfo[]): ModelInfo[] {
  const allowedIds = new Set(
    applyModelDisplayPolicy(
      models.map((model) => ({
        provider: 'chatgpt' as const,
        id: model.id,
        label: model.label,
        humanizeEngineId: 'openai',
        requiresAuth: true,
      } satisfies ModelRef)),
    ).map((model) => model.id),
  );
  return models.filter((model) => allowedIds.has(model.id));
}


async function fetchLiveModels(token: string): Promise<ModelInfo[]> {
  const r = await fetch(`${CODEX_BASE_URL}/models?client_version=1.0.0`, {
    method: 'GET',
    headers: cloudflareHeaders(token),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const models = applyChatGptDisplayPolicy(parseModels(await r.json()));
  if (models.length === 0) throw new Error('empty allowed model list');
  return models;
}

/** Current-account models only; never substitutes the generic fallback catalog. */
export async function getAccountModels(): Promise<ModelInfo[]> {
  const token = await getAccessToken();
  if (!token) return [];
  try {
    return await fetchLiveModels(token);
  } catch {
    return [];
  }
}


export async function getModels(forceRefresh = false): Promise<ModelInfo[]> {
  const cache = await readCache();
  if (!forceRefresh && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS && cache.models.length > 0) {
    return applyChatGptDisplayPolicy(cache.models);
  }
  const token = await getAccessToken();
  if (!token) return FALLBACK_MODELS.map((id) => ({ id }));

  try {
    const models = await fetchLiveModels(token);
    await writeCache({ fetchedAt: Date.now(), models });
    return models;
  } catch {
    if (cache?.models.length) return applyChatGptDisplayPolicy(cache.models);
    return FALLBACK_MODELS.map((id) => ({ id }));
  }
}
