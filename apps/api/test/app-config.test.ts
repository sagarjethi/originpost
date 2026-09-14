import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/app.module.js";

const productionMetaConfig={NODE_ENV:"production",AUTH_MODE:"single-user",DATABASE_URL:"postgres://example",REVIEW_LINK_SECRET:"r".repeat(32),META_APP_ID:"app-1",META_APP_SECRET:"secret",META_GRAPH_API_VERSION:"v26.0",CREDENTIAL_ENCRYPTION_KEY:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",PROVIDER_LOOKUP_HMAC_KEYS:`v1:${Buffer.alloc(32,1).toString("base64")}`,PROVIDER_LOOKUP_HMAC_ACTIVE_VERSION:"v1",API_PUBLIC_URL:"https://api.originpost.test",WEB_PUBLIC_URL:"https://app.originpost.test"};

describe("Meta OAuth configuration",()=>{
  it.each([
    ["http callback","API_PUBLIC_URL","http://api.originpost.test"],
    ["callback path","API_PUBLIC_URL","https://api.originpost.test/proxy"],
    ["return query","WEB_PUBLIC_URL","https://app.originpost.test/?next=evil"],
    ["return credentials","WEB_PUBLIC_URL","https://user:pass@app.originpost.test"],
  ])("rejects a production %s",(_name,key,value)=>{expect(()=>validateConfig({...productionMetaConfig,[key]:value})).toThrow(/origin-only HTTPS URL/);});

  it("accepts origin-only HTTPS URLs and a complete bounded collaborator probe",()=>{
    expect(validateConfig({...productionMetaConfig,INSTAGRAM_COLLABORATOR_CONTRACT_PROBE_API_VERSION:"v26.0",INSTAGRAM_COLLABORATOR_CONTRACT_PROBE_VERIFIED_AT:"2026-08-01T00:00:00.000Z",INSTAGRAM_COLLABORATOR_CONTRACT_PROBE_EXPIRES_AT:"2026-08-20T00:00:00.000Z"})).toMatchObject({API_PUBLIC_URL:"https://api.originpost.test",WEB_PUBLIC_URL:"https://app.originpost.test"});
  });

  it("rejects a partial or version-rebound collaborator probe",()=>{
    expect(()=>validateConfig({...productionMetaConfig,INSTAGRAM_COLLABORATOR_CONTRACT_PROBE_API_VERSION:"v26.0"})).toThrow("configured together");
    expect(()=>validateConfig({...productionMetaConfig,INSTAGRAM_COLLABORATOR_CONTRACT_PROBE_API_VERSION:"v25.0",INSTAGRAM_COLLABORATOR_CONTRACT_PROBE_VERIFIED_AT:"2026-08-01T00:00:00.000Z",INSTAGRAM_COLLABORATOR_CONTRACT_PROBE_EXPIRES_AT:"2026-08-20T00:00:00.000Z"})).toThrow("match META_GRAPH_API_VERSION");
  });
});

describe("Facebook Page analytics configuration", () => {
  const verifiedAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const analyticsConfig = {
    ...productionMetaConfig,
    AUTH_MODE: "sessions",
    BOOTSTRAP_ADMIN_EMAIL: "owner@originpost.test",
    BOOTSTRAP_ADMIN_PASSWORD: "a-safe-password",
    FACEBOOK_CONNECTOR_MODE: "official",
    FACEBOOK_ANALYTICS_CONNECTOR_MODE: "official",
    FACEBOOK_ANALYTICS_APP_REVIEW_SHA256: "d".repeat(64),
    FACEBOOK_ANALYTICS_CONTRACT_PROBE_API_VERSION: "v26.0",
    FACEBOOK_ANALYTICS_CONTRACT_PROBE_RESULT_SHA256: "e".repeat(64),
    FACEBOOK_ANALYTICS_CONTRACT_PROBE_VERIFIED_AT: verifiedAt,
    FACEBOOK_ANALYTICS_CONTRACT_PROBE_EXPIRES_AT: expiresAt,
    META_WEBHOOK_VERIFY_TOKEN: "m".repeat(32),
  };

  it("accepts reviewed, current evidence for the exact Graph version", () => {
    expect(validateConfig(analyticsConfig)).toMatchObject({ FACEBOOK_ANALYTICS_CONNECTOR_MODE: "official" });
  });

  it.each([
    ["publishing mode", { FACEBOOK_CONNECTOR_MODE: "mock" }],
    ["review evidence", { FACEBOOK_ANALYTICS_APP_REVIEW_SHA256: "missing" }],
    ["Graph version", { FACEBOOK_ANALYTICS_CONTRACT_PROBE_API_VERSION: "v25.0" }],
    ["probe result evidence", { FACEBOOK_ANALYTICS_CONTRACT_PROBE_RESULT_SHA256: "missing" }],
    ["expired probe", { FACEBOOK_ANALYTICS_CONTRACT_PROBE_EXPIRES_AT: new Date(Date.now() - 1).toISOString() }],
  ])("rejects an invalid %s gate", (_name, override) => {
    expect(() => validateConfig({ ...analyticsConfig, ...override })).toThrow(/Facebook analytics|Official Facebook analytics/);
  });
});

describe("workspace AI runtime configuration",()=>{
  it("normalizes the private-endpoint gate and rejects ambiguous values",()=>{
    expect(validateConfig({NODE_ENV:"test",AGENT_ALLOW_PRIVATE_ENDPOINTS:"true"})).toMatchObject({AGENT_ALLOW_PRIVATE_ENDPOINTS:true});
    expect(validateConfig({NODE_ENV:"test",AGENT_ALLOW_PRIVATE_ENDPOINTS:"false"})).toMatchObject({AGENT_ALLOW_PRIVATE_ENDPOINTS:false});
    expect(()=>validateConfig({NODE_ENV:"test",AGENT_ALLOW_PRIVATE_ENDPOINTS:"yes"})).toThrow("must be true or false");
  });
});

describe("OpenAI image generation configuration", () => {
  it("is opt-in and validates the server-side model, credential, and timeout", () => {
    expect(validateConfig({ NODE_ENV: "test" })).toMatchObject({ IMAGE_GENERATION_MODE: "disabled", OPENAI_IMAGE_MODEL: "gpt-image-2.5-sunburst", OPENAI_IMAGE_TIMEOUT_MS: 180_000 });
    expect(validateConfig({ NODE_ENV: "test", IMAGE_GENERATION_MODE: "openai", OPENAI_IMAGE_API_KEY: "test-key", OPENAI_IMAGE_MODEL: "gpt-image-2.5-flare", OPENAI_IMAGE_TIMEOUT_MS: "120000" })).toMatchObject({ IMAGE_GENERATION_MODE: "openai", OPENAI_IMAGE_MODEL: "gpt-image-2.5-flare", OPENAI_IMAGE_TIMEOUT_MS: 120_000 });
    expect(() => validateConfig({ NODE_ENV: "test", IMAGE_GENERATION_MODE: "openai" })).toThrow("requires OPENAI_IMAGE_API_KEY or OPENAI_API_KEY");
    expect(() => validateConfig({ NODE_ENV: "test", IMAGE_GENERATION_MODE: "best-effort" })).toThrow("must be disabled or openai");
  });
});

describe("media malware scan configuration", () => {
  it("normalizes bounded clamd settings", () => {
    expect(validateConfig({ NODE_ENV: "test", MEDIA_MALWARE_SCAN_MODE: "clamav", MEDIA_CLAMAV_HOST: "clamav", MEDIA_CLAMAV_PORT: "3310", MEDIA_MALWARE_SCAN_TIMEOUT_MS: "120000", MEDIA_MALWARE_SCAN_MAX_BYTES: "536870912" })).toMatchObject({
      MEDIA_MALWARE_SCAN_MODE: "clamav",
      MEDIA_CLAMAV_HOST: "clamav",
      MEDIA_CLAMAV_PORT: 3310,
      MEDIA_MALWARE_SCAN_TIMEOUT_MS: 120000,
      MEDIA_MALWARE_SCAN_MAX_BYTES: 536870912,
    });
  });

  it("refuses live publishing without the required scan gate", () => {
    expect(() => validateConfig({ ...productionMetaConfig, AUTH_MODE: "sessions", BOOTSTRAP_ADMIN_EMAIL: "owner@originpost.test", BOOTSTRAP_ADMIN_PASSWORD: "a-safe-password", INSTAGRAM_CONNECTOR_MODE: "official", ALLOW_LIVE_PUBLISH: "true" })).toThrow("MEDIA_MALWARE_SCAN_MODE=clamav");
  });

  it.each([
    ["unknown mode", { MEDIA_MALWARE_SCAN_MODE: "best-effort" }, "must be disabled or clamav"],
    ["URL host", { MEDIA_MALWARE_SCAN_MODE: "clamav", MEDIA_CLAMAV_HOST: "tcp://clamav" }, "plain DNS name or IPv4"],
    ["invalid port", { MEDIA_MALWARE_SCAN_MODE: "clamav", MEDIA_CLAMAV_PORT: "70000" }, "MEDIA_CLAMAV_PORT"],
  ])("rejects %s", (_name, overrides, message) => {
    expect(() => validateConfig({ NODE_ENV: "test", ...overrides })).toThrow(message);
  });
});

describe("official private-message configuration", () => {
  const privateConfig = {
    ...productionMetaConfig,
    AUTH_MODE: "sessions",
    BOOTSTRAP_ADMIN_EMAIL: "owner@originpost.test",
    BOOTSTRAP_ADMIN_PASSWORD: "a-safe-password",
    REDIS_URL: "redis://redis:6379",
    PRIVATE_MESSAGE_CONNECTOR_MODE: "official",
    PRIVATE_MESSAGE_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    PRIVATE_MESSAGE_HASH_KEY: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
    META_WEBHOOK_VERIFY_TOKEN: "m".repeat(32),
    META_PRIVATE_MESSAGING_APP_REVIEW_SHA256: "c".repeat(64),
  };

  it("accepts a durable, session-authenticated, HTTPS configuration", () => {
    expect(validateConfig(privateConfig)).toMatchObject({ PRIVATE_MESSAGE_CONNECTOR_MODE: "official", AUTH_MODE: "sessions" });
  });

  it.each([
    ["single-user auth", { AUTH_MODE: "single-user" }, "AUTH_MODE=sessions"],
    ["missing Redis", { REDIS_URL: undefined }, "DATABASE_URL and REDIS_URL"],
    ["missing private keys", { PRIVATE_MESSAGE_HASH_KEY: undefined }, "configured together"],
    ["missing webhook token", { META_WEBHOOK_VERIFY_TOKEN: undefined }, "META_WEBHOOK_VERIFY_TOKEN"],
    ["non-HTTPS API", { API_PUBLIC_URL: "http://localhost:4000" }, "public HTTPS API_PUBLIC_URL"],
  ])("rejects %s", (_name, overrides, message) => {
    expect(() => validateConfig({ ...privateConfig, ...overrides })).toThrow(message);
  });

  it("rejects private-message mock mode in production", () => {
    expect(() => validateConfig({ ...productionMetaConfig, PRIVATE_MESSAGE_CONNECTOR_MODE: "mock" })).toThrow("forbidden in production");
  });
});

describe("internal Hermes Boards plugin configuration", () => {
  const boardsConfig = {
    NODE_ENV: "test", AUTH_MODE: "sessions", BOOTSTRAP_ADMIN_EMAIL: "owner@originpost.test", BOOTSTRAP_ADMIN_PASSWORD: "a-safe-password",
    DATABASE_URL: "postgres://example", REDIS_URL: "redis://example", HERMES_BOARD_PLUGIN_ENABLED: "true",
    HERMES_BOARD_SUPPORTED_VERSION: "0.21.2", HERMES_BOARD_SECRET: "b".repeat(32), HERMES_DASHBOARD_URL: "http://127.0.0.1:9119",
    HERMES_DASHBOARD_SESSION_TOKEN: "d".repeat(32), HERMES_API_URL: "http://127.0.0.1:8642", HERMES_BOARD_APPROVED_SKILLS: "news-research,content-planning",
    HERMES_BOARD_PRIMARY_PROVIDER: "openai-codex", HERMES_BOARD_PRIMARY_MODEL: "gpt-5.5",
  };
  it("accepts the pinned local control and execution surfaces", () => {
    expect(validateConfig(boardsConfig)).toMatchObject({ HERMES_BOARD_PLUGIN_ENABLED: true, HERMES_BOARD_ALLOW_PRIVATE_ENDPOINTS: false });
  });
  it.each([
    ["single-user auth", { AUTH_MODE: "single-user" }, "AUTH_MODE=sessions"],
    ["missing durable queue", { REDIS_URL: undefined }, "DATABASE_URL and REDIS_URL"],
    ["short derivation secret", { HERMES_BOARD_SECRET: "short" }, "at least 32 bytes"],
    ["wrong Hermes version", { HERMES_BOARD_SUPPORTED_VERSION: "0.22.0" }, "supports Hermes 0.21.2 only"],
    ["missing primary model", { HERMES_BOARD_PRIMARY_MODEL: undefined }, "explicit primary provider and model"],
    ["unsupported provider", { HERMES_BOARD_PRIMARY_PROVIDER: "openai" }, "HERMES_BOARD_PRIMARY_PROVIDER=openai-codex"],
    ["untrusted HTTP control plane", { HERMES_DASHBOARD_URL: "http://hermes.internal:9119" }, "must use HTTPS"],
    ["invalid approved skill", { HERMES_BOARD_APPROVED_SKILLS: "../escape" }, "invalid skill name"],
  ])("rejects %s", (_name, override, message) => {
    expect(() => validateConfig({ ...boardsConfig, ...override })).toThrow(message);
  });
});
