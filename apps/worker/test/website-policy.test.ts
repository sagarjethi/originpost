import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), launch: vi.fn() }));
vi.mock("@originpost/agents", async (original) => ({ ...await original<object>(), fetchPublicResource: mocks.fetch }));
vi.mock("playwright", () => ({ chromium: { launch: mocks.launch } }));
import { capturePublicWebsite } from "../src/website-sourcing.js";

it("reports unavailable robots policy before launching Chrome", async () => {
  mocks.fetch.mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"));
  await expect(capturePublicWebsite("https://publisher.example/news")).rejects.toMatchObject({
    code: "robots_unavailable",
    message: expect.stringContaining("No page was collected"),
  });
  expect(mocks.launch).not.toHaveBeenCalled();
});
