export interface RecallQuery {
  entities: string[];
  primary_entity: string;
  question: string;
}

/** Validate agent search input without inferring or rewriting the primary phrase. */
export function validateRecallQuery(query: RecallQuery): void {
  if (!Array.isArray(query.entities) || query.entities.length < 2 || query.entities.length > 8
    || query.entities.some(entity => typeof entity !== "string" || !entity.trim())) {
    throw new Error("entities must contain 2-8 non-empty literal strings");
  }
  if (typeof query.primary_entity !== "string" || !query.primary_entity.trim()) {
    throw new Error("primary_entity must be a non-empty string");
  }
  if (typeof query.question !== "string" || !query.question.trim()) {
    throw new Error("question must be a non-empty string");
  }
  const primary = query.primary_entity.trim().toLowerCase();
  if (!query.entities.some(entity => entity.trim().toLowerCase() === primary)) {
    throw new Error("primary_entity must be included in entities");
  }
  if (!query.question.toLowerCase().includes(primary)) {
    throw new Error("primary_entity must be a verbatim phrase from question (case-insensitive)");
  }
}
