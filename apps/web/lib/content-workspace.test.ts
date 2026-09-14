import { expect, it } from "vitest";
import { belongsToContentWorkspace } from "./content-workspace";
it("keeps unverified inbox items out of Proof and unsourced items out of Research",()=>{
  const inbox={sources:[],researchRuns:[],proofs:[]};
  expect(belongsToContentWorkspace("Content",inbox)).toBe(true);
  expect(belongsToContentWorkspace("Proof",inbox)).toBe(false);
  expect(belongsToContentWorkspace("Research",inbox)).toBe(false);
  expect(belongsToContentWorkspace("Research",{...inbox,researchRuns:[{}]})).toBe(true);
  expect(belongsToContentWorkspace("Proof",{...inbox,proofs:[{}]})).toBe(true);
});
