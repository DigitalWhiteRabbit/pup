import { describe, it, expect } from "vitest";
import { ANTHROPIC_MODELS } from "@/lib/services/ai-models";

// P1-B: voice summaries used "claude-haiku-4.5-..." (dot) which 404s. The
// canonical working id (tickets agent / MktConfig defaults) is the dash form.

describe("ANTHROPIC_MODELS", () => {
  it("HAIKU is the canonical working id (dash form, dated), not the 404 dot form", () => {
    expect(ANTHROPIC_MODELS.HAIKU).toBe("claude-haiku-4-5-20251001");
    expect(ANTHROPIC_MODELS.HAIKU).not.toContain("4.5"); // the broken form
    expect(ANTHROPIC_MODELS.HAIKU).toMatch(/^claude-haiku-\d-\d-\d{8}$/);
  });

  it("SONNET matches the working agent/MktConfig default", () => {
    expect(ANTHROPIC_MODELS.SONNET).toBe("claude-sonnet-4-20250514");
  });
});
