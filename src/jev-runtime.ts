import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { JevConnectionConfig, JevModel } from "./config.ts";
import { OllamaService } from "./ollama-service.ts";

export type JevRuntimeState = "disabled" | "starting" | "ready" | "unavailable";
export interface JevRuntimeStatus { state: JevRuntimeState; reason?: string; }

/** Session-scoped System One connection, with explicitly opt-in local Ollama lifecycle management. */
export class JevRuntime {
  private state: JevRuntimeState = "disabled";
  private reason?: string;
  private ollama?: OllamaService;
  private startup?: Promise<JevRuntimeStatus>;
  private model?: JevModel;
  private connection?: JevConnectionConfig;
  private apiKey?: string;
  private contextWindowTokens?: number;

  /** Resolve configured credentials and budget; only managed local connections start or inspect Ollama. */
  async ensureReady(enabled: boolean, model: JevModel, connection: JevConnectionConfig): Promise<JevRuntimeStatus> {
    if (!enabled) return this._setStatus("disabled");
    if (this.model !== undefined && this.model !== model) throw new Error(`Jev runtime already uses model ${this.model}; cannot switch to ${model} within the same session`);
    if (this.connection !== undefined && !_sameConnection(this.connection, connection)) throw new Error("Jev runtime connection cannot switch within the same session; reload the extension after changing configuration");
    // Configuration/credential errors are explicit, not converted to literal-recall fallback.
    const apiKey = _apiKey(connection);
    this.model = model;
    this.connection = { ...connection };
    this.apiKey = apiKey;
    if (this.state === "ready" || this.state === "unavailable") return this.status();
    if (!this.startup) this.startup = this._start(model, connection);
    return this.startup;
  }

  /** Return the current session-local availability state without performing work. */
  status(): JevRuntimeStatus { return this.reason ? { state: this.state, reason: this.reason } : { state: this.state }; }

  /** Preserve existing request-failure behavior: Jev remains unavailable for the rest of this Pi session. */
  markUnavailable(error: unknown): JevRuntimeStatus { return this._setStatus("unavailable", String(error)); }

  /** Create the same System One client for Ollama, official Jev, or Qwen; the SDK appends /v1/systemone. */
  client(): TypeSafeClient {
    if (this.state !== "ready" || this.model === undefined || this.connection === undefined || this.apiKey === undefined) throw new Error("Jev runtime is not ready");
    return new TypeSafeClient({ apiKey: this.apiKey, baseURL: this.connection.baseURL, defaultModel: this.model, timeout: 30_000, retry: { maxRetries: 0 } });
  }

  /** Return the configured System One model name. */
  selectedModel(): JevModel {
    if (this.model === undefined) throw new Error("Jev runtime model is not selected");
    return this.model;
  }

  /** Return the effective configured input budget or managed Ollama num_ctx, without remote discovery. */
  contextWindow(): number {
    if (this.contextWindowTokens === undefined) throw new Error("Jev runtime context window is not available");
    return this.contextWindowTokens;
  }

  /** Stop only a local Ollama process this runtime started; unmanaged connections need no cleanup. */
  shutdown(): void { this.ollama?.shutdown(); this.ollama = undefined; }

  private async _start(model: JevModel, connection: JevConnectionConfig): Promise<JevRuntimeStatus> {
    this._setStatus("starting");
    if (!connection.manageOllama) {
      if (connection.contextWindow === undefined) throw new Error("Unmanaged Jev connection requires contextWindow");
      this.contextWindowTokens = connection.contextWindow;
      return this._setStatus("ready");
    }
    try {
      this.ollama = new OllamaService(connection.baseURL);
      const detected = await this.ollama.ensureModel(model);
      this.contextWindowTokens = Math.min(connection.contextWindow ?? detected, detected);
      return this._setStatus("ready");
    } catch (error) { return this._setStatus("unavailable", String(error)); }
  }

  private _setStatus(state: JevRuntimeState, reason?: string): JevRuntimeStatus { this.state = state; this.reason = reason; return this.status(); }
}

function _apiKey(connection: JevConnectionConfig): string {
  if (connection.apiKeyEnv === undefined) {
    if (!connection.manageOllama) throw new Error("Unmanaged Jev connection requires apiKeyEnv");
    return "ollama";
  }
  const key = process.env[connection.apiKeyEnv]?.trim();
  if (!key) throw new Error(`Jev API key environment variable ${connection.apiKeyEnv} is missing or empty`);
  return key;
}

function _sameConnection(a: JevConnectionConfig, b: JevConnectionConfig): boolean {
  return a.baseURL === b.baseURL && a.apiKeyEnv === b.apiKeyEnv && a.contextWindow === b.contextWindow && a.manageOllama === b.manageOllama;
}
