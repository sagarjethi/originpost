import { createHmac } from "node:crypto";

export interface ProviderLookupKeyring {
  activeVersion: string;
  keys: Map<string, Buffer>;
}

function decodeKey(value: string): Buffer {
  const decoded = /^[a-f0-9]{64,}$/i.test(value) && value.length % 2 === 0 ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (decoded.length < 32) throw new Error("Provider lookup HMAC keys must decode to at least 32 bytes.");
  return decoded;
}

export function parseProviderLookupKeyring(serialized: string, activeVersion: string): ProviderLookupKeyring {
  const keys = new Map<string, Buffer>();
  for (const entry of serialized.split(",").map((value) => value.trim()).filter(Boolean)) {
    const separator = entry.indexOf(":");
    if (separator < 1) throw new Error("PROVIDER_LOOKUP_HMAC_KEYS must contain version:key entries.");
    const version = entry.slice(0, separator);
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(version) || keys.has(version)) throw new Error("Provider lookup HMAC key versions must be unique safe identifiers.");
    keys.set(version, decodeKey(entry.slice(separator + 1)));
  }
  if (!keys.has(activeVersion)) throw new Error("PROVIDER_LOOKUP_HMAC_ACTIVE_VERSION must name a configured key.");
  return { activeVersion, keys };
}

export function providerLookupHmacAtVersion(keyring: ProviderLookupKeyring, version: string, provider: "meta" | "google", clientId: string, value: string): string {
  const key = keyring.keys.get(version);
  if (!key) throw new Error("The provider lookup key version is unavailable.");
  return createHmac("sha256", key).update(`${provider}\0${clientId}\0${value}`).digest("hex");
}

export function providerLookupHmac(keyring: ProviderLookupKeyring, provider: "meta" | "google", clientId: string, value: string): { version: string; digest: string } {
  return { version: keyring.activeVersion, digest: providerLookupHmacAtVersion(keyring, keyring.activeVersion, provider, clientId, value) };
}

export function providerLookupCandidates(keyring: ProviderLookupKeyring, provider: "meta" | "google", clientId: string, value: string): Array<{ version: string; digest: string }> {
  return [...keyring.keys].map(([version]) => ({ version, digest: providerLookupHmacAtVersion(keyring, version, provider, clientId, value) }));
}
