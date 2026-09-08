import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

export class EngagementScopeQueryDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId?: string;
  @IsOptional() @IsString() @MaxLength(100) brandId?: string;
}

export class EngagementListQueryDto extends EngagementScopeQueryDto {
  @IsOptional() @IsIn(["open", "resolved"]) state?: "open" | "resolved";
  @IsOptional() @IsString() @MaxLength(120) assignedTo?: string;
  @IsOptional() @IsString() @MaxLength(120) accountId?: string;
  @IsOptional() @IsString() @MaxLength(200) query?: string;
  @IsOptional() @IsString() @MaxLength(500) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class EngagementIdParamDto {
  @IsString() @MaxLength(120) threadId!: string;
}

export class EngagementCommentParamDto {
  @IsString() @MaxLength(120) commentId!: string;
}

export class EngagementActionParamDto {
  @IsString() @MaxLength(120) actionId!: string;
}

export class EngagementProofParamDto {
  @IsString() @MaxLength(120) proofId!: string;
}

export class UpdateEngagementThreadDto {
  @Type(() => Number) @IsInt() @Min(1) version!: number;
  @IsOptional() @IsIn(["open", "resolved"]) state?: "open" | "resolved";
  @IsOptional() @IsString() @MaxLength(120) assignedTo?: string;
}

export class CreateReplyDraftDto {
  @IsString() @MaxLength(2200) body!: string;
}

export class EngagementActionVersionDto {
  @Type(() => Number) @IsInt() @Min(1) version!: number;
}

export class ReconcileEngagementActionDto extends EngagementActionVersionDto {
  @IsIn(["confirmed_sent", "confirmed_not_sent"]) outcome!: "confirmed_sent" | "confirmed_not_sent";
  @IsOptional() @IsString() @MaxLength(160) providerReplyId?: string;
}

export class InstagramWebhookQueryDto {
  @IsOptional() @IsString() @MaxLength(40) "hub.mode"?: string;
  @IsOptional() @IsString() @MaxLength(500) "hub.challenge"?: string;
  @IsOptional() @IsString() @MaxLength(500) "hub.verify_token"?: string;
}

export class FacebookWebhookQueryDto extends InstagramWebhookQueryDto {}
