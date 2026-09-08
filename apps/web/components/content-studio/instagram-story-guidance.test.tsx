import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InstagramStoryDeliveryGuidance, InstagramStoryInternalCopyNote } from "./instagram-story-guidance";

describe("Instagram Story guidance", () => {
  it("marks Story copy as internal and never a published caption", () => {
    const markup = renderToStaticMarkup(<InstagramStoryInternalCopyNote id="story-copy-note" />);
    expect(markup).toContain("story-copy-note");
    expect(markup).toContain("Internal only");
    expect(markup).toContain("not sent as an Instagram Story caption");
  });

  it("distinguishes interactive manual handoff from basic auto publish", () => {
    const manual = renderToStaticMarkup(<InstagramStoryDeliveryGuidance mode="manual_handoff" />);
    const automatic = renderToStaticMarkup(<InstagramStoryDeliveryGuidance mode="auto_publish" />);
    expect(manual).toContain("Manual handoff · interactive Stories");
    expect(manual).toContain("link, music, poll, location, and mention stickers");
    expect(manual).toContain("records publish proof");
    expect(automatic).toContain("Auto publish · basic Story only");
    expect(automatic).toContain("No link, music, poll, location, mention");
  });
});
