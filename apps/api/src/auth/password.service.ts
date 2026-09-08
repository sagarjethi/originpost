import { Injectable } from "@nestjs/common";
import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";

const KEY_BYTES = 32;
const COST = 16_384;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;

function derive(password: string, salt: Buffer, length: number, cost = COST, blockSize = BLOCK_SIZE, parallelism = PARALLELISM): Promise<Buffer> {
  return new Promise((resolve, reject) => nodeScrypt(password, salt, length, { N: cost, r: blockSize, p: parallelism, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}

@Injectable()
export class PasswordService {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await derive(password, salt, KEY_BYTES);
    return `scrypt$v=1$N=${COST}$r=${BLOCK_SIZE}$p=${PARALLELISM}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
  }

  async verify(password: string, encoded: string): Promise<boolean> {
    const parts = encoded.split("$");
    if (parts.length !== 7 || parts[0] !== "scrypt" || parts[1] !== "v=1") return false;
    const cost = Number(parts[2]?.split("=")[1]);
    const blockSize = Number(parts[3]?.split("=")[1]);
    const parallelism = Number(parts[4]?.split("=")[1]);
    if (cost !== COST || blockSize !== BLOCK_SIZE || parallelism !== PARALLELISM) return false;
    try {
      const salt = Buffer.from(parts[5]!, "base64url");
      const expected = Buffer.from(parts[6]!, "base64url");
      if (salt.length !== 16 || expected.length !== KEY_BYTES) return false;
      const actual = await derive(password, salt, expected.length, cost, blockSize, parallelism);
      return timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }
}
