// Anthropic per-model pricing (USD per 1M tokens) for the AI review cost calculator.
// Defaults reflect published rates (2026-06); override or extend at deploy time with
// ANTHROPIC_PRICING_JSON, e.g. {"claude-opus-4-8":{"inputPerM":5,"outputPerM":25}}.
// (Vision image tokens are already included in the API's input_tokens count.)

export interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
}

const DEFAULTS: Record<string, ModelPrice> = {
  "claude-haiku-4-5": { inputPerM: 1.0, outputPerM: 5.0 },
  "claude-sonnet-4-6": { inputPerM: 3.0, outputPerM: 15.0 },
  "claude-sonnet-5": { inputPerM: 3.0, outputPerM: 15.0 },
  "claude-opus-4-8": { inputPerM: 5.0, outputPerM: 25.0 },
  "claude-opus-4-7": { inputPerM: 5.0, outputPerM: 25.0 },
  "claude-fable-5": { inputPerM: 10.0, outputPerM: 50.0 },
};

function overrides(): Record<string, ModelPrice> {
  try {
    const raw = process.env.ANTHROPIC_PRICING_JSON;
    return raw ? (JSON.parse(raw) as Record<string, ModelPrice>) : {};
  } catch {
    return {};
  }
}

const TABLE: Record<string, ModelPrice> = { ...DEFAULTS, ...overrides() };

/** Look up a model's price, tolerating date-suffixed IDs (…-20251001). */
export function priceFor(model: string): ModelPrice | null {
  if (TABLE[model]) return TABLE[model];
  const key = Object.keys(TABLE).find((k) => model.startsWith(k));
  return key ? TABLE[key] : null;
}

/** Cost of one review in USD. Returns 0 for an unknown model (logged upstream). */
export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  if (!p) return 0;
  return (inputTokens / 1_000_000) * p.inputPerM + (outputTokens / 1_000_000) * p.outputPerM;
}
