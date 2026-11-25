const SECRET = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]+|\b(?:sk|ghp|github_pat)-?[A-Za-z0-9_]{24,}|\bBearer\s+[A-Za-z0-9._~+/-]{20,}|(?:api[_-]?key|client[_-]?secret|password|access[_-]?token)\s*[=:]\s*["']?[A-Za-z0-9+/_.=-]{16,}/i;

export function containsSecret(text: string): boolean { return SECRET.test(text); }

/** Minimal local-use redaction. Human review is required before publishing. */
export function redact(text: string): { text: string; count: number } {
  let count = 0;
  const result = text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, () => { count++; return "[EMAIL]"; })
    .replace(/(`|")((?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^`"]+)\1/g, (_match, quote: string) => {
      count++; return `${quote}[PATH]${quote}`;
    })
    .replace(/\/(?:Users|home)\/[^\s"'`<>]+/g, () => { count++; return "[PATH]"; })
    .replace(/\b[A-Z]:\\Users\\[^\s"'`<>]+/gi, () => { count++; return "[PATH]"; });
  return { text: result, count };
}

/** Keep evaluation questions and answers outside the source corpus. */
export function isEvaluationText(text: string): boolean {
  return /Pi\s*RecallBench|Session\s*Marathon|third-party-1500|candidate_answer|gold_answer|recall-dataset|构建数据集|数据集构建|候选数据集|标准答案|评分程序/i.test(text);
}
