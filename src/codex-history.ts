/** Identity rules shared by indexing and native-session migration. */
export const CODEX_PARSER_VERSION = "thread-message-v2";

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** session_id denotes the root thread in modern Codex; id denotes this thread. */
export function codexThreadId(metadata: Record<string, unknown>): string {
  const id = nonempty(metadata.id) ?? nonempty(metadata.session_id);
  if (!id) throw new Error("Invalid Codex session_meta.id/session_id: expected a non-empty string");
  return id;
}

/** Native IDs and record positions occupy disjoint namespaces, even on append.
 * Repeated native IDs are assigned record identities after their first occurrence.
 * turn_id metadata deliberately is not used: multiple messages may share one turn.
 * Positions refer to the original parsed records, before content/role filtering.
 */
export function codexMessageIds(entries: readonly Record<string, any>[]): Map<number, string> {
  const ids = new Map<number, string>();
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (entry.type !== "response_item" || entry.payload?.type !== "message") continue;
    const native = nonempty(entry.payload.id) ?? nonempty(entry.id);
    const id = native && !seen.has(native) ? `native:${native}` : `record:${index}`;
    if (native) seen.add(native);
    ids.set(index, id);
  }
  return ids;
}
