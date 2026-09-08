import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("workspace AI runtime migration",()=>{
  it("keeps secrets out of profile JSON and scopes assignments to workspace brands",()=>{const sql=readFileSync(new URL("../migrations/043_workspace_agent_runtime.sql",import.meta.url),"utf8");expect(sql).toContain("credential_ciphertext text");expect(sql).toContain("agent_runtime_credential_shape");expect(sql).toContain("foreign key (workspace_id,brand_id) references brands(workspace_id,id)");expect(sql).toContain("request_sha256");expect(sql).not.toMatch(/api_key\s+text/i);});
});
