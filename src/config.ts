import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionMemoryConfig {
  recallLimit: number;
}

/** Read the required global recall result limit from Pi's extension configuration directory. */
export function getRecallLimit(): number {
  const path = join(homedir(), ".pi", "agent", "pi-session-memory", "config.json");
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!_isConfig(value)) throw new Error(`Invalid pi-session-memory configuration at ${path}: recallLimit must be a positive integer.`);
  return value.recallLimit;
}

function _isConfig(value: unknown): value is SessionMemoryConfig {
  return typeof value === "object" && value !== null && typeof (value as { recallLimit?: unknown }).recallLimit === "number" && Number.isInteger((value as { recallLimit: number }).recallLimit) && (value as { recallLimit: number }).recallLimit >= 1;
}
