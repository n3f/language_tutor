import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { parseGuide, MarkdownBody } from "@/lib/markdown-guide";
// The Guide content lives in src/content/instructions.md so it can be edited
// without touching JSX. Vite's `?raw` query inlines it as a string at build
// time — no runtime fetch, no separate bundle.
import instructionsMarkdown from "@/content/instructions.md?raw";

export const Route = createFileRoute("/instructions")({
  head: () => ({
    meta: [
      { title: "Setup Guide — AI-powered Language Practice" },
      { name: "description", content: "How to set up and use the app" },
    ],
  }),
  component: InstructionsPage,
});

function InstructionsPage() {
  const guide = useMemo(() => parseGuide(instructionsMarkdown), []);

  return (
    <div className="mx-auto max-w-lg px-4 py-6 lg:max-w-3xl">
      <h1 className="text-xl font-bold text-foreground">{guide.title}</h1>
      {guide.intro && (
        <div className="mt-1 text-sm text-muted-foreground">
          <MarkdownBody>{guide.intro}</MarkdownBody>
        </div>
      )}

      <Accordion type="multiple" className="mt-6">
        {guide.sections.map((section, i) => (
          <AccordionItem key={i} value={`section-${i}`}>
            <AccordionTrigger>{section.heading}</AccordionTrigger>
            <AccordionContent>
              <div className="space-y-3 text-sm text-muted-foreground">
                <MarkdownBody>{section.body}</MarkdownBody>
              </div>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  );
}
