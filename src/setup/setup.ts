import { Value } from "typebox/value";
import { setupConfigurationSchema } from "./setup-schema.ts";
import { CONFIG_FIELDS, ENVIRONMENT_INPUTS } from "./config-fields.ts";
import { randomUUID } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getMemoryConfigPath, validateMemoryConfig } from "../settings/config.ts";
import { resolveKnowledgePath } from "../knowledge/knowledge-storage.ts";

const GUIDE_PATH = fileURLToPath(new URL("../../prompts/setup.md", import.meta.url));
export { SETUP_NOTICE, SETUP_REQUEST } from "../../prompts/guidance.ts";

/** Load the packaged guide and raw current settings. Only an explicitly missing file is a new setup. */
export function readMemorySetup() {
  const config_path = getMemoryConfigPath();
  return { guide_path: GUIDE_PATH, config_path, configuration: _readConfiguration(config_path), fields: CONFIG_FIELDS, environment_inputs: ENVIRONMENT_INPUTS, guide: readFileSync(GUIDE_PATH, "utf8") };
}

/** Validate and atomically save approved settings without starting services or touching the transcript index. */
export function configureMemory(configuration: Record<string, unknown>) {
  if (!Value.Check(setupConfigurationSchema, configuration)) throw new Error("Invalid setup configuration: supply supported JSON settings only, including a positive recallLimit; credentials and environment-only inputs are not configuration keys.");
  const config_path = getMemoryConfigPath();
  const current = _readConfiguration(config_path);
  // Complete supported settings replace the old settings; unrelated top-level keys remain.
  const proposed: Record<string, unknown> = { ...current };
  for (const key of Object.keys(setupConfigurationSchema.properties)) delete proposed[key];
  // Remove retired top-level keys only during an explicitly approved save. Never infer a knowledge path.
  delete proposed.enableDiscussion;
  delete proposed.obsidianExportEnabled;
  delete proposed.obsidianVaultPath;
  Object.assign(proposed, configuration);
  const normalized = validateMemoryConfig(proposed, config_path);
  resolveKnowledgePath(normalized);
  mkdirSync(dirname(config_path), { recursive: true });
  const pending = join(dirname(config_path), `.config-${randomUUID()}.pending`);
  try {
    writeFileSync(pending, `${JSON.stringify(proposed, null, 2)}\n`, { flag: "wx" });
    renameSync(pending, config_path);
  } finally { rmSync(pending, { force: true }); }
  return { config_path, configuration: proposed };
}

function _readConfiguration(path: string): Record<string, unknown> | null {
  let contents: string;
  try { contents = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const value: unknown = JSON.parse(contents);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Configuration must be a JSON object: ${path}`);
  return value as Record<string, unknown>;
}
