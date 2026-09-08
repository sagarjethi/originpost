import { IsEmail, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from "class-validator";
import type { Role } from "@originpost/domain";

export class LoginDto {
  @IsEmail() @Length(3, 254) email: string;
  @IsString() @Length(1, 128) password: string;
}

export class CreateMemberDto {
  @IsString() @Length(1, 100) displayName: string;
  @IsEmail() @Length(3, 254) email: string;
  @IsString() @Length(12, 128) password: string;
  @IsIn(["owner", "manager", "creator", "viewer"]) role: Role;
}

export class UpdateMemberRoleDto {
  @IsIn(["owner", "manager", "creator", "viewer"]) role: Role;
}

export class CreateWorkspaceInvitationDto {
  @IsEmail() @Length(3, 254) email: string;
  @IsIn(["owner", "manager", "creator", "viewer"]) role: Role;
  @IsOptional() @IsInt() @Min(1) @Max(30) expiresInDays?: number;
}

export class ResendWorkspaceInvitationDto {
  @IsOptional() @IsInt() @Min(1) @Max(30) expiresInDays?: number;
}

export class WorkspaceInvitationTokenDto {
  @IsString() @Length(43, 43) @Matches(/^[A-Za-z0-9_-]{43}$/) token: string;
}

export class RegisterWorkspaceInvitationDto extends WorkspaceInvitationTokenDto {
  @IsString() @Length(2, 100) displayName: string;
  @IsString() @Length(12, 128)
  @Matches(/[A-Za-z]/, { message: "password must contain a letter" })
  @Matches(/[0-9]/, { message: "password must contain a number" })
  password: string;
}

export class ChangePasswordDto {
  @IsString() @Length(1, 128) currentPassword: string;
  @IsString() @Length(12, 128)
  @Matches(/[A-Za-z]/, { message: "newPassword must contain a letter" })
  @Matches(/[0-9]/, { message: "newPassword must contain a number" })
  newPassword: string;
}

export class WorkspaceIdParamDto {
  @IsString() @Length(1, 100) @Matches(/^[a-zA-Z0-9_-]+$/) workspaceId: string;
}

export class WorkspaceInvitationParamDto extends WorkspaceIdParamDto {
  @IsString() @Length(1, 140) @Matches(/^[a-zA-Z0-9_-]+$/) invitationId: string;
}

export class MemberParamDto extends WorkspaceIdParamDto {
  @IsString() @Length(1, 120) @Matches(/^[a-zA-Z0-9_-]+$/) userId: string;
}

export class OidcCallbackDto {
  @IsOptional() @IsString() @Length(1, 2048) code?: string;
  @IsOptional() @IsString() @Length(1, 512) state?: string;
  @IsOptional() @IsString() @Length(1, 200) error?: string;
  @IsOptional() @IsString() @Length(1, 1000) error_description?: string;
  @IsOptional() @IsString() @Length(1, 2048) iss?: string;
  @IsOptional() @IsString() @Length(1, 2048) session_state?: string;
}
