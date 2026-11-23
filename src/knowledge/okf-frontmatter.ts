import { parseDocument, stringify } from "yaml";

export interface OkfSource { id?: string; resource: string; title?: string; }

export const MEETING_EVIDENCE_TYPES = ["Transcript Evidence", "Consultation Evidence", "Current Context Evidence"] as const;

/** Parse a YAML mapping without removing producer-defined keys. */
export function parseMetadata(text: string, path: string): Record<string, unknown> {
  const document = parseDocument(text);
  if (document.errors.length) throw new Error(`Invalid OKF frontmatter: ${path}: ${document.errors.map(error => error.message).join("; ")}`);
  const value = document.toJS();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`OKF frontmatter must be a mapping: ${path}`);
  return value;
}

/** Validate OKF concept metadata. Optional families remain optional; unknown keys are retained. */
export function validateConceptMetadata(value: Record<string, unknown>, path: string): void {
  _text(value.type, "type", path);
  for (const key of ["title", "description", "resource"]) if (key in value) _text(value[key], key, path);
  if ("tags" in value) {
    if (!Array.isArray(value.tags)) throw new Error(`OKF tags must be a list: ${path}`);
    value.tags.forEach(tag => _text(tag, "tags entry", path));
  }
  if ("sources" in value) {
    if (!Array.isArray(value.sources)) throw new Error(`OKF sources must be a list: ${path}`);
    for (const source of value.sources) {
      const entry = _mapping(source, "sources entry", path);
      _text(entry.resource, "sources.resource", path);
      for (const key of ["id", "title", "author"]) if (key in entry) _text(entry[key], `sources.${key}`, path);
    }
  }
  if ("generated" in value) {
    const generated = _mapping(value.generated, "generated", path);
    _text(generated.by, "generated.by", path);
    if ("at" in generated) _datetime(generated.at, "generated.at", path);
  }
  if ("verified" in value) {
    const events = Array.isArray(value.verified) ? value.verified : [value.verified];
    for (const event of events) {
      const entry = _mapping(event, "verified event", path);
      _text(entry.by, "verified.by", path);
      _datetime(entry.at, "verified.at", path);
    }
  }
}

/** Read only a concept's frontmatter. Do not return its body or infer missing metadata. */
export function readConceptMetadata(markdown: string, path: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) throw new Error(`Missing OKF frontmatter: ${path}`);
  const value = parseMetadata(match[1], path);
  validateConceptMetadata(value, path);
  return value;
}

export function renderConcept(metadata: Record<string, unknown>, body: string): string {
  validateConceptMetadata(metadata, "generated concept");
  return `---\n${stringify(metadata, { lineWidth: 0 })}---\n\n${body}\n`;
}

function _mapping(value: unknown, key: string, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`OKF ${key} must be a mapping: ${path}`);
  return value as Record<string, unknown>;
}
function _text(value: unknown, key: string, path: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`OKF ${key} must be non-empty text: ${path}`);
}
function _datetime(value: unknown, key: string, path: string): void {
  _text(value, key, path);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value as string) || !Number.isFinite(Date.parse(value as string))) {
    throw new Error(`OKF ${key} must be an ISO 8601 datetime with an explicit UTC offset: ${path}`);
  }
}
