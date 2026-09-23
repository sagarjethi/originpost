import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SourceGenerationGuide } from "./source-generation-guide";

it("distinguishes Instagram publishing from discovery and names the draft review step", () => {
  const html = renderToStaticMarkup(<SourceGenerationGuide brandName="Gujarat News" canConfigure />);
  expect(html).toContain("Gujarat News");
  expect(html).toContain("It does not monitor other Instagram profiles");
  expect(html).toContain("Opening a report does not start generation or publish it");
  expect(html).toContain("Codex image upload workflow");
  expect(html).toContain('href="/channels"');
  expect(html).toContain('href="/setup?provider=images"');
});

it("keeps configuration links out of creator guidance", () => {
  const html = renderToStaticMarkup(<SourceGenerationGuide brandName="" canConfigure={false} />);
  expect(html).toContain("Selected brand");
  expect(html).toContain("workspace owner");
  expect(html).not.toContain('href="/agent-plugins"');
  expect(html).not.toContain('href="/setup');
});
