import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SourceEvidenceCard } from "./source-evidence-card";
it("shows the actual excerpt check without claiming whole-story verification", () => {
  const html = renderToStaticMarkup(
    <SourceEvidenceCard
      source={{
        id: "s",
        title: "Official release",
        url: "https://example.org",
        confidence: 100,
        retrieval: {
          status: "mismatch",
          checkedAt: "2026-09-15T00:00:00Z",
          reason: "Quote was not found.",
        },
      }}
    />,
  );
  expect(html).toContain("Excerpt did not match");
  expect(html).toContain("Quote was not found.");
  expect(html).not.toContain("100% confidence");
  expect(html).not.toContain("Excerpt match recorded");
});
it("does not render unsafe source links", () => {
  const html = renderToStaticMarkup(
    <SourceEvidenceCard
      source={{
        id: "s",
        title: "Source",
        url: "javascript:alert(1)",
        confidence: 0,
      }}
    />,
  );
  expect(html).not.toContain("href=");
  expect(html).toContain("No independent page check recorded");
});
it("exposes bounded reviewer context as escaped source text", () => {
  const html = renderToStaticMarkup(<SourceEvidenceCard source={{id:"s",title:"Source",confidence:80,retrieval:{status:"matched",checkedAt:"2026-09-15T00:00:00Z",context:"<script>untrusted source</script>",contextTruncated:true}}}/>);
  expect(html).toContain("Source text supplied to the reviewers");
  expect(html).toContain("limited window");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
});
