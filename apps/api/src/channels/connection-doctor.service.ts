import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ChannelCapability, ConnectedAccount } from "@originpost/domain";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";

type CheckStatus = "pass" | "warn" | "fail";
export type ConnectionCheck = { id: string; label: string; status: CheckStatus; detail: string; action?: string };
export type ConnectionDiagnostic = { readiness: "healthy" | "warning" | "blocked"; checkedAt: string; callbackUrl: string; checks: ConnectionCheck[] };

const requiredCapabilities: Record<ConnectedAccount["platform"], ChannelCapability[]> = {
  instagram: ["profile_read", "media_publish"],
  facebook: ["page_read", "media_publish"],
  youtube: ["channel_read", "video_upload"],
};

@Injectable()
export class ConnectionDoctorService {
  constructor(
    @Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure,
    private readonly config: ConfigService,
  ) {}

  async inspect(account: ConnectedAccount): Promise<ConnectionDiagnostic> {
    const checkedAt = new Date().toISOString();
    const baseUrl = (this.config.get<string>("API_PUBLIC_URL") ?? "http://localhost:4000").replace(/\/$/, "");
    const callbackUrl = `${baseUrl}/v1/channels/oauth/${account.platform}/callback`;
    const checks: ConnectionCheck[] = [];
    const connector = this.infrastructure.connectors.list().find((entry) => entry.manifest.platform === account.platform);
    checks.push(connector
      ? { id: "connector", label: "Publishing connector", status: "pass", detail: `${connector.manifest.name} is installed.` }
      : { id: "connector", label: "Publishing connector", status: "fail", detail: "No connector is installed for this network.", action: "Install or enable the network connector." });

    if (!account.credentialRef) {
      checks.push({ id: "credentials", label: "Credential storage", status: "fail", detail: "No protected credential reference is configured.", action: "Add an env:, vault:, or secret: reference. Never paste a raw token." });
    } else if (account.credentialRef.startsWith("env:")) {
      const environmentName = account.credentialRef.slice(4);
      checks.push(this.config.get<string>(environmentName)
        ? { id: "credentials", label: "Credential storage", status: "pass", detail: "The referenced environment secret is available to the API." }
        : { id: "credentials", label: "Credential storage", status: "fail", detail: "The referenced environment secret is not available to the API.", action: "Set the referenced environment variable and restart the API." });
    } else if (account.credentialRef.startsWith("secret:")) {
      checks.push(await this.infrastructure.oauthRepository.hasCredential(account.workspaceId, account.credentialRef.slice(7))
        ? { id: "credentials", label: "Credential storage", status: "pass", detail: "The provider credential is encrypted in the workspace vault." }
        : { id: "credentials", label: "Credential storage", status: "fail", detail: "The encrypted provider credential is missing.", action: "Reconnect this account." });
    } else {
      checks.push({ id: "credentials", label: "Credential storage", status: "fail", detail: "No vault resolver is installed for this reference type.", action: "Install the matching server-side secret-store adapter." });
    }

    const missing = requiredCapabilities[account.platform].filter((capability) => !account.capabilities.includes(capability));
    checks.push(missing.length === 0
      ? { id: "permissions", label: "Publishing permissions", status: "pass", detail: "Required publishing capabilities are present." }
      : { id: "permissions", label: "Publishing permissions", status: "fail", detail: `Missing: ${missing.join(", ").replaceAll("_", " ")}.`, action: "Reconnect the account and approve the missing permissions." });

    if (account.platform === "instagram") {
      const missingEngagement = (["comment_read", "comment_reply"] as ChannelCapability[]).filter((capability) => !account.capabilities.includes(capability));
      checks.push(missingEngagement.length === 0
        ? { id: "engagement", label: "Comment inbox", status: "pass", detail: "Instagram comment reading and human-approved replies are enabled." }
        : { id: "engagement", label: "Comment inbox", status: "warn", detail: "Publishing still works, but the Engagement inbox is unavailable.", action: "Reconnect Instagram and grant comment access." });
    }

    try {
      const url = new URL(baseUrl);
      const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
      checks.push(url.protocol === "https:" || local
        ? local
          ? { id: "callback", label: "OAuth callback", status: "warn", detail: "Local callback is suitable for development only.", action: "Set API_PUBLIC_URL to the public HTTPS address before connecting a live provider." }
          : { id: "callback", label: "OAuth callback", status: "pass", detail: "The callback uses HTTPS." }
        : { id: "callback", label: "OAuth callback", status: "fail", detail: "The public callback is not HTTPS.", action: "Set API_PUBLIC_URL to a public HTTPS address." });
    } catch {
      checks.push({ id: "callback", label: "OAuth callback", status: "fail", detail: "API_PUBLIC_URL is not a valid URL.", action: "Set a complete HTTPS API_PUBLIC_URL." });
    }

    const managedContinuousAccess = (account.platform === "youtube" || account.platform === "facebook") && connector?.manifest.apiMode === "official" && connector.manifest.capabilities.tokenRefresh && account.credentialRef?.startsWith("secret:");
    if (managedContinuousAccess) {
      checks.push({ id: "expiry", label: "Background access", status: "pass", detail: account.platform === "facebook" ? "OriginPost can check this protected Page access before publishing." : "OriginPost can renew short-lived YouTube access with the protected offline grant." });
    } else if (!account.expiresAt) {
      checks.push({ id: "expiry", label: "Access expiry", status: "warn", detail: "The provider expiry time is unknown.", action: "Save the expiry returned by the provider." });
    } else {
      const remainingMs = new Date(account.expiresAt).getTime() - Date.now();
      checks.push(remainingMs <= 0
        ? { id: "expiry", label: "Access expiry", status: "fail", detail: "Provider access has expired.", action: "Reconnect this account." }
        : remainingMs <= 7 * 24 * 60 * 60 * 1000
          ? { id: "expiry", label: "Access expiry", status: "warn", detail: "Provider access expires within 7 days.", action: "Reconnect now to avoid missed posts." }
          : { id: "expiry", label: "Access expiry", status: "pass", detail: `Access is recorded until ${new Date(account.expiresAt).toLocaleDateString("en-CA")}.` });
    }

    if (connector?.manifest.apiMode === "mock") checks.push({ id: "mode", label: "Live publishing", status: "warn", detail: "The safe test connector is active. It cannot publish to a real account.", action: "Install the official provider adapter when app credentials are ready." });
    else if (connector) checks.push({ id: "mode", label: "Live publishing", status: "pass", detail: "The official provider adapter is active." });

    const readiness = checks.some((check) => check.status === "fail") ? "blocked" : checks.some((check) => check.status === "warn") ? "warning" : "healthy";
    return { readiness, checkedAt, callbackUrl, checks };
  }
}
