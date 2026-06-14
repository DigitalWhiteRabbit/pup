/**
 * Canonical Anthropic model IDs — single source of truth so calls don't drift
 * or typo the id (the voice summary used "claude-haiku-4.5-..." with a dot,
 * which 404s). These match the working values used by the tickets AI agent and
 * the MktConfig schema defaults.
 *
 * Per-workspace AI config (AgentConfig.model, MktConfig.claudeModel*) overrides
 * these where the user chose a model; use these as the default/fallback and for
 * calls that have no per-workspace config (e.g. voice summaries).
 */
export const ANTHROPIC_MODELS = {
  HAIKU: "claude-haiku-4-5-20251001",
  SONNET: "claude-sonnet-4-20250514",
} as const;

export type AnthropicModel =
  (typeof ANTHROPIC_MODELS)[keyof typeof ANTHROPIC_MODELS];
