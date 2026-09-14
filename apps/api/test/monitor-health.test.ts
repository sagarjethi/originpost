import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { MonitoringService } from "../src/monitoring/monitoring.service.js";
import type { OriginPostInfrastructure } from "../src/infrastructure/infrastructure.types.js";
const actor = {id:"owner",name:"Owner",role:"owner" as const};
function service(status:string, reason?:string) {
 const now = new Date().toISOString();
 return new MonitoringService({monitorRepository:{list:async()=>[{id:"m",workspaceId:"w",enabled:true,intervalMinutes:120,createdAt:now}],listRuns:async()=>[{id:"skip",status:"skipped",reason:"monitor_already_running",startedAt:now},{id:"actual",status,reason,startedAt:now}]}} as unknown as OriginPostInfrastructure);
}
describe("monitor health after overlapping checks",()=>{
 it("reports the completed collector instead of an overlapping skipped check",async()=>{
  expect((await service("completed").status("w",actor))[0]).toMatchObject({health:"healthy",lastRun:{id:"actual"},runs:expect.arrayContaining([expect.objectContaining({id:"skip"})])});
 });
 it("keeps real failures and partial failures visible",async()=>{
  expect((await service("failed").status("w",actor))[0]?.health).toBe("failed");
  expect((await service("completed","Partial source failure: Feed B").status("w",actor))[0]?.health).toBe("degraded");
 });
});
