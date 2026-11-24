import assert from "node:assert/strict";
import { createCostEstimator, MODEL_PRICING, PRICING_AS_OF, PRICING_FILE, type ModelPricing, type PricingUsage } from "../src/history/model-pricing.ts";

const estimate = createCostEstimator();
const usage = (model: string | undefined, changes: Partial<PricingUsage> = {}): PricingUsage => ({
  model, input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0, cache_write_12h: 0, ...changes,
});
function cost(model: string, changes: Partial<PricingUsage>, expected: number, currency = "USD"): void {
  const result = estimate(usage(model, changes));
  assert.equal(result.status, "priced");
  if (result.status !== "priced") throw new Error("Expected a priced estimate");
  assert.equal(result.currency, currency);
  assert.ok(Math.abs(result.total - expected) < 1e-12, `${model}: ${result.total} versus ${expected}`);
}

assert.equal(PRICING_AS_OF, "2026-11-24"); assert.equal(PRICING_FILE, "src/history/model-pricing.ts");
cost("gpt-6.1-sol", { input: 3, output: 68, cache_write: 7833 }, 0.0202685);
cost("gpt-6.1-sol", { input: 10, output: 20, cache_read: 30, cache_write: 40 }, 0.000323);
cost("gpt-6.1-sol", { cache_read: 272000, output: 100 }, 0.0282);
cost("gpt-6.1-sol", { input: 1, cache_read: 272000, output: 100 }, 0.055904);
cost("gpt-6.1-sol", { cache_write: 200, cache_write_12h: 100 }, 0.00075);
cost("gpt-6.1-sol", { cache_write: 272001, cache_write_12h: 272001 }, 2.72001);
cost("claude-sonnet-4-6", { cache_write: 200, cache_write_1h: 100 }, 0.000975);
cost("anthropic--claude-4.6-sonnet", { input: 300000, output: 10 }, 0.90015);
cost("glm-5.3", { input: 100, output: 10, cache_read: 200 }, 0.00148, "CNY");
cost("glm-5.3-flash", { input: 100, output: 10, cache_read: 200 }, 0.000154, "CNY");
cost("gpt-6-luna", { input: 100, output: 100, cache_read: 100, cache_write: 100 }, 0.0000735);
cost("gpt-6-luna", { cache_write: 100, cache_write_12h: 100 }, 0.000025);
cost("gpt-6-luna", { input: 1, output: 100, cache_read: 272000 }, 0.0055152);
for (const [model, dollars] of [["gpt-6-luna", 0.01], ["gpt-5.6-sol", 0.4], ["gpt-5.6-terra", 0.2], ["gpt-5.6-luna", 0.02]] as const) cost(model, { input: 100000 }, dollars);
for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
  assert.deepEqual(estimate(usage(model, { input: 100 })), estimate(usage(`${model}-2026-07-09`, { input: 100 })));
}
for (const model of [undefined, "unknown", "qwen-flash", "gpt-6.1-sol-new-snapshot", "unlisted-model"]) {
  const result = estimate(usage(model, { input: 100 }));
  assert.equal(result.status, "unpriced"); assert.equal(Object.hasOwn(result, "total"), false);
}
assert.match((estimate(usage("qwen-flash")) as { reason: string }).reason, /region and cache mode/);
assert.equal(estimate(usage("gpt-6.1-sol", { cache_write: 1, cache_write_1h: 1 })).status, "unpriced");
assert.equal(estimate(usage("claude-sonnet-4-6", { cache_write: 1, cache_write_12h: 1 })).status, "unpriced");
assert.deepEqual(estimate(usage("gpt-6.1-sol")), { status: "priced", currency: "USD", total: 0 });
for (const field of ["input", "output", "cache_read", "cache_write", "cache_write_1h", "cache_write_12h"] as const) {
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => estimate(usage("gpt-6.1-sol", { [field]: value })), /Invalid pricing token count/);
}
assert.throws(() => estimate(usage("gpt-6.1-sol", { input: Number.MAX_SAFE_INTEGER, output: 1 })), /safe integers/);
assert.throws(() => estimate(usage("gpt-6.1-sol", { cache_write: 1, cache_write_1h: 1, cache_write_12h: 1 })), /subsets/);
assert.throws(() => estimate(usage("")), /Invalid pricing model ID/);

const edited = structuredClone(MODEL_PRICING) as ModelPricing[];
edited[0].rates.input = 7;
assert.deepEqual(createCostEstimator(edited)(usage("gpt-6.1-sol", { input: 1000000 })), { status: "priced", currency: "USD", total: 4 });
// This request uses the long tier. A small request proves the edited base rate also takes effect.
assert.deepEqual(createCostEstimator(edited)(usage("gpt-6.1-sol", { input: 1000 })), { status: "priced", currency: "USD", total: 0.007 });
for (const field of ["input", "output", "cache_read", "cache_write", "cache_write_1h", "cache_write_12h"] as const) {
  for (const value of [-1, NaN, Infinity]) {
    const invalid = structuredClone(MODEL_PRICING) as ModelPricing[];
    invalid[0].rates[field] = value;
    assert.throws(() => createCostEstimator(invalid), /Invalid pricing rate/);
  }
}
const invalidTier = structuredClone(MODEL_PRICING) as ModelPricing[];
invalidTier[0].long_context!.input_above = -1;
assert.throws(() => createCostEstimator(invalidTier), /input threshold/);
assert.throws(() => createCostEstimator([MODEL_PRICING[0], MODEL_PRICING[0]]), /duplicate pricing model/);
assert.throws(() => createCostEstimator([{ ...MODEL_PRICING[0], sources: [] }]), /sources/);
const huge: ModelPricing = { models: ["huge"], currency: "USD", rates: { input: Number.MAX_VALUE, output: 0, cache_read: 0, cache_write: 0 }, sources: ["https://example.org/pricing"] };
assert.throws(() => createCostEstimator([huge])(usage("huge", { input: 2 })), /calculated model cost/);
console.log("model-pricing.test.ts: independent editable price snapshot, exact model aliases, request-level long-context tiers, cache lifetime subsets, separate currencies, explicit unpriced usage and strict validation passed");
