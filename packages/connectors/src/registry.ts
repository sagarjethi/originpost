import { privateConversationPlatformForMode, type EngagementPlatform, type Platform, type PrivateConversationConnectionMode } from "@originpost/domain";
import { MockFacebookConnector, MockInstagramConnector, MockYouTubeConnector } from "./mock.js";
import { MockPrivateConversationConnector, type PrivateConversationConnector } from "./private-conversations.js";
import type { RemoteCorrectionConnector } from "./remote-correction.js";
import type { EngagementConnector, PlatformConnector } from "./types.js";
import type { FirstCommentConnector } from "./first-comment.js";

export class ConnectorRegistry {
  private readonly connectors = new Map<Platform, PlatformConnector>();
  private readonly engagementConnectors = new Map<EngagementPlatform, EngagementConnector>();
  private readonly privateConversationConnectors = new Map<PrivateConversationConnectionMode, PrivateConversationConnector>();
  private readonly correctionConnectors = new Map<Platform, RemoteCorrectionConnector>();
  private readonly firstCommentConnectors = new Map<EngagementPlatform, FirstCommentConnector>();

  register(connector: PlatformConnector): void {
    this.connectors.set(connector.manifest.platform, connector);
    if (this.isEngagementConnector(connector)) this.engagementConnectors.set(connector.manifest.platform, connector);
    if (this.isCorrectionConnector(connector)) this.correctionConnectors.set(connector.manifest.platform, connector);
    if (this.isFirstCommentConnector(connector)) this.firstCommentConnectors.set(connector.manifest.platform as EngagementPlatform, connector);
  }

  registerEngagement(connector: EngagementConnector): void { this.engagementConnectors.set(connector.manifest.platform, connector); }

  registerPrivateConversations(connector: PrivateConversationConnector): void {
    const manifest = connector.privateConversationManifest;
    if (manifest.platform !== privateConversationPlatformForMode(manifest.connectionMode)) {
      throw new Error(`Private-message connector ${manifest.id} has an invalid platform/connection-mode pairing.`);
    }
    this.privateConversationConnectors.set(manifest.connectionMode, connector);
  }

  registerRemoteCorrection(connector: RemoteCorrectionConnector): void { this.correctionConnectors.set(connector.manifest.platform, connector); }

  get(platform: Platform): PlatformConnector {
    const connector = this.connectors.get(platform);
    if (!connector) throw new Error(`No connector registered for ${platform}.`);
    return connector;
  }

  list(): PlatformConnector[] {
    return [...this.connectors.values()];
  }

  getEngagement(platform: EngagementPlatform): EngagementConnector {
    const connector = this.engagementConnectors.get(platform);
    if (!connector) throw new Error(`No engagement connector registered for ${platform}.`);
    return connector;
  }

  getPrivateConversations(connectionMode: PrivateConversationConnectionMode): PrivateConversationConnector {
    const connector = this.privateConversationConnectors.get(connectionMode);
    if (!connector) throw new Error(`No private-message connector registered for ${connectionMode}.`);
    return connector;
  }

  listPrivateConversations(): PrivateConversationConnector[] {
    return [...this.privateConversationConnectors.values()];
  }

  getRemoteCorrection(platform: Platform): RemoteCorrectionConnector {
    const connector = this.correctionConnectors.get(platform);
    if (!connector) throw new Error(`No remote correction connector registered for ${platform}.`);
    return connector;
  }

  getFirstComment(platform: EngagementPlatform): FirstCommentConnector {
    const connector = this.firstCommentConnectors.get(platform);
    if (!connector) throw new Error(`No first-comment connector registered for ${platform}.`);
    return connector;
  }

  private isEngagementConnector(connector: PlatformConnector): connector is PlatformConnector & EngagementConnector {
    const candidate = connector as Partial<EngagementConnector>;
    return (connector.manifest.platform === "instagram" || connector.manifest.platform === "facebook") && connector.manifest.capabilities.comments === true && typeof candidate.readComments === "function" && typeof candidate.replyToComment === "function" && typeof candidate.subscribeToComments === "function";
  }

  private isCorrectionConnector(connector: PlatformConnector): connector is PlatformConnector & RemoteCorrectionConnector {
    const candidate = connector as Partial<RemoteCorrectionConnector>;
    return typeof candidate.correctionCapabilities === "function" && typeof candidate.preflightCorrection === "function" && typeof candidate.preflightManualCorrection === "function" && typeof candidate.executeCorrection === "function" && typeof candidate.reconcileCorrection === "function";
  }

  private isFirstCommentConnector(connector: PlatformConnector): connector is PlatformConnector & FirstCommentConnector {
    const candidate = connector as Partial<FirstCommentConnector>;
    return (connector.manifest.platform === "instagram" || connector.manifest.platform === "facebook") && typeof candidate.firstCommentCapability === "function" && typeof candidate.createFirstComment === "function" && typeof candidate.inspectFirstComment === "function";
  }
}

export type PrivateMessageConnectorMode = "disabled" | "mock" | "official";

export function createSafeConnectorRegistry(options: {
  privateConversationMode?: string;
  nodeEnv?: string;
} = {}): ConnectorRegistry {
  const privateConversationMode = options.privateConversationMode ?? "disabled";
  if (privateConversationMode !== "disabled" && privateConversationMode !== "mock" && privateConversationMode !== "official") {
    throw new Error("PRIVATE_MESSAGE_CONNECTOR_MODE must be disabled, mock, or official.");
  }
  if (privateConversationMode === "mock" && options.nodeEnv === "production") {
    throw new Error("PRIVATE_MESSAGE_CONNECTOR_MODE=mock is forbidden in production.");
  }
  const registry = new ConnectorRegistry();
  registry.register(new MockInstagramConnector());
  registry.register(new MockFacebookConnector());
  registry.register(new MockYouTubeConnector());
  if (privateConversationMode === "mock") {
    registry.registerPrivateConversations(new MockPrivateConversationConnector({ connectionMode: "facebook_page_messenger" }));
    registry.registerPrivateConversations(new MockPrivateConversationConnector({ connectionMode: "instagram_linked_page" }));
    registry.registerPrivateConversations(new MockPrivateConversationConnector({ connectionMode: "instagram_login" }));
  }
  return registry;
}
