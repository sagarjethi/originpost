import { describe, expect, it } from "vitest";
import { PasswordService } from "../src/auth/password.service.js";

describe("PasswordService", () => {
  it("hashes with a random salt and verifies without storing plaintext", async () => {
    const service = new PasswordService();
    const first = await service.hash("StrongPassword123");
    const second = await service.hash("StrongPassword123");
    expect(first).toMatch(/^scrypt\$v=1\$N=16384\$r=8\$p=1\$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain("StrongPassword123");
    await expect(service.verify("StrongPassword123", first)).resolves.toBe(true);
    await expect(service.verify("WrongPassword123", first)).resolves.toBe(false);
    await expect(service.verify("StrongPassword123", "disabled")).resolves.toBe(false);
  });
});
