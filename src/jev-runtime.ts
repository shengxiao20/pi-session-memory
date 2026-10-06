import { spawn, type ChildProcess } from "node:child_process";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { JevModel } from "./config.ts";

const OLLAMA_URL = "http://127.0.0.1:11434";
const MINIMUM_OLLAMA_VERSION = [0, 35, 0] as const;

export type JevRuntimeState = "disabled" | "starting" | "ready" | "unavailable";
export interface JevRuntimeStatus { state: JevRuntimeState; reason?: string; }

/** Manage the session-scoped local Ollama service used by the optional jev relevance filter. */
export class JevRuntime {
  private state: JevRuntimeState = "disabled";
  private reason?: string;
  private startedOllama?: ChildProcess;
  private startup?: Promise<JevRuntimeStatus>;
  private model?: JevModel;
  private contextWindowTokens?: number;

  /** Start or reuse Ollama, ensure Nimble is available, and return a local Jev-compatible client. */
  async ensureReady(enabled: boolean, model: JevModel): Promise<JevRuntimeStatus> {
    if (!enabled) return this._setStatus("disabled");
    if (this.model !== undefined && this.model !== model) throw new Error(`Jev runtime already uses model ${this.model}; cannot switch to ${model} within the same session`);
    this.model = model;
    if (this.state === "ready" || this.state === "unavailable") return this.status();
    if (!this.startup) this.startup = this._start(model);
    return this.startup;
  }

  /** Return the current session-local availability state without performing work. */
  status(): JevRuntimeStatus { return this.reason ? { state: this.state, reason: this.reason } : { state: this.state }; }

  /** Record a request failure so Jev remains unavailable for the rest of this Pi session. */
  markUnavailable(error: unknown): JevRuntimeStatus { return this._setStatus("unavailable", String(error)); }

  /** Create a client only after ensureReady() has returned ready. */
  client(): TypeSafeClient {
    if (this.state !== "ready" || this.model === undefined) throw new Error("Jev runtime is not ready");
    return new TypeSafeClient({ apiKey: "ollama", baseURL: OLLAMA_URL, defaultModel: this.model, timeout: 30_000, retry: { maxRetries: 0 } });
  }

  /** Return the configured model after ensureReady() has selected it. */
  selectedModel(): JevModel {
    if (this.model === undefined) throw new Error("Jev runtime model is not selected");
    return this.model;
  }

  /** Return the effective Ollama num_ctx limit for the selected Jev model. */
  contextWindow(): number {
    if (this.contextWindowTokens === undefined) throw new Error("Jev runtime context window is not available");
    return this.contextWindowTokens;
  }

  /** Stop only the Ollama process this runtime started; never terminate a pre-existing service. */
  shutdown(): void { this.startedOllama?.kill(); this.startedOllama = undefined; }

  private async _start(model: JevModel): Promise<JevRuntimeStatus> {
    this._setStatus("starting");
    try {
      if (!await _healthy()) {
        this.startedOllama = spawn("ollama", ["serve"], { stdio: "ignore" });
        await _waitForHealthy();
      }
      const version = await _ollamaVersion();
      if (!_atLeast(version, MINIMUM_OLLAMA_VERSION)) throw new Error(`Ollama ${version.join(".")} is installed; jev requires Ollama ${MINIMUM_OLLAMA_VERSION.join(".")} or newer`);
      await _runOllama(["pull", model]);
      this.contextWindowTokens = await _modelContextWindow(model);
      return this._setStatus("ready");
    } catch (error) { return this._setStatus("unavailable", String(error)); }
  }

  private _setStatus(state: JevRuntimeState, reason?: string): JevRuntimeStatus { this.state = state; this.reason = reason; return this.status(); }
}

async function _healthy(): Promise<boolean> { try { return (await fetch(`${OLLAMA_URL}/api/tags`)).ok; } catch { return false; } }
async function _modelContextWindow(model: JevModel): Promise<number> {
  const response = await fetch(`${OLLAMA_URL}/api/show`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) });
  if (!response.ok) throw new Error(`Could not inspect Jev model ${model}: ${response.status} ${response.statusText}`);
  const details = await response.json() as { parameters?: string };
  const numCtx = details.parameters?.match(/^num_ctx\s+(\d+)$/m)?.[1];
  if (!numCtx) throw new Error(`Jev model ${model} does not declare a num_ctx parameter`);
  return Number(numCtx);
}
async function _waitForHealthy(): Promise<void> { for (let attempt = 0; attempt < 50; attempt++) { if (await _healthy()) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("Ollama did not become ready after starting ollama serve"); }
async function _ollamaVersion(): Promise<number[]> { const output = await _runOllama(["--version"]); const version = output.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number); if (!version) throw new Error(`Could not determine Ollama version from: ${output.trim()}`); return version; }
function _atLeast(actual: number[], required: readonly number[]): boolean { for (let index = 0; index < required.length; index++) { if (actual[index] !== required[index]) return actual[index] > required[index]; } return true; }
function _runOllama(args: string[]): Promise<string> { return new Promise((resolve, reject) => { const child = spawn("ollama", args, { stdio: ["ignore", "pipe", "pipe"] }); let output = ""; let errorOutput = ""; child.stdout.on("data", (data) => { output += data; }); child.stderr.on("data", (data) => { errorOutput += data; }); child.on("error", reject); child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(`ollama ${args.join(" ")} failed (${code}): ${errorOutput.trim()}`))); }); }
