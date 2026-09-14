import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  addresses: [{ address: "8.8.8.8", family: 4 }],
  status: 200,
  headers: {} as Record<string, string>,
  body: Buffer.from("public content"),
  calls: [] as Array<{ url: URL; options: any }>,
}));
vi.mock("node:dns", () => ({
  lookup: (_host: string, _options: unknown, callback: Function) =>
    callback(null, fixture.addresses),
}));
vi.mock("node:https", () => ({
  request: (url: URL, options: any, callback: Function) => {
    fixture.calls.push({ url, options });
    const request = new EventEmitter() as EventEmitter & { end(): void };
    request.end = () =>
      options.lookup(url.hostname, { all: true }, (error: Error | null) => {
        if (error) {
          request.emit("error", error);
          return;
        }
        const response = Object.assign(new PassThrough(), {
          statusCode: fixture.status,
          headers: fixture.headers,
        });
        callback(response);
        response.end(fixture.body);
      });
    return request;
  },
}));
import { fetchPublicResource } from "../src/feed.js";
describe("bounded public resource transport", () => {
  beforeEach(() => {
    fixture.addresses = [{ address: "8.8.8.8", family: 4 }];
    fixture.status = 200;
    fixture.headers = {};
    fixture.body = Buffer.from("public content");
    fixture.calls = [];
  });
  it("pins validation to the socket lookup and sends no cookies or credentials", async () => {
    const result = await fetchPublicResource("https://publisher.example/news");
    expect(result.body.toString()).toBe("public content");
    expect(fixture.calls[0]?.options.headers).not.toHaveProperty("cookie");
    expect(fixture.calls[0]?.options.headers).not.toHaveProperty(
      "authorization",
    );
    fixture.addresses.push({ address: "10.0.0.5", family: 4 });
    await expect(
      fetchPublicResource("https://publisher.example/news"),
    ).rejects.toThrow("non-public address");
  });
  it("rejects private literals and private redirect destinations before opening a socket", async () => {
    await expect(
      fetchPublicResource("https://127.0.0.1/private"),
    ).rejects.toThrow("public HTTP");
    expect(fixture.calls).toHaveLength(0);
    fixture.status = 302;
    fixture.headers = { location: "http://169.254.169.254/latest/meta-data" };
    await expect(
      fetchPublicResource("https://publisher.example/news"),
    ).rejects.toThrow("public HTTP");
    expect(fixture.calls).toHaveLength(1);
  });
  it("keeps redirect handling available to the browser policy without following it", async () => {
    fixture.status = 302;
    fixture.headers = { location: "/new" };
    const result = await fetchPublicResource("https://publisher.example/news", {
      followRedirects: false,
    });
    expect(result).toMatchObject({
      status: 302,
      location: "https://publisher.example/new",
    });
    expect(fixture.calls).toHaveLength(1);
  });
  it("rejects oversized and compressed responses before rendering", async () => {
    fixture.headers = { "content-length": "100" };
    await expect(
      fetchPublicResource("https://publisher.example/news", { maxBytes: 10 }),
    ).rejects.toThrow("exceeds");
    fixture.headers = { "content-encoding": "gzip" };
    await expect(
      fetchPublicResource("https://publisher.example/news"),
    ).rejects.toThrow("Compressed");
  });
});
