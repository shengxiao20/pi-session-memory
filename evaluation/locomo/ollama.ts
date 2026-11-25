import assert from "node:assert/strict";
import type { ModelRole, ResolvedModel, ResolvedModels } from "./config.ts";
import { requestModelJson } from "./model-http.ts";

export interface OllamaModelCheck {
  serverVersion: string;
  digest: string;
  architecture: string;
  maximumContextWindow: number;
  capabilities: string[];
  thinking: { values: (boolean | string)[]; default: boolean | string; };
}
export type ModelChecks = Record<ModelRole, OllamaModelCheck | null>;

/** Inspect local models without generating text, loading weights or downloading files. */
export async function inspectModels(models: Partial<ResolvedModels>, timeoutMs: number): Promise<ModelChecks> {
  const servers = new Map<string, { version: string; tags: { name: string; digest: string; }[]; }>();
  const inspected = new Map<string, OllamaModelCheck>();
  const checks: ModelChecks = { planner: null, answer: null, judge: null };
  for (const role of Object.keys(models) as ModelRole[]) {
    const model = models[role]!;
    if (model.backend === "openai") continue;
    if (!servers.has(model.baseURL)) {
      const version = await requestModelJson(model, "/api/version", undefined, timeoutMs);
      assert(typeof version.version === "string" && /^\d+\.\d+\.\d+$/.test(version.version), "Expected a stable Ollama server version");
      const [major, minor] = version.version.split(".").map(Number);
      assert(major > 0 || minor >= 35, "Ollama server >=0.35.0 required for explicit truncate=false and shift=false");
      const tags = await requestModelJson(model, "/api/tags", undefined, timeoutMs);
      assert(Array.isArray(tags.models), "Missing Ollama model list");
      servers.set(model.baseURL, { version: version.version, tags: tags.models });
    }
    const server = servers.get(model.baseURL)!;
    const key = JSON.stringify([model.baseURL, model.model]);
    if (!inspected.has(key)) {
      const matches = server.tags.filter(tag => tag.name === model.model);
      assert.equal(matches.length, 1, `Expected one installed Ollama model named ${model.model}`);
      assert(typeof matches[0].digest === "string" && /^[a-f0-9]{64}$/.test(matches[0].digest), "Invalid Ollama model digest");
      const show = await requestModelJson(model, "/api/show", { model: model.model }, timeoutMs);
      assert(Array.isArray(show.capabilities) && show.capabilities.every((value: unknown) => typeof value === "string"), "Missing Ollama capabilities");
      assert(show.capabilities.includes("completion"), `${model.model} requires completion capability`);
      assert(show.thinking && Array.isArray(show.thinking.values) && show.thinking.values.length > 0, `Missing thinking.values for ${model.model}`);
      assert(show.thinking.values.every((value: unknown) => typeof value === "boolean" || (typeof value === "string" && value.trim())), "Invalid thinking.values");
      assert(show.thinking.values.includes(show.thinking.default), "Invalid Ollama thinking default");
      const architecture = show.model_info?.["general.architecture"];
      assert(typeof architecture === "string" && architecture.trim(), "Missing Ollama model architecture");
      const maximumContextWindow = show.model_info[`${architecture}.context_length`];
      assert(Number.isSafeInteger(maximumContextWindow) && maximumContextWindow > 0, "Missing Ollama model context limit");
      inspected.set(key, { serverVersion: server.version, digest: matches[0].digest, architecture, maximumContextWindow,
        capabilities: show.capabilities, thinking: { values: show.thinking.values, default: show.thinking.default } });
    }
    const check = inspected.get(key)!;
    assert(check.thinking.values.includes(model.thinking), `${role}: Unsupported think=${JSON.stringify(model.thinking)} for ${model.model}; supported=${JSON.stringify(check.thinking.values)}`);
    if (model.thinking !== false) assert(check.capabilities.includes("thinking"), `${model.model} requires thinking capability`);
    assert(model.contextWindow <= check.maximumContextWindow, `${role}: contextWindow exceeds model limit ${check.maximumContextWindow}`);
    checks[role] = check;
  }
  return checks;
}

/** Check reported token counts against explicit context and generation budgets. */
export function validateOllamaUsage(model: Extract<ResolvedModel, { backend: "ollama" }>, promptTokens: number, completionTokens: number): void {
  assert(promptTokens + model.maxTokens <= model.contextWindow, "Prompt and output budget exceed the configured Ollama context window");
  assert(completionTokens <= model.maxTokens, "Ollama generated more tokens than the configured output budget");
}
