import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mobileShareDraftChoices } from "./mobile-share-capture-utils";

const image = { kind: "image" as const, fileName: "phone.jpg", declaredContentType: "image/jpeg", detectedContentType: "image/jpeg", sizeBytes: 120, sha256: "a".repeat(64), inspectionStatus: "ready" as const, widthPixels: 1080, heightPixels: 1920 };

describe("mobile media Share Capture web contract", () => {
  it("shows only formats supported by exact server-inspected facts", () => {
    expect(mobileShareDraftChoices(image).map((choice) => choice.value)).toEqual(["instagram:image", "facebook:image", "instagram:story"]);
    expect(mobileShareDraftChoices({ ...image, detectedContentType: "image/png" }).map((choice) => choice.value)).toEqual(["instagram:image", "facebook:image"]);
    expect(mobileShareDraftChoices({ ...image, inspectionStatus: "failed" })).toEqual([]);
  });

  it("limits video destinations by shape and duration", () => {
    const video = { ...image, kind: "video" as const, fileName: "phone.mp4", declaredContentType: "video/mp4", detectedContentType: "video/mp4", durationMs: 45_000 };
    expect(mobileShareDraftChoices(video).map((choice) => choice.value)).toEqual(["instagram:reel", "instagram:story", "youtube:short"]);
    expect(mobileShareDraftChoices({ ...video, widthPixels: 1920, heightPixels: 1080, durationMs: 200_000 }).map((choice) => choice.value)).toEqual(["instagram:reel"]);
  });

  it("keeps private object, claim, and provider fields out of the browser contract", () => {
    const source = readFileSync(new URL("./mobile-share-capture.tsx", import.meta.url), "utf8");
    for (const forbidden of ["quarantineObjectKey", "materializationClaimOwner", "materializationClaimExpiresAt", "objectKey:", "providerMessageId"]) expect(source).not.toContain(forbidden);
    expect(source).toContain("No post, approval, schedule, or provider write was created");
    expect(source).toContain("On iPhone, iPad, desktop, or an uninstalled browser, choose the file here");
  });

  it("has a narrow phone layout with full-width controls", () => {
    const css = readFileSync(new URL("./mobile-share-capture.module.css", import.meta.url), "utf8");
    expect(css).toContain("@media(max-width:560px)");
    expect(css).toContain("grid-template-columns:minmax(0,1fr)");
    expect(css).toContain("min-height:50px");
  });
});
