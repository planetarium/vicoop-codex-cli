import type { AccountSelector } from "./types.js";
import { RandomSelector } from "./random.js";
import { BurnRateSelector } from "./burn-rate.js";

export type SelectorFactory = () => AccountSelector;

export const DEFAULT_STRATEGY = "random";

const registry = new Map<string, SelectorFactory>();

/**
 * Register a selection strategy under a name. This is the seam for extending
 * selection later (round-robin, least-recently-used, quota/health-aware): add a
 * class implementing {@link AccountSelector}, register it here, done.
 */
export function registerSelector(name: string, factory: SelectorFactory): void {
  registry.set(name, factory);
}

export function listStrategies(): string[] {
  return Array.from(registry.keys()).sort();
}

export function hasStrategy(name: string): boolean {
  return registry.has(name);
}

registerSelector(DEFAULT_STRATEGY, () => new RandomSelector());
registerSelector("burn-rate", () => new BurnRateSelector());

/**
 * Resolve a strategy name to a selector instance. Unknown names fall back to
 * the default (with a stderr warning) so a typo in config never breaks calls.
 */
export function getSelector(name: string): AccountSelector {
  const factory = registry.get(name);
  if (factory) return factory();
  process.stderr.write(
    `[accounts] unknown selection strategy ${JSON.stringify(name)}; ` +
      `falling back to ${DEFAULT_STRATEGY}. Known: ${listStrategies().join(", ")}\n`,
  );
  return registry.get(DEFAULT_STRATEGY)!();
}
