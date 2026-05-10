/**
 * Strip markdown formatting from text, leaving plain words for search indexing.
 */
export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build searchText field value from title + content.
 */
export function buildSearchText(title: string, content: string): string {
  return title.toLowerCase() + " " + stripMarkdown(content).toLowerCase();
}

// ─── Snippet generation ──────────────────────────────────────────────────────

export type SnippetSegment = {
  text: string;
  highlighted: boolean;
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Generate a snippet around the first match of `query` in `text`.
 * Returns an array of segments with highlight flags (no raw HTML).
 */
export function generateSnippet(
  text: string,
  query: string | undefined,
  maxLength = 250,
): SnippetSegment[] {
  if (!query || query.length < 2) {
    const slice =
      text.length > maxLength ? text.slice(0, maxLength) + "..." : text;
    return [{ text: slice, highlighted: false }];
  }

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matchIndex = lowerText.indexOf(lowerQuery);

  if (matchIndex === -1) {
    const slice =
      text.length > maxLength ? text.slice(0, maxLength) + "..." : text;
    return [{ text: slice, highlighted: false }];
  }

  const contextChars = Math.floor((maxLength - query.length) / 2);
  const start = Math.max(0, matchIndex - contextChars);
  const end = Math.min(
    text.length,
    matchIndex + lowerQuery.length + contextChars,
  );

  const snippet = text.slice(start, end);
  const snippetLower = snippet.toLowerCase();

  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";

  // Split snippet into segments by all occurrences of query
  const segments: SnippetSegment[] = [];
  const regex = new RegExp(`(${escapeRegex(query)})`, "gi");
  let lastIndex = 0;

  if (prefix) segments.push({ text: prefix, highlighted: false });

  let match: RegExpExecArray | null;
  while ((match = regex.exec(snippetLower)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        text: snippet.slice(lastIndex, match.index),
        highlighted: false,
      });
    }
    segments.push({
      text: snippet.slice(match.index, match.index + match[1]!.length),
      highlighted: true,
    });
    lastIndex = match.index + match[1]!.length;
  }

  if (lastIndex < snippet.length) {
    segments.push({ text: snippet.slice(lastIndex), highlighted: false });
  }

  if (suffix) segments.push({ text: suffix, highlighted: false });

  return segments;
}
