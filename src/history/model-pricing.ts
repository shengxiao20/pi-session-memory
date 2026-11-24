/** Edit this file to update the price snapshot. Rates are per million tokens. */
export const PRICING_AS_OF = "2026-11-24";
export const PRICING_BASIS = "Current public Standard API list prices; default cache lifetimes; separate USD and CNY totals.";
export const PRICING_FILE = "src/history/model-pricing.ts";

export type PricingCurrency = "USD" | "CNY";
export interface TokenRates {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cache_write_1h?: number;
  cache_write_12h?: number;
}
export interface ModelPricing {
  models: readonly string[];
  currency: PricingCurrency;
  rates: TokenRates;
  long_context?: { input_above: number; rates: TokenRates };
  sources: readonly string[];
}

const OPENAI = "https://developers.openai.com/api/docs/pricing";
const OPENAI_CACHE = "https://developers.openai.com/api/docs/guides/prompt-caching";
const AZURE_SNAPSHOTS = "https://docs.vapi.ai/providers/model/azure-openai";
const CLAUDE = "https://platform.claude.com/docs/en/models/sonnet-4-6/overview";
const SAP_ALIAS = "https://models.auv.tools/m/sap-ai-core/anthropic--claude-4.6-sonnet";
const BIGMODEL = "https://docs.bigmodel.cn/cn/guide/start/pricing";
const QWEN = "https://help.aliyun.com/zh/model-studio/qwen-flash";

/** GPT writes use 30m by default. Claude writes use 5m, plus the recorded 1h subset. */
export const MODEL_PRICING: readonly ModelPricing[] = [
  {
    models: ["gpt-6.1-sol"], currency: "USD",
    rates: { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5, cache_write_12h: 5 },
    long_context: { input_above: 272000, rates: { input: 4, output: 15, cache_read: 0.2, cache_write: 5, cache_write_12h: 10 } },
    sources: [OPENAI, OPENAI_CACHE],
  },
  {
    models: ["gpt-6-luna"], currency: "USD",
    rates: { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125, cache_write_12h: 0.25 },
    long_context: { input_above: 272000, rates: { input: 0.2, output: 0.75, cache_read: 0.02, cache_write: 0.25, cache_write_12h: 0.5 } },
    sources: [OPENAI, OPENAI_CACHE],
  },
  {
    // Published Standard prices include the promotion through 2026-11-30.
    models: ["gpt-5.6-sol", "gpt-5.6-sol-2026-07-09"], currency: "USD",
    rates: { input: 4, output: 20, cache_read: 0.4, cache_write: 5, cache_write_12h: 10 },
    long_context: { input_above: 272000, rates: { input: 8, output: 30, cache_read: 0.8, cache_write: 10, cache_write_12h: 20 } },
    sources: [OPENAI, OPENAI_CACHE, AZURE_SNAPSHOTS],
  },
  {
    models: ["gpt-5.6-terra", "gpt-5.6-terra-2026-07-09"], currency: "USD",
    rates: { input: 2, output: 12, cache_read: 0.2, cache_write: 2.5, cache_write_12h: 5 },
    long_context: { input_above: 272000, rates: { input: 4, output: 18, cache_read: 0.4, cache_write: 5, cache_write_12h: 10 } },
    sources: [OPENAI, OPENAI_CACHE, AZURE_SNAPSHOTS],
  },
  {
    models: ["gpt-5.6-luna", "gpt-5.6-luna-2026-07-09"], currency: "USD",
    rates: { input: 0.2, output: 1.2, cache_read: 0.02, cache_write: 0.25, cache_write_12h: 0.5 },
    long_context: { input_above: 272000, rates: { input: 0.4, output: 1.8, cache_read: 0.04, cache_write: 0.5, cache_write_12h: 1 } },
    sources: [OPENAI, OPENAI_CACHE, AZURE_SNAPSHOTS],
  },
  {
    models: ["claude-sonnet-4-6", "anthropic--claude-4.6-sonnet"], currency: "USD",
    rates: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, cache_write_1h: 6 },
    sources: [CLAUDE, SAP_ALIAS],
  },
  {
    models: ["glm-5.3"], currency: "CNY",
    // Cache storage has a separate policy. New input uses the standard input rate.
    rates: { input: 8, output: 28, cache_read: 2, cache_write: 8 }, sources: [BIGMODEL],
  },
  {
    models: ["glm-5.3-flash"], currency: "CNY",
    // Standard list prices. Promotional and Coding Plan charges have separate terms.
    rates: { input: 0.8, output: 2.8, cache_read: 0.23, cache_write: 0.8 }, sources: [BIGMODEL],
  },
];

