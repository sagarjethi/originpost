import { Type } from "class-transformer";
import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUrl, Length, Min } from "class-validator";
export class FirstCommentScopeDto { @IsOptional() @IsString() @Length(1,200) workspaceId?: string; }
export class FirstCommentParamDto { @IsString() @Length(1,200) contentItemId!: string; }
export class FirstCommentIntentParamDto extends FirstCommentParamDto { @IsString() @Length(1,200) intentId!: string; }
export class FirstCommentCapabilityDto extends FirstCommentScopeDto { @IsString() @Length(1,200) targetId!: string; }
export class CreateFirstCommentDto extends FirstCommentScopeDto { @IsString() @Length(1,200) targetId!: string; @IsString() @Length(1,2200) body!: string; }
export class ReviseFirstCommentDto extends FirstCommentScopeDto { @IsString() @Length(1,2200) body!: string; @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number; }
export class FirstCommentVersionDto extends FirstCommentScopeDto { @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number; }
export class ApproveFirstCommentDto extends FirstCommentVersionDto { @IsOptional() @IsBoolean() singleOwnerOverride?: boolean; @IsOptional() @IsBoolean() secondConfirmation?: boolean; }
export class ReconcileFirstCommentDto extends FirstCommentVersionDto { @IsIn(["inspect_provider", "confirmed_not_sent"]) outcome!: "inspect_provider" | "confirmed_not_sent"; }
export class AttestFirstCommentDto extends FirstCommentVersionDto { @IsISO8601({strict:true}) occurredAt!:string; @IsString() @Length(3,2000) note!:string; @IsUrl({protocols:["https"],require_protocol:true}) evidenceUrl!:string; }
