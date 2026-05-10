import { describe, it, expect } from "vitest";
import {
  stripMarkdown,
  buildSearchText,
  generateSnippet,
} from "@/lib/services/kb/utils";

// ─── stripMarkdown ───────────────────────────────────────────────────────────

describe("stripMarkdown", () => {
  it("removes code blocks", () => {
    const md = "before ```code here``` after";
    expect(stripMarkdown(md)).toBe("before after");
  });

  it("removes header markers", () => {
    expect(stripMarkdown("## Hello World")).toBe("Hello World");
    expect(stripMarkdown("### Sub")).toBe("Sub");
  });

  it("converts links to text", () => {
    expect(stripMarkdown("[Click here](https://example.com)")).toBe(
      "Click here",
    );
  });

  it("removes bold/italic markers", () => {
    expect(stripMarkdown("**bold** and _italic_")).toBe("bold and italic");
  });

  it("removes inline code backticks", () => {
    expect(stripMarkdown("use `npm install`")).toBe("use npm install");
  });

  it("removes blockquotes", () => {
    expect(stripMarkdown("> quoted text")).toBe("quoted text");
  });

  it("removes list markers", () => {
    expect(stripMarkdown("- item one\n- item two")).toBe("item one item two");
  });

  it("removes HTML tags", () => {
    expect(stripMarkdown("<p>Hello</p>")).toBe("Hello");
  });
});

// ─── buildSearchText ─────────────────────────────────────────────────────────

describe("buildSearchText", () => {
  it("combines lowercased title and stripped content", () => {
    const result = buildSearchText("My Article", "## Hello **world**");
    expect(result).toBe("my article hello world");
  });
});

// ─── generateSnippet ─────────────────────────────────────────────────────────

describe("generateSnippet", () => {
  it("returns start of text when query is empty", () => {
    const segments = generateSnippet("Some long text content here", undefined);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.highlighted).toBe(false);
    expect(segments[0]!.text).toBe("Some long text content here");
  });

  it("returns start of text when query is too short", () => {
    const segments = generateSnippet("Some text", "a");
    expect(segments).toHaveLength(1);
    expect(segments[0]!.highlighted).toBe(false);
  });

  it("highlights matching word in snippet", () => {
    const text =
      "This is a document about TypeScript and JavaScript programming";
    const segments = generateSnippet(text, "TypeScript");

    const highlighted = segments.filter((s) => s.highlighted);
    expect(highlighted.length).toBeGreaterThanOrEqual(1);
    expect(highlighted[0]!.text.toLowerCase()).toBe("typescript");
  });

  it("case-insensitive matching", () => {
    const segments = generateSnippet("Hello World", "hello");
    const highlighted = segments.filter((s) => s.highlighted);
    expect(highlighted.length).toBe(1);
    expect(highlighted[0]!.text).toBe("Hello");
  });

  it("handles regex special chars in query (e.g. C++)", () => {
    const text = "Programming in C++ is fun";
    const segments = generateSnippet(text, "C++");
    const highlighted = segments.filter((s) => s.highlighted);
    expect(highlighted.length).toBe(1);
    expect(highlighted[0]!.text).toBe("C++");
  });

  it("returns non-highlighted snippet when query not found", () => {
    const segments = generateSnippet("Hello world", "xyz", 50);
    expect(segments.every((s) => !s.highlighted)).toBe(true);
  });

  it("adds ellipsis for long text", () => {
    const text = "x".repeat(500);
    const segments = generateSnippet(text, undefined, 100);
    expect(segments[0]!.text.endsWith("...")).toBe(true);
  });

  it("generates snippet around match position", () => {
    const prefix = "A".repeat(200);
    const suffix = "B".repeat(200);
    const text = `${prefix} KEYWORD ${suffix}`;
    const segments = generateSnippet(text, "KEYWORD", 250);

    // Should have ellipsis prefix since match is deep in text
    const fullText = segments.map((s) => s.text).join("");
    expect(fullText).toContain("...");

    const highlighted = segments.filter((s) => s.highlighted);
    expect(highlighted.length).toBe(1);
    expect(highlighted[0]!.text).toBe("KEYWORD");
  });
});
