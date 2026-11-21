import { statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { getSessionMemoryConfig, type SessionMemoryConfig } from "../settings/config.ts";

/** Select the complete OKF root for both routes. Resolution never creates directories or falls back from an invalid path. */
export function resolveKnowledgePath(config: SessionMemoryConfig = getSessionMemoryConfig()): string {
  const path = config.knowledgePath ?? join(homedir(), ".pi", "agent", "pi-session-memory", "knowledge");
  if (!path.trim() || !isAbsolute(path)) throw new Error("knowledgePath must be an absolute knowledge directory, not an existing file");
  let entry: Stats | undefined;
  try { entry = statSync(path); }
  catch (error) {
    // Only a missing directory is valid before the first publication. Other storage errors must remain visible.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (entry && !entry.isDirectory()) throw new Error("knowledgePath must be an absolute knowledge directory, not an existing file");
  return path;
}
