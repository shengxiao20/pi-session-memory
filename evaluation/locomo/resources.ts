import assert from "node:assert/strict";
import { cpus, freemem, totalmem } from "node:os";
import type { ResolvedModels } from "./config.ts";
import { requestModelJson } from "./model-http.ts";

export function machineSnapshot() {
  return { platform: process.platform, architecture: process.arch, cpuCount: cpus().length,
    totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), controllerRssBytes: process.memoryUsage().rss };
}

/** Capture Ollama-reported resident allocations after generation, rather than claiming a measured peak. */
export async function runningModelSnapshot(models: Partial<ResolvedModels>, timeoutMs: number) {
  const servers = new Map(Object.values(models).filter(model => model.backend === "ollama").map(model => [model.baseURL, model]));
  const snapshots = [];
  for (const [baseURL, model] of servers) {
    const result = await requestModelJson(model, "/api/ps", undefined, timeoutMs);
    assert(Array.isArray(result.models), "Missing running Ollama models");
    for (const running of result.models) {
      assert(typeof running.name === "string" && running.name.trim(), "Invalid running model name");
      for (const field of ["size", "size_vram", "context_length"] as const) {
        assert(Number.isSafeInteger(running[field]) && running[field] >= 0, `Invalid running model ${field}`);
      }
    }
    snapshots.push({ baseURL, models: result.models });
  }
  return { capturedAt: new Date().toISOString(), machine: machineSnapshot(), ollama: snapshots,
    measurement: "End-of-run snapshot; Ollama size/size_vram and system free memory; peak usage remains unmeasured" };
}
