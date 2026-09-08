import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import request from "supertest";

/**
 * Keep one real ephemeral listener for the lifetime of an e2e test app.
 * Supertest otherwise starts and closes an unbound Node server for every
 * request, which races connection teardown and ephemeral-port reuse when
 * Vitest executes several e2e files in parallel.
 */
export async function startE2eApp(app: NestFastifyApplication): Promise<void> {
  await app.init();
  await app.listen(0, "127.0.0.1");
  await app.getHttpAdapter().getInstance().ready();
  if (!app.getHttpServer().address()) throw new Error("The e2e test server did not bind an ephemeral listener.");
}

/**
 * Unrelated workflow tests should still exercise the public scheduling
 * contract when earlier fixtures share an account or approved draft.
 */
export async function withCurrentScheduleConflictAcknowledgement(
  app: NestFastifyApplication,
  contentItemId: string,
  body: Record<string, unknown>,
  expectedVersion?: number,
): Promise<Record<string, unknown>> {
  let preflight = request(app.getHttpServer()).post(`/v1/content-items/${contentItemId}/schedule-preflight?workspaceId=default`);
  if (expectedVersion !== undefined) preflight = preflight.set("If-Match", String(expectedVersion));
  const response = await preflight.send(body).expect(201);
  return response.body.requiresConfirmation
    ? { ...body, conflictAcknowledgementSha256: response.body.acknowledgementSha256 }
    : body;
}
