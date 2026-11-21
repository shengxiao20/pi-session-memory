import { existsSync, lstatSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

export interface TopicSummary { title: string; description: string; }
export interface MeetingLocation { meeting_id: string; relative_path: string; concept_id: string; path: string; }

export function requireSummary(value: unknown, key: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) throw new Error(`${key} must be non-empty single-line text`);
}

export function validateTopicPath(path: string, summaries: TopicSummary[]): string[] {
  if (typeof path !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/.test(path)) {
    throw new Error("topic_path must be a relative path of lowercase kebab-case directory names; absolute paths and traversal are not allowed");
  }
  const parts = path.split("/");
  if (!Array.isArray(summaries) || summaries.length !== parts.length) throw new Error("topic_summaries must contain one title and description for each topic_path segment");
  for (const summary of summaries) {
    requireSummary(summary?.title, "topic title");
    requireSummary(summary?.description, "topic description");
  }
  return parts;
}

export function validateMeetingId(id: string): void {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error("meeting_id must be one non-hidden directory identifier without path separators");
}

/** Resolve a bundle-relative path and reject symlinks inside the managed root. */
export function knowledgePath(root: string, relativePath: string): string {
  if (!isAbsolute(root)) throw new Error("Knowledge root must be an absolute directory");
  if (isAbsolute(relativePath) || relativePath.includes("\\") || relativePath.split("/").some(part => part === "." || part === "..")) {
    throw new Error("Knowledge path must remain inside the managed root");
  }
  let current = resolve(root);
  for (const part of ["", ...relativePath.split("/").filter(Boolean)]) {
    current = join(current, part);
    if (existsSync(current) || _isSymlink(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`Knowledge symlinks are not allowed: ${current}`);
    }
  }
  return current;
}

/** Locate meeting IDs with one recursive traversal, independent of the directory depth. */
export function listMeetingLocations(root: string): MeetingLocation[] {
  const directory = knowledgePath(root, "meetings");
  if (!existsSync(directory)) return [];
  const locations: MeetingLocation[] = [];
  const ids = new Set<string>();
  function visit(relativeDirectory: string): void {
    const path = knowledgePath(root, relativeDirectory);
    const minutes = knowledgePath(root, `${relativeDirectory}/minutes.md`);
    if (existsSync(minutes)) {
      const id = basename(path);
      validateMeetingId(id);
      if (ids.has(id)) throw new Error(`Duplicate meeting_id: ${id}`);
      ids.add(id);
      const relative_path = `${relativeDirectory}/minutes.md`;
      locations.push({ meeting_id: id, relative_path, concept_id: relative_path.slice(0, -3), path: minutes });
    }
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const child = `${relativeDirectory}/${entry.name}`;
      knowledgePath(root, child);
      if (entry.isDirectory()) visit(child);
    }
  }
  visit("meetings");
  return locations;
}

function _isSymlink(path: string): boolean {
  // existsSync returns false for a dangling symlink. Its parent listing exposes that entry.
  const parent = resolve(path, "..");
  return existsSync(parent) && readdirSync(parent).includes(basename(path)) && lstatSync(path).isSymbolicLink();
}
