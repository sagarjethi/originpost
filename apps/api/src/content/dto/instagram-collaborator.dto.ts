import { ArrayMaxSize, IsArray, IsBoolean, IsObject, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class InstagramCollaboratorCapabilityQueryDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId?: string;
  @IsString() @MinLength(1) @MaxLength(200) accountId!: string;
  @IsString() @MinLength(1) @MaxLength(200) draftId!: string;
}
export class CreateInstagramCollaboratorCandidateDto {
  @IsString() @MinLength(1) @MaxLength(200) draftId!: string;
  @IsString() @MinLength(1) @MaxLength(200) accountId!: string;
  @IsArray() @ArrayMaxSize(3) @IsString({each:true}) collaborators!: string[];
  @IsOptional() @IsBoolean() shareToFeed = true;
  @IsOptional() @IsBoolean() isAiGenerated = false;
  /** Strictly parsed by the domain; custom-image hashes are derived server-side. */
  @IsOptional() @IsObject() reelCover?: Record<string, unknown>;
}
export class ApproveInstagramCollaboratorCandidateDto { @IsOptional() @IsString() @MaxLength(1000) note?: string; }
export class InstagramCollaboratorProofParamDto { @IsString() @MinLength(3) @MaxLength(200) id!:string; @IsString() @MinLength(3) @MaxLength(200) proofId!:string; }
export class InstagramCollaboratorCandidateParamDto { @IsString() @MinLength(3) @MaxLength(200) id!:string; @IsString() @MinLength(3) @MaxLength(200) candidateId!:string; }