export const UNPRICED_MODEL_NOTES: Readonly<Record<string, string>> = {
  "qwen-flash": "Qwen region and cache mode are absent; their prices differ.",
  "unknown": "The saved model ID is unknown.",
};
export const PRICING_SOURCES = [...new Set([...MODEL_PRICING.flatMap(price => price.sources), QWEN])];

export interface PricingUsage {
  model: string | undefined;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cache_write_1h: number;
  cache_write_12h: number;
}
export type CostEstimate = { status: "priced"; currency: PricingCurrency; total: number }
  | { status: "unpriced"; reason: string };

/** Validate edited prices once, then use exact model IDs for every request. */
export function createCostEstimator(pricing: readonly ModelPricing[] = MODEL_PRICING): (usage: PricingUsage) => CostEstimate {
  const prices = new Map<string, ModelPricing>();
  for (const price of pricing) {
    if (price.currency !== "USD" && price.currency !== "CNY") throw new Error(`Invalid pricing currency: ${price.currency}`);
    _validateRates(price.rates);
    if (price.long_context) {
      if (!Number.isSafeInteger(price.long_context.input_above) || price.long_context.input_above < 0) throw new Error("Invalid pricing input threshold");
      _validateRates(price.long_context.rates);
    }
    if (!price.models.length || !price.sources.length) throw new Error("Pricing needs model IDs and sources");
    for (const model of price.models) {
      if (!model.trim() || prices.has(model)) throw new Error(`Invalid or duplicate pricing model: ${model}`);
      prices.set(model, price);
    }
  }
  return usage => {
    for (const field of ["input", "output", "cache_read", "cache_write", "cache_write_1h", "cache_write_12h"] as const) {
      if (!Number.isSafeInteger(usage[field]) || usage[field] < 0) throw new Error(`Invalid pricing token count: ${field}`);
    }
    if (usage.model !== undefined && (typeof usage.model !== "string" || !usage.model.trim())) throw new Error("Invalid pricing model ID");
    const requestInput = usage.input + usage.cache_read + usage.cache_write;
    if (!Number.isSafeInteger(requestInput + usage.output)) throw new Error("Pricing token sum exceeds safe integers");
    if (usage.cache_write_1h + usage.cache_write_12h > usage.cache_write) throw new Error("Cache write lifetime subsets exceed cache write tokens");
    if (usage.model === undefined) return { status: "unpriced", reason: "The usage record has no model ID." };
    const price = prices.get(usage.model);
    if (!price) return { status: "unpriced", reason: UNPRICED_MODEL_NOTES[usage.model] ?? "The model has no confirmed price in the price snapshot." };
    const rates = price.long_context && requestInput > price.long_context.input_above ? price.long_context.rates : price.rates;
    if ((usage.cache_write_1h > 0 && rates.cache_write_1h === undefined) || (usage.cache_write_12h > 0 && rates.cache_write_12h === undefined)) {
      return { status: "unpriced", reason: "The recorded cache lifetime has no confirmed model price." };
    }
    const shortWrite = usage.cache_write - usage.cache_write_1h - usage.cache_write_12h;
    let total = (usage.input * rates.input + usage.output * rates.output + usage.cache_read * rates.cache_read + shortWrite * rates.cache_write) / 1e6;
    if (usage.cache_write_1h > 0) total += usage.cache_write_1h * rates.cache_write_1h! / 1e6;
    if (usage.cache_write_12h > 0) total += usage.cache_write_12h * rates.cache_write_12h! / 1e6;
    if (!Number.isFinite(total) || total < 0) throw new Error("Invalid calculated model cost");
    return { status: "priced", currency: price.currency, total };
  };
}

function _validateRates(rates: TokenRates): void {
  for (const field of ["input", "output", "cache_read", "cache_write"] as const) {
    if (typeof rates[field] !== "number" || !Number.isFinite(rates[field]) || rates[field] < 0) throw new Error(`Invalid pricing rate: ${field}`);
  }
  for (const field of ["cache_write_1h", "cache_write_12h"] as const) {
    if (rates[field] !== undefined && (typeof rates[field] !== "number" || !Number.isFinite(rates[field]) || rates[field]! < 0)) throw new Error(`Invalid pricing rate: ${field}`);
  }
}
