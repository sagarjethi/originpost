import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { GenerationChoices } from "./generation-launcher";

it("offers explicit generation tools without exposing provider controls to creators", () => {
  const html = renderToStaticMarkup(<GenerationChoices brandName="News project" canConfigure={false} />);
  for (const label of ["News project", "Text + image", "Generate text", "Generate an image", "Generate voice", "Browse source updates"]) expect(html).toContain(label);
  expect(html).not.toContain("AI providers");
  expect(html).toContain('href="/create?compose=new"');
  expect(html).toContain("Generation starts after you submit a brief");
});

it("identifies selected content and offers provider setup to owners", () => {
  const html = renderToStaticMarkup(<GenerationChoices brandName="News project" canConfigure content={{ id: "post-fixture", title: "Local weather" }} />);
  expect(html).toContain("Selected post: Local weather");
  expect(html).toContain("Write a caption for the selected post");
  expect(html).toContain("AI providers");
  expect(html).toContain('href="/create?item=post-fixture"');
  expect(html).toContain('href="/creative-studio?item=post-fixture"');
  expect(html).toContain('href="/agent"');
});
