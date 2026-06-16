import { describe, it, expect } from "vitest";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

// Verifies the rehype-sanitize schema used by components/kb/MarkdownPreview.tsx
// neutralizes XSS in untrusted KB markdown (imported from external sites) while
// leaving legitimate links/markup intact. This is the PRIMARY render-layer guard
// for article-view + import preview.

// Same schema as MarkdownPreview: defaultSchema + keep className (highlighting).
const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "className"],
  },
};

type HastNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
};

function sanitize(tree: HastNode): HastNode {
  // rehypeSanitize(schema) returns a transformer (tree) => cleanTree.
  return rehypeSanitize(schema as never)(tree as never) as unknown as HastNode;
}

function el(
  tagName: string,
  properties: Record<string, unknown> = {},
  children: HastNode[] = [],
): HastNode {
  return { type: "element", tagName, properties, children };
}

function root(...children: HastNode[]): HastNode {
  return { type: "root", children };
}

function findAll(node: HastNode, tag: string): HastNode[] {
  const out: HastNode[] = [];
  const walk = (n: HastNode) => {
    if (n.tagName === tag) out.push(n);
    n.children?.forEach(walk);
  };
  walk(node);
  return out;
}

describe("KB markdown sanitize schema (MarkdownPreview render guard)", () => {
  it("drops javascript: links but keeps https links", () => {
    const out = sanitize(
      root(
        el("a", { href: "javascript:alert(1)" }, [
          { type: "text", value: "evil" },
        ]),
        el("a", { href: "https://example.com/article" }, [
          { type: "text", value: "ok" },
        ]),
      ),
    );
    const links = findAll(out, "a");
    expect(links).toHaveLength(2);
    // javascript: scheme stripped from href
    expect(links[0]!.properties?.["href"]).toBeUndefined();
    // legitimate https link preserved
    expect(links[1]!.properties?.["href"]).toBe("https://example.com/article");
  });

  it("drops data: URLs", () => {
    const out = sanitize(
      root(
        el("a", { href: "data:text/html,<script>alert(1)</script>" }, [
          { type: "text", value: "x" },
        ]),
      ),
    );
    expect(findAll(out, "a")[0]!.properties?.["href"]).toBeUndefined();
  });

  it("strips inline event handlers (onerror/onclick) from img", () => {
    const out = sanitize(
      root(
        el("img", {
          src: "https://x/y.png",
          onError: "alert(1)",
          onClick: "x()",
        }),
      ),
    );
    const img = findAll(out, "img")[0];
    expect(img).toBeDefined();
    expect(img!.properties?.["onError"]).toBeUndefined();
    expect(img!.properties?.["onClick"]).toBeUndefined();
    // legitimate src kept
    expect(img!.properties?.["src"]).toBe("https://x/y.png");
  });

  it("removes <script> / <iframe> elements entirely", () => {
    const out = sanitize(
      root(
        el("script", {}, [{ type: "text", value: "alert(1)" }]),
        el("iframe", { src: "https://evil/" }),
        el("p", {}, [{ type: "text", value: "safe" }]),
      ),
    );
    expect(findAll(out, "script")).toHaveLength(0);
    expect(findAll(out, "iframe")).toHaveLength(0);
    // benign content survives
    expect(findAll(out, "p")).toHaveLength(1);
  });

  it("preserves legitimate formatting + className (code highlighting)", () => {
    const out = sanitize(
      root(
        el("h2", {}, [{ type: "text", value: "Заголовок" }]),
        el("code", { className: ["language-ts"] }, [
          { type: "text", value: "const x = 1;" },
        ]),
      ),
    );
    expect(findAll(out, "h2")).toHaveLength(1);
    const code = findAll(out, "code")[0];
    expect(code!.properties?.["className"]).toEqual(["language-ts"]);
  });
});
