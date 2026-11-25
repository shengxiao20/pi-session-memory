import assert from "node:assert/strict";
import type { ResolvedModel } from "./config.ts";

/** Send one request. HTTP, timeout and JSON errors propagate to the caller. */
export async function requestModelJson(model: ResolvedModel, path: string, body: unknown, timeoutMs: number) {
  const response = await fetch(`${model.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${model.apiKey}` },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  assert(response.ok, `${path} HTTP ${response.status}: ${text}`);
  const result = JSON.parse(text);
  assert(result && typeof result === "object" && !Array.isArray(result), `${path}: Expected a JSON object`);
  return result;
}
