import { Transform, Type } from "class-transformer";
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";

export class NotificationWorkspaceParamDto {
  @IsString() @MinLength(1) @MaxLength(100) workspaceId!: string;
}

export class NotificationParamDto extends NotificationWorkspaceParamDto {
  @IsString() @MinLength(3) @MaxLength(200) id!: string;
}

export class NotificationListQueryDto {
  @IsOptional() @Transform(({ value }) => value === true || value === "true") @IsBoolean() unreadOnly = false;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 30;
}
