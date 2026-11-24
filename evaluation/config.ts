import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateMemoryConfig, type SessionMemoryConfig } from "../src/settings/config.ts";

export interface OllamaSampling {
  temperature: number;
  topP: number;
  topK: number;
  minP: number;
  presencePenalty: number;
  repeatPenalty: number;
  seed: number;
}
export type ModelBackend = { backend: "openai"; } | { backend: "ollama"; thinking: boolean | string; contextWindow: number; sampling: OllamaSampling; };

function _validateSampling(value: unknown, location: string): asserts value is OllamaSampling {
  assert(value && typeof value === "object" && !Array.isArray(value), `Set explicit ${location}`);
  assert.deepEqual(Object.keys(value).sort(), ["minP", "presencePenalty", "repeatPenalty", "seed", "temperature", "topK", "topP"], `Unexpected ${location} fields`);
  const sampling = value as OllamaSampling;
  for (const [key, maximum] of [["temperature", 2], ["topP", 1], ["minP", 1]] as const) {
    assert(Number.isFinite(sampling[key]) && sampling[key] >= 0 && sampling[key] <= maximum, `Invalid ${location}.${key}`);
  }
  assert(Number.isSafeInteger(sampling.topK) && sampling.topK >= 0, `Invalid ${location}.topK`);
  assert(Number.isFinite(sampling.presencePenalty) && Math.abs(sampling.presencePenalty) <= 2, `Invalid ${location}.presencePenalty`);
  assert(Number.isFinite(sampling.repeatPenalty) && sampling.repeatPenalty > 0, `Invalid ${location}.repeatPenalty`);
  assert(Number.isSafeInteger(sampling.seed) && sampling.seed >= 0, `Invalid ${location}.seed`);
}
export type ModelConfig = ModelBackend & { baseURLEnv: string; apiKeyEnv: string; modelEnv: string; maxTokens: number; };
export interface EvalConfig {
  dataset: string;
  sampleIndices: number[];
  categories: number[];
  questionsPerSample: number | null;
  contextCharacterLimit: number;
  timeoutMs: number;
  memory: SessionMemoryConfig;
  models: { planner: ModelConfig; answer: ModelConfig; judge: ModelConfig; };
}

export function readConfig(path: string): EvalConfig { return parseConfig(JSON.parse(readFileSync(path, "utf8"))); }

export function parseConfig(value: unknown): EvalConfig {
  assert(value && typeof value === "object" && !Array.isArray(value), "Invalid evaluation config");
  const config = value as EvalConfig;
  assert(typeof config.dataset === "string" && config.dataset.trim());
  assert(Array.isArray(config.sampleIndices) && config.sampleIndices.length > 0);
  assert(config.sampleIndices.every(index => Number.isSafeInteger(index) && index >= 0));
  assert.equal(new Set(config.sampleIndices).size, config.sampleIndices.length, "Duplicate sample index");
  assert(Array.isArray(config.categories) && config.categories.length > 0);
  assert(config.categories.every(category => [1, 2, 3, 4].includes(category)), "Supported categories: 1–4; category 5 has no standard gold answer");
  assert.equal(new Set(config.categories).size, config.categories.length);
  assert(config.questionsPerSample === null || (Number.isSafeInteger(config.questionsPerSample) && config.questionsPerSample > 0));
  assert(Number.isSafeInteger(config.contextCharacterLimit) && config.contextCharacterLimit > 0);
  assert(Number.isSafeInteger(config.timeoutMs) && config.timeoutMs > 0);
  config.memory = validateMemoryConfig(config.memory, "evaluation config.memory");
  assert.equal(config.memory.recallMode, "normal", "Evaluation supports normal recall");
  assert.equal(config.memory.jevConnection.manageOllama, false, "Evaluation requires unmanaged Jev; start services separately");
  assert(config.models && typeof config.models === "object");
  for (const role of ["planner", "answer", "judge"] as const) {
    const model = config.models[role];
    assert(model && typeof model === "object", `Missing model: ${role}`);
    for (const key of ["baseURLEnv", "apiKeyEnv", "modelEnv"] as const) {
      assert(typeof model[key] === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(model[key]), `Invalid ${role}.${key}`);
    }
    assert(Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0);
    assert(model.backend === "openai" || model.backend === "ollama", `Invalid ${role}.backend`);
    if (model.backend === "ollama") {
      assert(typeof model.thinking === "boolean" || (typeof model.thinking === "string" && model.thinking.trim() === model.thinking && model.thinking.length > 0), `Set explicit ${role}.thinking`);
      assert(Number.isSafeInteger(model.contextWindow) && model.contextWindow > model.maxTokens, `${role}.contextWindow must exceed maxTokens`);
      _validateSampling(model.sampling, `${role}.sampling`);
    } else {
      assert(!("thinking" in model) && !("contextWindow" in model) && !("sampling" in model), `Ollama controls require ${role}.backend=ollama`);
    }
  }
  return config;
}

export type ResolvedModel = ModelBackend & { baseURL: string; apiKey: string; model: string; maxTokens: number; };
export type ModelRole = keyof EvalConfig["models"];
export type ResolvedModels = Record<ModelRole, ResolvedModel>;
export function resolveModel(config: ModelConfig): ResolvedModel {
  const baseURL = requiredEnv(config.baseURLEnv);
  const url = new URL(baseURL);
  assert(["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, "Invalid model API root");
  assert(!url.pathname.endsWith("/chat/completions"), "baseURL must be an API root, for example https://api.openai.com/v1");
  const reference = { baseURL: baseURL.replace(/\/+$/, ""), apiKey: requiredEnv(config.apiKeyEnv), model: requiredEnv(config.modelEnv), maxTokens: config.maxTokens };
  if (config.backend === "ollama") {
    assert.equal(url.pathname, "/", "Ollama baseURL must be a server root, for example http://127.0.0.1:11434");
    _validateSampling(config.sampling, "model.sampling");
    return { ...reference, backend: "ollama", thinking: config.thinking, contextWindow: config.contextWindow, sampling: config.sampling };
  }
  assert.equal(config.backend, "openai", "Set an explicit model backend");
  return { ...reference, backend: "openai" };
}
export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  assert(value, `Missing environment variable: ${name}`);
  return value;
}

/** Resolve paths from the repository working directory, never from production HOME. */
export function datasetPath(config: EvalConfig): string { return resolve(config.dataset); }

/** Export model identity for provenance without writing credentials. */
export function modelIdentity<T extends ResolvedModel>(model: T): Omit<T, "apiKey"> {
  const { apiKey: _apiKey, ...identity } = model;
  return identity;
}
