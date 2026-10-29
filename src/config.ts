import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Examples of local decision models; System One model names are not restricted to this list. */
export const JEV_MODELS = ["nimble", "tev1:4b", "tev1:0.8b"] as const;
export type JevModel = string;

export interface JevConnectionConfig {
  /** API root; the SDK appends /v1/systemone. */
  baseURL: string;
  /** Environment variable containing the API key; required for unmanaged connections. */
  apiKeyEnv?: string;
  /** Effective input budget; required for unmanaged connections, a cap on num_ctx for managed Ollama. */
  contextWindow?: number;
  /** Explicitly opt into starting/pulling/inspecting a local Ollama service. */
  manageOllama: boolean;
}

export const DEFAULT_JEV_CONNECTION: Readonly<JevConnectionConfig> = Object.freeze({
  baseURL: "http://127.0.0.1:11434",
  manageOllama: true,
});

export interface SessionMemoryConfig {
  recallLimit: number;
  /** Optional System One relevance filtering; omitted legacy configuration means false. */
  jevEnable: boolean;
  /** Decision model name; omitted local configuration means nimble. */
  model: JevModel;
  /** Missing connection configuration retains the original managed local Ollama behavior. */
  jevConnection: JevConnectionConfig;
  /** Automatically export every completed search to Obsidian; omitted configuration means false. */
  obsidianExportEnabled: boolean;
  /** Existing Obsidian vault directory required only when automatic export is enabled. */
  obsidianVaultPath?: string;
}

type StoredConfig = Pick<SessionMemoryConfig, "recallLimit"> & Partial<Omit<SessionMemoryConfig, "recallLimit">>;

/** Read and validate global configuration; only omitted legacy fields receive documented defaults. */
export function getSessionMemoryConfig(): SessionMemoryConfig {
  const path = join(homedir(), ".pi", "agent", "pi-session-memory", "config.json");
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!_isConfig(value)) throw new Error(`Invalid pi-session-memory configuration at ${path}: recallLimit must be a positive integer; jevEnable and obsidianExportEnabled must be booleans when provided; model must be a non-empty string when provided; jevConnection requires an HTTP(S) baseURL without credentials, query, hash or a full systemone endpoint, and boolean manageOllama; apiKeyEnv must be an environment variable name and contextWindow a positive integer when provided; unmanaged connections require explicit model, apiKeyEnv and contextWindow; managed Ollama requires a local HTTP root URL; obsidianVaultPath must be a non-empty string when obsidianExportEnabled is true.`);
  return { recallLimit: value.recallLimit, jevEnable: value.jevEnable ?? false, model: value.model ?? "nimble", jevConnection: value.jevConnection ?? { ...DEFAULT_JEV_CONNECTION }, obsidianExportEnabled: value.obsidianExportEnabled ?? false, obsidianVaultPath: value.obsidianVaultPath };
}

/** Read the required global recall result limit from Pi's extension configuration directory. */
export function getRecallLimit(): number { return getSessionMemoryConfig().recallLimit; }

function _isConfig(value: unknown): value is StoredConfig {
  if (!_isObject(value)) return false;
  return _isPositiveInteger(value.recallLimit)
    && (value.jevEnable === undefined || typeof value.jevEnable === "boolean")
    && (value.model === undefined || _isNonEmptyString(value.model))
    && (value.jevConnection === undefined || (_isConnection(value.jevConnection) && (value.jevConnection.manageOllama || _isNonEmptyString(value.model))))
    && (value.obsidianExportEnabled === undefined || typeof value.obsidianExportEnabled === "boolean")
    && (value.obsidianVaultPath === undefined || _isNonEmptyString(value.obsidianVaultPath))
    && (value.obsidianExportEnabled !== true || _isNonEmptyString(value.obsidianVaultPath));
}

function _isConnection(value: unknown): value is JevConnectionConfig {
  if (!_isObject(value) || !_isNonEmptyString(value.baseURL) || typeof value.manageOllama !== "boolean") return false;
  if (value.apiKeyEnv !== undefined && (typeof value.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyEnv))) return false;
  if (value.contextWindow !== undefined && !_isPositiveInteger(value.contextWindow)) return false;
  if (!value.manageOllama && (value.apiKeyEnv === undefined || value.contextWindow === undefined)) return false;
  try {
    const url = new URL(value.baseURL);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || /\/systemone\/?$/.test(url.pathname)) return false;
    return !value.manageOllama || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.pathname === "/");
  } catch { return false; }
}

function _isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function _isNonEmptyString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function _isPositiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
