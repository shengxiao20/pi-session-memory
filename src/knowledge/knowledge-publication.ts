import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { dirname, join, relative } from "node:path";
import { knowledgePath, listMeetingLocations, readKnowledgeText, validateMeetingId } from "./knowledge-layout.ts";
import type { FileUpdate } from "./knowledge-index.ts";

/** Publish one meeting and its navigation files. Roll back all published changes on failure. */
export function publishKnowledge(root: string, destination: string, files: Map<string, string>, updates: FileUpdate[]): void {
  const created: string[] = [];
  const changed: FileUpdate[] = [];
  const rootPath = knowledgePath(root, "");
  if (!existsSync(rootPath)) { mkdirSync(rootPath, { recursive: true }); created.push(rootPath); }
  const stage = mkdtempSync(join(dirname(rootPath), ".pi-session-memory-pending-"));
  let published = false;
  try {
    const meeting = join(stage, "meeting");
    mkdirSync(meeting);
    for (const [name, content] of files) writeFileSync(join(meeting, name), content, { flag: "wx" });
    for (const [index, update] of updates.entries()) writeFileSync(join(stage, `update-${index}`), update.content, { flag: "wx" });
    const parent = relative(rootPath, dirname(destination)).split(/[\\/]/);
    for (let index = 1; index <= parent.length; index++) {
      const path = knowledgePath(root, parent.slice(0, index).join("/"));
      if (!existsSync(path)) { mkdirSync(path); created.push(path); }
    }
    if (existsSync(destination)) throw new Error(`Knowledge meeting destination already exists: ${destination}`);
    renameSync(meeting, destination);
    published = true;
    for (const [index, update] of updates.entries()) {
      knowledgePath(root, relative(rootPath, update.path).split(/[\\/]/).join("/"));
      renameSync(join(stage, `update-${index}`), update.path);
      changed.push(update);
    }
  } catch (error) {
    const errors: unknown[] = [error];
    _restoreChanges(stage, changed, errors);
    if (published) { try { rmSync(destination, { recursive: true }); } catch (cleanupError) { errors.push(cleanupError); } }
    for (const directory of created.reverse()) { try { rmdirSync(directory); } catch (cleanupError) { errors.push(cleanupError); } }
    try { rmSync(stage, { recursive: true }); } catch (cleanupError) { errors.push(cleanupError); }
    if (errors.length > 1) throw new AggregateError(errors, "Knowledge publication and rollback failed");
    throw error;
  }
  rmSync(stage, { recursive: true });
}

/** Serialize catalogue changes and coordinate updates with Pi's native file tools. */
export async function withKnowledgeMutation<T>(root: string, meetingId: string | undefined, operation: () => T | Promise<T>): Promise<T> {
  return withFileMutationQueue(knowledgePath(root, "log.md"), async () => {
    if (meetingId === undefined) return operation();
    validateMeetingId(meetingId);
    const location = listMeetingLocations(root).find(item => item.meeting_id === meetingId);
    if (!location) throw new Error(`Knowledge meeting is missing: ${meetingId}`);
    return withFileMutationQueue(location.path, async () => operation());
  });
}

/** Replace a meeting's changed files and navigation, retaining untouched evidence. */
export function updateKnowledge(root: string, updates: FileUpdate[], expected: Map<string, string>): void {
  const rootPath = knowledgePath(root, "");
  const paths = new Set<string>();
  for (const update of updates) {
    knowledgePath(root, relative(rootPath, update.path).split(/[\\/]/).join("/"));
    if (paths.has(update.path)) throw new Error(`Duplicate knowledge update path: ${update.path}`);
    paths.add(update.path);
  }
  const stage = mkdtempSync(join(dirname(rootPath), ".pi-session-memory-pending-"));
  const changed: FileUpdate[] = [];
  let cleanupStarted = false;
  try {
    for (const [index, update] of updates.entries()) writeFileSync(join(stage, `update-${index}`), update.content, { flag: "wx" });
    for (const [path, content] of expected) {
      knowledgePath(root, relative(rootPath, path).split(/[\\/]/).join("/"));
      if (readKnowledgeText(path) !== content) throw new Error(`Knowledge file changed during update: ${path}`);
    }
    for (const update of updates) {
      const previous = existsSync(update.path) ? readKnowledgeText(update.path) : undefined;
      if (previous !== update.previous) throw new Error(`Knowledge file changed during update: ${update.path}`);
    }
    for (const [index, update] of updates.entries()) {
      renameSync(join(stage, `update-${index}`), update.path);
      changed.push(update);
    }
    cleanupStarted = true;
    rmSync(stage, { recursive: true });
  } catch (error) {
    const errors: unknown[] = [error];
    _restoreChanges(stage, changed, errors);
    if (!cleanupStarted) { try { rmSync(stage, { recursive: true }); } catch (cleanupError) { errors.push(cleanupError); } }
    if (errors.length > 1) throw new AggregateError(errors, "Knowledge update and rollback failed");
    throw error;
  }
}

function _restoreChanges(stage: string, changed: FileUpdate[], errors: unknown[]): void {
  for (const [index, update] of [...changed].reverse().entries()) {
    try {
      if (update.previous === undefined) rmSync(update.path);
      else {
        const backup = join(stage, `restore-${index}`);
        writeFileSync(backup, update.previous, { flag: "wx" });
        renameSync(backup, update.path);
      }
    } catch (cleanupError) { errors.push(cleanupError); }
  }
}
