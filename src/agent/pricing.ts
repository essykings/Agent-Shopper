// What a model run costs, so spending can be limited. List prices per million tokens from the Claude API
// guide, for prompts up to 100K tokens (which this agent stays under). An estimate, not a bill: check the
// Anthropic Console for the real figure.

export interface Price {
  input: number;
  output: number;
}

export const PRICES_USD_PER_MILLION: Record<string, Price> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-opus-5-5": { input: 4, output: 20 },
};

/** For a model not in the table: the highest price in the guide, so an unknown model never looks cheap. */
const CAUTIOUS: Price = { input: 10, output: 50 };

export const priceFor = (model: string): Price => PRICES_USD_PER_MILLION[model] ?? CAUTIOUS;

/** Millionths of a dollar. A price of $X per million tokens is X millionths of a dollar per token. */
export function costMicroUsd(model: string, usage: { inputTokens: number; outputTokens: number }): number {
  const p = priceFor(model);
  return Math.ceil(usage.inputTokens * p.input + usage.outputTokens * p.output);
}

/** The most a run can cost if it uses its whole token cap at the dearer rate. */
export function worstCaseMicroUsd(model: string, tokenCap: number): number {
  const p = priceFor(model);
  return Math.ceil(tokenCap * Math.max(p.input, p.output));
}
