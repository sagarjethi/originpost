import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";

export class InstagramGridQueryDto {
  @IsOptional() @IsString() @MaxLength(100) workspaceId?: string;
  @IsOptional() @IsString() @MaxLength(100) brandId?: string;
  @IsOptional() @IsString() @MinLength(3) @MaxLength(200) accountId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(60) limit = 30;
}
