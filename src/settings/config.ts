import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";

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

export interface SessionConsultationConfig {
  timeoutMs: number;
  /** Exclusive count of unique returned turns; omitted values use 5. */
  turnThreshold?: number;
}

export const RECALL_MODES = ["choice", "normal", "discussion"] as const;
export type RecallMode = typeof RECALL_MODES[number];
export const DEFAULT_RECALL_MODE: RecallMode = "choice";

export interface SessionMemoryConfig {
  /** How recall_memory delivers retrieved evidence; omitted settings use choice. */
  recallMode: RecallMode;
  consultation?: SessionConsultationConfig;
  recallLimit: number;
  /** Optional System One relevance filtering; omitted legacy configuration means false. */
  jevEnable: boolean;
  /** Decision model name; omitted local configuration means nimble. */
  model: JevModel;
  /** Missing connection configuration retains the original managed local Ollama behavior. */
  jevConnection: JevConnectionConfig;
  /** Complete absolute OKF root, independent of consultation; omitted values use the default root. */
  knowledgePath?: string;
}

type StoredConfig = Pick<SessionMemoryConfig, "recallLimit"> & Partial<Omit<SessionMemoryConfig, "recallLimit">>;

/** Return the global configuration path without reading or creating the file. */
export function getMemoryConfigPath(): string { return join(homedir(), ".pi", "agent", "pi-session-memory", "config.json"); }

/** Read and validate global configuration; only omitted legacy fields receive documented defaults. */
export function getSessionMemoryConfig(): SessionMemoryConfig {
  const path = getMemoryConfigPath();
  return validateMemoryConfig(JSON.parse(readFileSync(path, "utf8")), path);
}

/** Validate proposed setup settings with the same rules used by every runtime reader. */
export function validateMemoryConfig(value: unknown, path = getMemoryConfigPath()): SessionMemoryConfig {
  if (!_isConfig(value)) throw new Error(`Invalid pi-session-memory configuration at ${path}: recallMode must be discussion, normal or choice (default choice); enableDiscussion is no longer supported: remove it through Edit configuration or approved setup; discussion mode requires consultation with positive integer timeoutMs and optional non-negative safe integer turnThreshold; knowledgePath must be a non-empty absolute path when provided; obsidianExportEnabled, obsidianVaultPath and consultation.knowledgePath are no longer supported: replace them with knowledgePath through Edit configuration or approved setup; enableEnv is no longer supported; recallLimit must be a positive integer; jevEnable must be a boolean when provided; model must be a non-empty string when provided; jevConnection requires an HTTP(S) baseURL without credentials, query, hash or a full systemone endpoint, and boolean manageOllama; apiKeyEnv must be an environment variable name and contextWindow a positive integer when provided; unmanaged connections require explicit model, apiKeyEnv and contextWindow; managed Ollama requires a local HTTP root URL.`);
  return { recallMode: value.recallMode ?? DEFAULT_RECALL_MODE, ...(value.consultation ? { consultation: value.consultation } : {}), recallLimit: value.recallLimit, jevEnable: value.jevEnable ?? false, model: value.model ?? "nimble", jevConnection: value.jevConnection ?? { ...DEFAULT_JEV_CONNECTION }, knowledgePath: value.knowledgePath };
}

/** Read the required global recall result limit from Pi's extension configuration directory. */
export function getRecallLimit(): number { return getSessionMemoryConfig().recallLimit; }

function _isConfig(value: unknown): value is StoredConfig {
  if (!_isObject(value)) return false;
  return _isPositiveInteger(value.recallLimit)
    && !("enableDiscussion" in value)
    && (value.recallMode === undefined || RECALL_MODES.some(mode => mode === value.recallMode))
    && (value.recallMode !== "discussion" || value.consultation !== undefined)
    && (value.consultation === undefined || (_isObject(value.consultation)
      && !("enableEnv" in value.consultation)
      && !("knowledgePath" in value.consultation)
      && _isPositiveInteger(value.consultation.timeoutMs)
      && (value.consultation.turnThreshold === undefined || _isNonNegativeInteger(value.consultation.turnThreshold))))
    && (value.jevEnable === undefined || typeof value.jevEnable === "boolean")
    && (value.model === undefined || _isNonEmptyString(value.model))
    && (value.jevConnection === undefined || (_isConnection(value.jevConnection) && (value.jevConnection.manageOllama || _isNonEmptyString(value.model))))
    && !("obsidianExportEnabled" in value)
    && !("obsidianVaultPath" in value)
    && (value.knowledgePath === undefined || (_isNonEmptyString(value.knowledgePath) && isAbsolute(value.knowledgePath)));
}

/** Read consultation settings for discussion or choice; normal cannot open consultants. */
export function getDiscussionConfiguration(): SessionConsultationConfig | undefined {
  const config = getSessionMemoryConfig();
  return config.recallMode === "normal" ? undefined : config.consultation;
}

export const DISCUSSION_TURN_THRESHOLD_ENV = "PI_SESSION_MEMORY_DISCUSSION_TURN_THRESHOLD";
export const DEFAULT_DISCUSSION_TURN_THRESHOLD = 5;

/** Read the exclusive unique returned-turn threshold on each consultation selection. */
export function getDiscussionTurnThreshold(): number {
  const raw = process.env[DISCUSSION_TURN_THRESHOLD_ENV];
  if (raw === undefined) return getSessionMemoryConfig().consultation?.turnThreshold ?? DEFAULT_DISCUSSION_TURN_THRESHOLD;
  const threshold = Number(raw);
  if (!Number.isSafeInteger(threshold) || threshold < 0 || raw !== String(threshold)) {
    throw new Error(`${DISCUSSION_TURN_THRESHOLD_ENV} must be a non-negative safe integer in decimal notation without whitespace`);
  }
  return threshold;
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
function _isNonNegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function _isPositiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
