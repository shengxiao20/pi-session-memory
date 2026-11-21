import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { knowledgePath } from "./knowledge-layout.ts";
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
    if (published) { try { rmSync(destination, { recursive: true }); } catch (cleanupError) { errors.push(cleanupError); } }
    for (const directory of created.reverse()) { try { rmdirSync(directory); } catch (cleanupError) { errors.push(cleanupError); } }
    try { rmSync(stage, { recursive: true }); } catch (cleanupError) { errors.push(cleanupError); }
    if (errors.length > 1) throw new AggregateError(errors, "Knowledge publication and rollback failed");
    throw error;
  }
  rmSync(stage, { recursive: true });
}
