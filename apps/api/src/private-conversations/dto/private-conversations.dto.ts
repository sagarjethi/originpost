import { Type } from "class-transformer";
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from "class-validator";

export class PrivateConversationScopeQueryDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId?: string;
  @IsOptional() @IsString() @MaxLength(100) brandId?: string;
}

export class PrivateConversationListQueryDto extends PrivateConversationScopeQueryDto {
  @IsOptional() @IsIn(["open", "resolved"]) state?: "open" | "resolved";
  @IsOptional() @IsString() @MaxLength(120) assignedTo?: string;
  @IsOptional() @IsString() @MaxLength(120) accountId?: string;
  @IsOptional() @IsIn(["instagram", "facebook"]) platform?: "instagram" | "facebook";
  @IsOptional() @IsIn(["facebook_page_messenger", "instagram_linked_page", "instagram_login"])
  connectionMode?: "facebook_page_messenger" | "instagram_linked_page" | "instagram_login";
  @IsOptional() @IsIn(["unread", "needs_reply", "mine"]) attention?: "unread" | "needs_reply" | "mine";
  @IsOptional() @IsIn(["eligible", "ineligible", "unknown"]) eligibility?: "eligible" | "ineligible" | "unknown";
  @IsOptional() @IsString() @MaxLength(200) query?: string;
  @IsOptional() @IsString() @MaxLength(500) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class PrivateConversationParamDto {
  @IsString() @MaxLength(120) conversationId!: string;
}

export class PrivateMessageParamDto {
  @IsString() @MaxLength(120) messageId!: string;
}

export class PrivateReplyIntentParamDto {
  @IsString() @MaxLength(120) intentId!: string;
}

export class PrivateConversationDemoAccountParamDto {
  @IsString() @MaxLength(120) accountId!: string;
}

export class ProvisionPrivateConversationDemoDto {
  /** Optimistic account version. Connected accounts use updatedAt as their current version. */
  @IsISO8601({ strict: true }) expectedAccountUpdatedAt!: string;
}

export class UpdatePrivateConversationDto {
  @Type(() => Number) @IsInt() @Min(1) version!: number;
  @IsOptional() @IsIn(["open", "resolved"]) state?: "open" | "resolved";
  @IsOptional() @IsString() @MaxLength(120) assignedTo?: string;
}

export class CreatePrivateReplyDraftDto {
  @IsString() @MinLength(1) @MaxLength(4_000) body!: string;
  @IsOptional() @IsUUID("4") clientRequestId?: string;
}

export class PrivateReplyIntentVersionDto {
  @Type(() => Number) @IsInt() @Min(1) version!: number;
}

export class RevisePrivateReplyDraftDto extends PrivateReplyIntentVersionDto {
  @IsString() @MinLength(1) @MaxLength(4_000) body!: string;
}

export class ReconcilePrivateReplyIntentDto extends PrivateReplyIntentVersionDto {
  @IsIn(["confirmed_sent", "confirmed_not_sent"]) outcome!: "confirmed_sent" | "confirmed_not_sent";
  @IsString() @MinLength(10) @MaxLength(500) note!: string;
}
