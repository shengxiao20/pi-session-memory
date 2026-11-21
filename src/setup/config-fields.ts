import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_FIELD_HELP, ENVIRONMENT_HELP } from "../../prompts/configuration.ts";
import { DEFAULT_JEV_CONNECTION, DEFAULT_DISCUSSION_TURN_THRESHOLD, DISCUSSION_TURN_THRESHOLD_ENV, RECALL_MODES, DEFAULT_RECALL_MODE } from "../settings/config.ts";

export interface ConfigField {
  key: string;
  label: string;
  kind: "boolean" | "integer" | "string" | "enum";
  choices?: readonly string[];
  requirement: string;
  description: string;
  defaultValue?: string | number | boolean;
  defaultLabel: string;
  minimum?: number;
  requiredWhen?: { key: string; value: boolean };
}

/** Shared, serializable field help for the direct editor and read-only Agent setup tool. */
export const CONFIG_FIELDS: readonly ConfigField[] = [
  { key: "recallLimit", kind: "integer", ...CONFIG_FIELD_HELP.recallLimit, defaultValue: 20, minimum: 1 },
  { key: "recallMode", kind: "enum", ...CONFIG_FIELD_HELP.recallMode, choices: RECALL_MODES, defaultValue: DEFAULT_RECALL_MODE },
  { key: "consultation.timeoutMs", kind: "integer", ...CONFIG_FIELD_HELP["consultation.timeoutMs"], defaultValue: 120000, minimum: 1 },
  { key: "consultation.turnThreshold", kind: "integer", ...CONFIG_FIELD_HELP["consultation.turnThreshold"](DISCUSSION_TURN_THRESHOLD_ENV), defaultValue: DEFAULT_DISCUSSION_TURN_THRESHOLD, minimum: 0 },
  { key: "knowledgePath", kind: "string", ...CONFIG_FIELD_HELP.knowledgePath, defaultLabel: join(homedir(), ".pi", "agent", "pi-session-memory", "knowledge") },
  { key: "jevEnable", kind: "boolean", ...CONFIG_FIELD_HELP.jevEnable, defaultValue: false },
  { key: "model", kind: "string", ...CONFIG_FIELD_HELP.model, defaultValue: "nimble", requiredWhen: { key: "jevConnection.manageOllama", value: false } },
  { key: "jevConnection.baseURL", kind: "string", ...CONFIG_FIELD_HELP["jevConnection.baseURL"], defaultValue: DEFAULT_JEV_CONNECTION.baseURL, defaultLabel: DEFAULT_JEV_CONNECTION.baseURL },
  { key: "jevConnection.manageOllama", kind: "boolean", ...CONFIG_FIELD_HELP["jevConnection.manageOllama"], defaultValue: true },
  { key: "jevConnection.apiKeyEnv", kind: "string", ...CONFIG_FIELD_HELP["jevConnection.apiKeyEnv"], requiredWhen: { key: "jevConnection.manageOllama", value: false } },
  { key: "jevConnection.contextWindow", kind: "integer", ...CONFIG_FIELD_HELP["jevConnection.contextWindow"], minimum: 1, requiredWhen: { key: "jevConnection.manageOllama", value: false } },
];

export const ENVIRONMENT_INPUTS = [
  { key: DISCUSSION_TURN_THRESHOLD_ENV, ...ENVIRONMENT_HELP.discussionTurnThreshold },
  { key: "MEMORY_DB_PATH", ...ENVIRONMENT_HELP.databasePath },
  { key: "OLLAMA_HOST", ...ENVIRONMENT_HELP.ollamaHost },
  { key: "<jevConnection.apiKeyEnv>", ...ENVIRONMENT_HELP.apiKey },
] as const;

/** Copy supported groups without modifying the source or removing unknown nested keys. */
export function createConfigDraft(raw: Record<string, unknown> | null): Record<string, unknown> {
  const draft: Record<string, unknown> = {};
  for (const key of new Set(CONFIG_FIELDS.map(field => field.key.split(".")[0]))) {
    if (raw && Object.hasOwn(raw, key)) draft[key] = structuredClone(raw[key]);
  }
  if (draft.consultation !== undefined) {
    getConfigFieldValue(draft, "consultation.timeoutMs"); // Reject malformed groups before removing the retired field.
    delete (draft.consultation as Record<string, unknown>).knowledgePath;
  }
  return draft;
}

export function getConfigFieldValue(draft: Record<string, unknown>, key: string): unknown {
  const [group, property] = key.split(".");
  if (!property) return draft[group];
  const parent = draft[group];
  if (parent === undefined) return undefined;
  if (parent === null || typeof parent !== "object" || Array.isArray(parent)) throw new Error(`${group} must be a JSON object`);
  return (parent as Record<string, unknown>)[property];
}

export function setConfigFieldValue(draft: Record<string, unknown>, field: ConfigField, value: unknown): void {
  const [group, property] = field.key.split(".");
  if (!property) { if (value === undefined) delete draft[group]; else draft[group] = value; return; }
  getConfigFieldValue(draft, field.key); // Reject malformed existing groups instead of replacing them.
  if (draft[group] === undefined) draft[group] = {};
  const parent = draft[group] as Record<string, unknown>;
  if (value === undefined) delete parent[property]; else parent[property] = value;
}

/** Blank means the displayed default, or unset when no literal default exists. Invalid values are errors. */
export function parseConfigFieldValue(field: ConfigField, raw: string): unknown {
  if (raw.trim() === "") return field.defaultValue;
  if (field.kind === "string") return raw.trim();
  if (field.kind === "enum") {
    if (!field.choices!.includes(raw)) throw new Error(`${field.key} must be one of: ${field.choices!.join(", ")}`);
    return raw;
  }
  if (field.kind === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new Error(`${field.key} must be true or false`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < field.minimum! || raw !== String(value)) throw new Error(`${field.key} must be a decimal safe integer >= ${field.minimum} without whitespace`);
  return value;
}

/** Complete unset fields with documented defaults and editor proposals before validation. */
export function completeConfigDraft(draft: Record<string, unknown>): Record<string, unknown> {
  const proposal = structuredClone(draft);
  for (const field of CONFIG_FIELDS) {
    if (getConfigFieldValue(proposal, field.key) === undefined && field.defaultValue !== undefined) setConfigFieldValue(proposal, field, field.defaultValue);
  }
  for (const field of CONFIG_FIELDS) {
    if (field.requiredWhen && getConfigFieldValue(proposal, field.requiredWhen.key) === field.requiredWhen.value && getConfigFieldValue(proposal, field.key) === undefined) throw new Error(`${field.key} is ${field.requirement}`);
  }
  return proposal;
}

export function formatConfigField(field: ConfigField, draft: Record<string, unknown>): string {
  const required = field.requirement.startsWith("required") || Boolean(field.requiredWhen && getConfigFieldValue(draft, field.requiredWhen.key) === field.requiredWhen.value);
  const variable = `${field.key.includes(".") ? "  " : ""}${field.key}`;
  const width = Math.max(...CONFIG_FIELDS.map(field => field.key.length + (field.key.includes(".") ? 2 : 0)));
  const value = getConfigFieldValue(draft, field.key);
  const now = value === undefined ? field.defaultValue ?? field.defaultLabel : value;
  return `${variable.padEnd(width + 4)}(${required ? "required" : "optional"})  (now: ${String(now)})`;
}

