import { describe, expect, it, vi } from "vitest";
import { saveContentIntake } from "./content-intake";
const input={workspaceId:"w",brandId:"b",title:"News",summary:"Notes",researchNow:true};
describe("content intake receipts",()=>{
  it("retains the real saved item when research fails",async()=>{
    const request=vi.fn().mockResolvedValueOnce(Response.json({id:"saved",version:1})).mockRejectedValueOnce(new Error("Offline"));
    expect(await saveContentIntake(input,request)).toMatchObject({item:{id:"saved"},warning:expect.stringContaining("content is saved")});
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("never fabricates a local item when saving fails",async()=>{
    const request=vi.fn().mockResolvedValue(Response.json({message:"Not allowed"},{status:403}));
    await expect(saveContentIntake(input,request)).rejects.toThrow("Not allowed");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("makes an uncertain network save visible without automatically retrying",async()=>{
    const request=vi.fn().mockRejectedValue(new Error("connection lost"));
    await expect(saveContentIntake(input,request)).rejects.toThrow("could not be confirmed");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("uses the saved version and returns the research receipt",async()=>{
    const request=vi.fn().mockResolvedValueOnce(Response.json({id:"saved",version:3})).mockResolvedValueOnce(Response.json({id:"saved",version:4}));
    expect(await saveContentIntake(input,request)).toEqual({item:{id:"saved",version:4}});
    expect(request.mock.calls[1]?.[1].headers["if-match"]).toBe("3");
  });
});
