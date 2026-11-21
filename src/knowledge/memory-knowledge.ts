import { existsSync, readFileSync } from "node:fs";
import { resolveKnowledgePath } from "./knowledge-storage.ts";
import { knowledgePath, listMeetingLocations, validateMeetingId, type MeetingLocation } from "./knowledge-layout.ts";
import { readDirectoryIndex, validateDirectoryEntries, type IndexEntry } from "./knowledge-index.ts";
import { readConceptMetadata } from "./okf-frontmatter.ts";

export interface KnowledgeEntry extends MeetingLocation {
  frontmatter: Record<string, unknown>;
  index_matches_metadata: boolean;
}
export interface KnowledgeCatalogue {
  knowledge_root: string;
  directory: string;
  directories: Array<{ directory: string; title: string; description: string }>;
  meetings: KnowledgeEntry[];
  documents: Array<{ concept_id: string; path: string; frontmatter: Record<string, unknown>; index_matches_metadata: boolean }>;
}

export { KNOWLEDGE_FIRST_NOTICE } from "../../prompts/guidance.ts";

/** Inspect one directory's navigation and immediate meeting metadata. Never write or start recall. */
export function inspectMemoryKnowledge(directory = ""): KnowledgeCatalogue {
  if (typeof directory !== "string" || (directory !== "" && !/^meetings(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)*$/.test(directory))) throw new Error("directory must be empty for the bundle root or a managed meetings directory copied from the catalogue");
  const root = resolveKnowledgePath();
  const path = knowledgePath(root, directory);
  const result: KnowledgeCatalogue = { knowledge_root: root, directory, directories: [], meetings: [], documents: [] };
  if (!existsSync(path) && directory === "") return result;
  const index = readDirectoryIndex(root, directory);
  validateDirectoryEntries(root, directory, index);
  const locations = listMeetingLocations(root);
  for (const entry of index.entries) {
    const relative = directory ? `${directory}/${entry.target}` : entry.target;
    if (entry.target.endsWith("/")) {
      const child = relative.slice(0, -1);
      const location = locations.find(location => location.relative_path === `${child}/minutes.md`);
      if (location) result.meetings.push(_meetingEntry(root, location, entry));
      else result.directories.push({ directory: child, title: entry.title, description: entry.description });
    } else {
      const documentPath = knowledgePath(root, relative);
      const frontmatter = readConceptMetadata(readFileSync(documentPath, "utf8"), documentPath);
      const index_matches_metadata = _matches(frontmatter, entry);
      const location = locations.find(location => location.relative_path === relative);
      if (location) result.meetings.push({ ...location, frontmatter, index_matches_metadata });
      else result.documents.push({ concept_id: relative.slice(0, -3), path: documentPath, frontmatter, index_matches_metadata });
    }
  }
  return result;
}

/** Read the exact saved minutes using a stable ID, independent of the theme directory depth. */
export function readMemoryKnowledge(meetingId: string): KnowledgeEntry & { markdown: string } {
  validateMeetingId(meetingId);
  const root = resolveKnowledgePath();
  const location = listMeetingLocations(root).find(entry => entry.meeting_id === meetingId);
  if (!location) throw new Error(`Saved meeting_id not found: ${meetingId}`);
  const markdown = readFileSync(location.path, "utf8");
  const frontmatter = readConceptMetadata(markdown, location.path);
  const index = _validatedMeetingIndex(root, location);
  const entry = index.entries.find(entry => entry.target === "minutes.md")!;
  return { ...location, frontmatter, index_matches_metadata: _matches(frontmatter, entry), markdown };
}

function _meetingEntry(root: string, location: MeetingLocation, entry: IndexEntry): KnowledgeEntry {
  _validatedMeetingIndex(root, location);
  const frontmatter = readConceptMetadata(readFileSync(location.path, "utf8"), location.path);
  return { ...location, frontmatter, index_matches_metadata: _matches(frontmatter, entry) };
}
function _validatedMeetingIndex(root: string, location: MeetingLocation) {
  const directory = location.relative_path.slice(0, -"/minutes.md".length);
  const index = readDirectoryIndex(root, directory);
  validateDirectoryEntries(root, directory, index);
  return index;
}
function _matches(frontmatter: Record<string, unknown>, entry: IndexEntry): boolean {
  return frontmatter.title === entry.title && frontmatter.description === entry.description;
}
