/**
 * Shared helpers for rendering long-form markdown content (the Guide page
 * `src/content/instructions.md` and the Settings page setup section
 * `src/content/setup-guide.md`) in a consistent way.
 *
 * Both pages use the same conventions:
 * - `# H1` — page title (the consumer may render or skip this).
 * - First paragraph after the H1 — intro / subtitle.
 * - `## H2` — accordion section heading. Body runs until the next `## H2`.
 * - Body markdown supports bold, links, ordered/unordered lists, and
 *   `> 💡 …` tip-box blockquotes (rendered as a styled div, not a default
 *   `<blockquote>`).
 *
 * Keeping this in one place avoids drift when we tweak styling and lets the
 * Settings page's Setup Guide and the Guide page itself share their visual
 * conventions.
 */

import ReactMarkdown, { type Components } from "react-markdown";

export interface ParsedGuide {
  title: string;
  intro: string;
  sections: { heading: string; body: string }[];
}

/** Parse a markdown string into a title (# H1), intro paragraph (any text
 * between the H1 and the first H2), and a list of accordion sections (each
 * `## H2` heading and its body until the next `## H2`). */
export function parseGuide(md: string): ParsedGuide {
  const lines = md.split("\n");
  let title = "";
  const introLines: string[] = [];
  const sections: { heading: string; body: string }[] = [];
  let current: { heading: string; bodyLines: string[] } | null = null;

  for (const line of lines) {
    if (line.startsWith("# ") && !title) {
      title = line.slice(2).trim();
      continue;
    }
    if (line.startsWith("## ")) {
      if (current) {
        sections.push({ heading: current.heading, body: current.bodyLines.join("\n").trim() });
      }
      current = { heading: line.slice(3).trim(), bodyLines: [] };
      continue;
    }
    if (current) {
      current.bodyLines.push(line);
    } else if (title) {
      introLines.push(line);
    }
  }
  if (current) {
    sections.push({ heading: current.heading, body: current.bodyLines.join("\n").trim() });
  }

  return { title, intro: introLines.join("\n").trim(), sections };
}

/** Component overrides for ReactMarkdown that match the existing JSX styling
 * (Tailwind classes for paragraphs, lists, links, and the tip-box blockquotes). */
export const markdownComponents: Components = {
  p: ({ children }) => <p>{children}</p>,
  ol: ({ children }) => <ol className="list-decimal space-y-2 pl-5">{children}</ol>,
  ul: ({ children }) => <ul className="list-disc space-y-2 pl-5">{children}</ul>,
  li: ({ children }) => <li>{children}</li>,
  strong: ({ children }) => <strong>{children}</strong>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline">
      {children}
    </a>
  ),
  // Tip boxes are written as `> 💡 …` blockquotes in the markdown. Render
  // them as a styled div instead of a default <blockquote> so the existing
  // rounded/accent/tip-box look is preserved.
  blockquote: ({ children }) => (
    <div className="rounded-md bg-accent px-3 py-2 text-xs">{children}</div>
  ),
};

/** Convenience: render a single markdown string through ReactMarkdown with
 * the shared component overrides. */
export function MarkdownBody({ children }: { children: string }) {
  return <ReactMarkdown components={markdownComponents}>{children}</ReactMarkdown>;
}
