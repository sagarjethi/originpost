import {
  IsObject,
  IsISO8601,
  IsIn,
  IsInt,
  Min,
  Matches,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from "class-validator";
export class AgentPostQueryDto {
  @IsString() @MaxLength(100) workspaceId = "default";
  @IsString() @Length(1, 100) brandId!: string;
}
export class AgentPostTemplateDto extends AgentPostQueryDto {
  @IsObject() template!: Record<string, unknown>;
}
export class CreateAgentPostDto extends AgentPostQueryDto {
  @IsOptional() @IsIn(["server", "codex-upload"]) imageMode?:
    | "server"
    | "codex-upload";
  @IsOptional() @IsString() @Length(1, 200) sourceSignalId?: string;
  @IsOptional() @IsInt() @Min(1) sourceSignalVersion?: number;
  @IsOptional() @IsString() @Length(1, 200) parentRunId?: string;
  @IsString() @Length(1, 200) templateId!: string;
  @IsString() @Length(3, 8000) input!: string;
  @IsOptional() @IsString() @MaxLength(2000) direction?: string;
}

export class ImportAgentPostImageDto extends AgentPostQueryDto {
  @IsInt() @Min(1) expectedVersion!: number;
  @IsString() @Length(1, 200) mediaId!: string;
  @IsString() @Matches(/^[a-f0-9]{64}$/) briefHash!: string;
}

export class RecoverAgentPostCompositionDto extends AgentPostQueryDto {
  @IsInt() @Min(1) expectedVersion!: number;
  @IsString() @Length(1, 200) projectId!: string;
}

export class AgentPostPublishPreviewDto extends AgentPostQueryDto {
  @IsIn(["originpost.publisher"]) recipientId!: "originpost.publisher";
  @IsString() @Length(1, 200) accountId!: string;
  @IsISO8601() scheduledFor!: string;
}
export class AgentPostPublishDto extends AgentPostPublishPreviewDto {
  @IsInt() @Min(1) contentVersion!: number;
  @IsString() @Matches(/^[a-f0-9]{64}$/) previewHash!: string;
  @IsOptional()
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  conflictAcknowledgementSha256?: string;
}
