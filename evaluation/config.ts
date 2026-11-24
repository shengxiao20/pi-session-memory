import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateMemoryConfig, type SessionMemoryConfig } from "../src/settings/config.ts";

export interface ModelConfig { baseURLEnv: string; apiKeyEnv: string; modelEnv: string; maxTokens: number; }
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
  }
  return config;
}

export interface ResolvedModel { baseURL: string; apiKey: string; model: string; maxTokens: number; }
export function resolveModel(config: ModelConfig): ResolvedModel {
  const baseURL = requiredEnv(config.baseURLEnv);
  const url = new URL(baseURL);
  assert(["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, "Invalid model API root");
  assert(!url.pathname.endsWith("/chat/completions"), "baseURL must be an API root, for example https://api.openai.com/v1");
  return { baseURL: baseURL.replace(/\/+$/, ""), apiKey: requiredEnv(config.apiKeyEnv), model: requiredEnv(config.modelEnv), maxTokens: config.maxTokens };
}
export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  assert(value, `Missing environment variable: ${name}`);
  return value;
}

/** Resolve paths from the repository working directory, never from production HOME. */
export function datasetPath(config: EvalConfig): string { return resolve(config.dataset); }

/** Export model identity for provenance without writing credentials. */
export function modelIdentity(model: ResolvedModel): Omit<ResolvedModel, "apiKey"> {
  return { baseURL: model.baseURL, model: model.model, maxTokens: model.maxTokens };
}
