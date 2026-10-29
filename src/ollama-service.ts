import { spawn, type ChildProcess } from "node:child_process";

const MINIMUM_OLLAMA_VERSION = [0, 35, 0] as const;

/** Local-only lifecycle management; System One requests do not depend on this component. */
export class OllamaService {
  private startedOllama?: ChildProcess;
  private readonly baseURL: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(baseURL: string) {
    this.baseURL = baseURL.replace(/\/+$/, "");
    this.env = { ...process.env, OLLAMA_HOST: new URL(baseURL).host };
  }

  /** Start or reuse the configured local service, install the selected model, and read its num_ctx. */
  async ensureModel(model: string): Promise<number> {
    if (!await this._healthy()) {
      await this._startOllama();
      await this._waitForHealthy();
    }
    const version = await this._ollamaVersion();
    if (!_atLeast(version, MINIMUM_OLLAMA_VERSION)) throw new Error(`Ollama ${version.join(".")} is installed; jev requires Ollama ${MINIMUM_OLLAMA_VERSION.join(".")} or newer`);
    await this._runOllama(["pull", model]);
    return this._modelContextWindow(model);
  }

  /** Stop only the process this component started; leave pre-existing services untouched. */
  shutdown(): void { this.startedOllama?.kill(); this.startedOllama = undefined; }

  /** ChildProcess startup failures are asynchronous events, not exceptions thrown by spawn(). */
  private _startOllama(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.startedOllama = spawn("ollama", ["serve"], { stdio: "ignore", env: this.env });
      this.startedOllama.once("error", reject);
      this.startedOllama.once("spawn", resolve);
    });
  }

  private async _healthy(): Promise<boolean> { try { return (await fetch(`${this.baseURL}/api/tags`)).ok; } catch { return false; } }

  private async _modelContextWindow(model: string): Promise<number> {
    const response = await fetch(`${this.baseURL}/api/show`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) });
    if (!response.ok) throw new Error(`Could not inspect Jev model ${model}: ${response.status} ${response.statusText}`);
    const details = await response.json() as { parameters?: string };
    const numCtx = details.parameters?.match(/^num_ctx\s+(\d+)$/m)?.[1];
    if (!numCtx) throw new Error(`Jev model ${model} does not declare a num_ctx parameter`);
    return Number(numCtx);
  }

  private async _waitForHealthy(): Promise<void> { for (let attempt = 0; attempt < 50; attempt++) { if (await this._healthy()) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("Ollama did not become ready after starting ollama serve"); }
  private async _ollamaVersion(): Promise<number[]> { const output = await this._runOllama(["--version"]); const version = output.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number); if (!version) throw new Error(`Could not determine Ollama version from: ${output.trim()}`); return version; }
  private _runOllama(args: string[]): Promise<string> { return new Promise((resolve, reject) => { const child = spawn("ollama", args, { stdio: ["ignore", "pipe", "pipe"], env: this.env }); let output = ""; let errorOutput = ""; child.stdout.on("data", (data) => { output += data; }); child.stderr.on("data", (data) => { errorOutput += data; }); child.on("error", reject); child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(`ollama ${args.join(" ")} failed (${code}): ${errorOutput.trim()}`))); }); }
}

function _atLeast(actual: number[], required: readonly number[]): boolean { for (let index = 0; index < required.length; index++) { if (actual[index] !== required[index]) return actual[index] > required[index]; } return true; }
