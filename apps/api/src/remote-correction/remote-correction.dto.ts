import { IsBoolean, IsIn, IsISO8601, IsOptional, IsString, IsUrl, Length } from "class-validator";
import type { RemoteCorrectionAction } from "@originpost/domain";

export class RemoteCorrectionScopeDto { @IsOptional() @IsString() @Length(1,200) workspaceId?: string; }
export class RemoteCorrectionQueryDto extends RemoteCorrectionScopeDto { @IsOptional() @IsString() @Length(1,200) publishProofId?: string; }
export class RemoteCorrectionCapabilityDto extends RemoteCorrectionScopeDto { @IsString() @Length(1,200) publishProofId!: string; }
export class RemoteCorrectionParamDto { @IsString() @Length(1,200) contentItemId!: string; }
export class RemoteCorrectionOperationParamDto extends RemoteCorrectionParamDto { @IsString() @Length(1,200) operationId!: string; }

export class CreateRemoteCorrectionDto extends RemoteCorrectionScopeDto {
  @IsString() @Length(1,200) publishProofId!: string;
  @IsIn(["make_private","restore_visibility","delete_remote","manual_remove"]) action!: Exclude<RemoteCorrectionAction,"edit_text">;
  @IsString() @Length(3,2000) reason!: string;
  @IsOptional() @IsIn(["public","unlisted"]) visibility?: "public" | "unlisted";
}

export class ApproveRemoteCorrectionDto extends RemoteCorrectionScopeDto {
  @IsOptional() @IsBoolean() singleOwnerOverride?: boolean;
  @IsOptional() @IsBoolean() secondConfirmation?: boolean;
}

export class ManualAttestationDto extends RemoteCorrectionScopeDto {
  @IsISO8601({ strict: true }) occurredAt!: string;
  @IsString() @Length(3,2000) note!: string;
  @IsUrl({ protocols:["https"],require_protocol:true }) evidenceUrl!: string;
}
