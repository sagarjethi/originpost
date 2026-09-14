export interface AgentMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AgentImageInput {
  dataUrl: string;
  detail: "high";
}
export interface AgentRunRequest {
  /** Only image-capable adapters may consume these bytes. Never silently discard them. */
  imageInputs?: AgentImageInput[];
  messages: AgentMessage[];
  sessionKey: string;
  temperature?: number;
  maxTokens?: number;
}

export interface AgentRunResult {
  provider: string;
  model: string;
  text: string;
  responseId?: string;
  usage?: Record<string, number>;
  raw: unknown;
}

export interface AgentProvider {
  readonly id: string;
  health(): Promise<boolean>;
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}
