import { Value } from "typebox/value";
import { setupConfigurationSchema } from "./setup-schema.ts";
import { randomUUID } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getMemoryConfigPath, validateMemoryConfig } from "../settings/config.ts";
import { resolveKnowledgePath } from "../knowledge/knowledge-storage.ts";

const GUIDE_PATH = fileURLToPath(new URL("../../setup.md", import.meta.url));
export const SETUP_NOTICE = "Use setup_memory when the user asks how pi-session-memory works, how to use this plugin, or asks to run setup. Read setup.md and ask one configuration question per reply in its stated order. General usage questions do not authorize writes. Call configure_memory only after the user approves the final proposed settings. Setup is not historical review and does not run import, cleanup or service startup. The /pi-session-memory command provides direct setup, Pi history import, and indexed-tool-turn cleanup actions; transcript search uses Agent tools.";
export const SETUP_REQUEST = "Run pi-session-memory setup. Call setup_memory to read setup.md and the current configuration. Explain each optional feature and ask one question at a time in the guide's order. Wait for every answer. Show the proposed changes, then write the plugin configuration with configure_memory only after I approve saving.";

/** Load the packaged guide and raw current settings. Only an explicitly missing file is a new setup. */
export function readMemorySetup() {
  const config_path = getMemoryConfigPath();
  return { guide_path: GUIDE_PATH, config_path, configuration: _readConfiguration(config_path), guide: readFileSync(GUIDE_PATH, "utf8") };
}

/** Validate and atomically save approved settings without starting services or touching the transcript index. */
export function configureMemory(configuration: Record<string, unknown>) {
  if (!Value.Check(setupConfigurationSchema, configuration)) throw new Error("Invalid setup configuration: supply supported JSON settings only, including a positive recallLimit; credentials and environment-only inputs are not configuration keys.");
  const config_path = getMemoryConfigPath();
  const current = _readConfiguration(config_path);
  // Retain unrelated top-level settings; supplied nested objects are complete replacements.
  const proposed = { ...current, ...configuration };
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
