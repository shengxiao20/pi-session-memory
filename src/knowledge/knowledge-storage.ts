import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { getSessionMemoryConfig, type SessionMemoryConfig } from "../settings/config.ts";

/** Select one knowledge root for both OKF routes. Never fall back from an invalid vault. */
export function resolveKnowledgePath(config: SessionMemoryConfig = getSessionMemoryConfig()): string {
  if (!config.obsidianExportEnabled) return config.consultation?.knowledgePath ?? join(homedir(), ".pi", "agent", "pi-session-memory", "knowledge");
  const path = config.obsidianVaultPath;
  if (!path || !isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error("obsidianVaultPath must be an existing absolute vault directory when Obsidian is enabled");
  }
  return path;
}
