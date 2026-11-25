import { existsSync, readdirSync, statSync } from "node:fs";
import { knowledgePath, readKnowledgeText, requireSummary, type TopicSummary } from "./knowledge-layout.ts";
import { MEETING_EVIDENCE_TYPES, parseMetadata, readConceptMetadata, type OkfSource } from "./okf-frontmatter.ts";

export interface IndexEntry { title: string; description: string; target: string; }
export interface DirectoryIndex { title: string; entries: IndexEntry[]; }
export interface FileUpdate { path: string; previous?: string; content: string; }

export function escapeMarkdown(text: string): string { return text.replace(/[\\[\]]/g, "\\$&"); }
export function encodeKnowledgeLink(path: string): string { return path.split("/").map(encodeURIComponent).join("/"); }

/** Read directory navigation, not concept bodies. Published plugin directories require an index. */
export function readDirectoryIndex(root: string, directory: string): DirectoryIndex {
  const path = knowledgePath(root, directory ? `${directory}/index.md` : "index.md");
  return _parseIndex(readKnowledgeText(path), path, directory === "");
}

/** Compute every catalogue and log change before publishing a meeting. */
export function planKnowledgeIndexes(root: string, parts: string[], summaries: TopicSummary[], meetingId: string, title: string, description: string, now: string, updating = false): FileUpdate[] {
  const changes: FileUpdate[] = [];
  const scopes = [
    { directory: "", title: "Session memory knowledge", entry: { target: "meetings/", title: "Meeting knowledge", description: "Conclusions and evidence from historical reviews." } },
    ...parts.map((part, index) => ({
      directory: ["meetings", ...parts.slice(0, index)].join("/"),
      title: index === 0 ? "Meeting knowledge" : summaries[index - 1].title.trim(),
      entry: { target: `${part}/`, title: summaries[index].title.trim(), description: summaries[index].description.trim() },
    })),
    { directory: ["meetings", ...parts].join("/"), title: summaries.at(-1)!.title.trim(), entry: { target: `${meetingId}/`, title: title.trim(), description: description.trim() } },
  ];
  for (const scope of scopes) {
    const path = knowledgePath(root, scope.directory ? `${scope.directory}/index.md` : "index.md");
    const previous = existsSync(path) ? readKnowledgeText(path) : undefined;
    if (updating && previous === undefined) throw new Error(`Knowledge directory index is missing: ${path}`);
    const index = previous === undefined ? { title: scope.title, entries: [] } : _parseIndex(previous, path, scope.directory === "");
    if (existsSync(knowledgePath(root, scope.directory))) validateDirectoryEntries(root, scope.directory, index);
    if (index.title !== scope.title) throw new Error(`Knowledge directory title conflicts with its existing index: ${path}`);
    const existing = index.entries.find(entry => entry.target === scope.entry.target);
    const meetingScope = scope === scopes.at(-1);
    if (updating && meetingScope && !existing) throw new Error(`Knowledge meeting index entry is missing: ${path}`);
    if (existing && (existing.title !== scope.entry.title || existing.description !== scope.entry.description)) {
      if (updating && meetingScope) Object.assign(existing, scope.entry);
      else throw new Error(`Knowledge directory summary conflicts with its existing index: ${path}`);
    }
    if (!existing) index.entries.push(scope.entry);
    changes.push({ path, previous, content: renderDirectoryIndex(index, scope.directory === "") });
  }
  const log = knowledgePath(root, "log.md");
  const previous = existsSync(log) ? readKnowledgeText(log) : undefined;
  const heading = "# Knowledge update log\n";
  const text = previous === undefined ? heading : previous;
  if (!text.startsWith(heading) || /^---|^## (?!\d{4}-\d{2}-\d{2}$)/m.test(text)) throw new Error("Knowledge log has an unexpected structure");
  const dateHeading = `## ${now.slice(0, 10)}\n`;
  const relative = ["meetings", ...parts, meetingId, "minutes.md"].join("/");
  const entry = `- ${now}: ${updating ? "Updated" : "Added"} draft meeting [${escapeMarkdown(title.trim())}](/${encodeKnowledgeLink(relative)}).\n`;
  const remaining = text.slice(heading.length).trimStart();
  const body = remaining.startsWith(dateHeading) ? `${dateHeading}\n${entry}${remaining.slice(dateHeading.length).trimStart()}` : `${dateHeading}\n${entry}\n${remaining}`;
  changes.push({ path: log, previous, content: `${heading}\n${body}` });
  return changes;
}

export function renderDirectoryIndex(index: DirectoryIndex, root = false): string {
  requireSummary(index.title, "index title");
  const entries = [...index.entries].sort((a, b) => a.target.localeCompare(b.target));
  for (const entry of entries) {
    requireSummary(entry.title, "index entry title");
    requireSummary(entry.description, "index entry description");
  }
  return `${root ? '---\nokf_version: "0.2"\n---\n\n' : ""}# ${escapeMarkdown(index.title)}\n\n${entries.map(entry => `* [${escapeMarkdown(entry.title)}](${encodeKnowledgeLink(entry.target)}) - ${entry.description}`).join("\n")}\n`;
}

/** Require navigation for documents, or a validated minutes.sources link for meeting evidence. */
export function validateDirectoryEntries(root: string, directory: string, index: DirectoryIndex): void {
  const targets = new Set<string>();
  const children = readdirSync(knowledgePath(root, directory), { withFileTypes: true });
  for (const entry of index.entries) {
    const relative = directory ? `${directory}/${entry.target}` : entry.target;
    const path = knowledgePath(root, relative);
    if (!existsSync(path)) throw new Error(`Knowledge index target is missing: ${path}`);
    const directoryTarget = entry.target.endsWith("/");
    const listed = children.find(item => item.name === entry.target.replace(/\/$/, ""));
    if (!listed || listed.isDirectory() !== directoryTarget || (!directoryTarget && !listed.isFile())) throw new Error(`Knowledge index target has the wrong file type: ${path}`);
    if (targets.has(entry.target)) throw new Error(`Duplicate knowledge index target: ${entry.target}`);
    targets.add(entry.target);
  }
  const evidenceTargets = _meetingEvidenceTargets(root, directory, targets);
  for (const entry of children) {
    if (entry.name.startsWith(".") || entry.name === "index.md" || entry.name === "log.md") continue;
    knowledgePath(root, directory ? `${directory}/${entry.name}` : entry.name);
    const target = entry.isDirectory() ? `${entry.name}/` : entry.name;
    if ((entry.isDirectory() || entry.name.endsWith(".md")) && !targets.has(target) && !evidenceTargets.has(target)) throw new Error(`Unlisted knowledge index target: ${target}`);
  }
}

/** Only explicit, valid evidence references can replace an index entry. */
function _meetingEvidenceTargets(root: string, directory: string, indexedTargets: Set<string>): Set<string> {
  const targets = new Set<string>();
  if (!indexedTargets.has("minutes.md")) return targets;
  const minutesPath = knowledgePath(root, directory ? `${directory}/minutes.md` : "minutes.md");
  const metadata = readConceptMetadata(readKnowledgeText(minutesPath), minutesPath);
  if (!("sources" in metadata)) return targets;
  const sourceIds = new Set<string>();
  for (const source of metadata.sources as OkfSource[]) {
    if (!/^\.\/[^/\\]+\.md$/.test(source.resource) || source.resource.slice(2).startsWith(".")) {
      throw new Error(`Meeting evidence sources must link to immediate Markdown children: ${minutesPath}: ${source.resource}`);
    }
    const target = source.resource.slice(2);
    if (targets.has(target)) throw new Error(`Duplicate meeting evidence target: ${minutesPath}: ${target}`);
    if (source.id !== undefined) {
      if (sourceIds.has(source.id)) throw new Error(`Duplicate meeting evidence source ID: ${minutesPath}: ${source.id}`);
      sourceIds.add(source.id);
    }
    const path = knowledgePath(root, directory ? `${directory}/${target}` : target);
    if (!existsSync(path)) throw new Error(`Meeting evidence source is missing: ${path}`);
    if (!statSync(path).isFile()) throw new Error(`Meeting evidence source has the wrong file type: ${path}`);
    const evidence = readConceptMetadata(readKnowledgeText(path), path);
    if (!(MEETING_EVIDENCE_TYPES as readonly unknown[]).includes(evidence.type)) {
      throw new Error(`Meeting evidence source has the wrong concept type: ${path}`);
    }
    targets.add(target);
  }
  return targets;
}

function _parseIndex(markdown: string, path: string, root: boolean): DirectoryIndex {
  let body = markdown;
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body);
  if (frontmatter) {
    if (!root) throw new Error(`Only the bundle-root index may contain frontmatter: ${path}`);
    const value = parseMetadata(frontmatter[1], path);
    if (Object.keys(value).length !== 1 || value.okf_version !== "0.2") throw new Error(`Root knowledge index must declare only okf_version: "0.2": ${path}`);
    body = body.slice(frontmatter[0].length);
  }
  const lines = body.split(/\r?\n/).filter(line => line.trim());
  if (!lines[0]?.startsWith("# ")) throw new Error(`Knowledge index must start with a title: ${path}`);
  const title = _unescape(lines[0].slice(2));
  const entries = lines.slice(1).map(line => {
    const match = /^\* \[((?:\\.|[^\]\\])*)\]\(([^\s)]+)\) - (.+)$/.exec(line);
    if (!match) throw new Error(`Invalid knowledge index entry: ${path}: ${line}`);
    const target = decodeURIComponent(match[2]);
    if (!/^(?:[^/]+\/|[^/]+\.md)$/.test(target) || target.includes("\\") || target.startsWith(".")) throw new Error(`Knowledge index entries must link to immediate children: ${path}`);
    return { title: _unescape(match[1]), target, description: match[3] };
  });
  return { title, entries };
}
function _unescape(text: string): string { return text.replace(/\\([\\[\]])/g, "$1"); }
