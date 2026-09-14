import {
  IsObject,
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
  @IsOptional() @IsString() @Length(1, 200) parentRunId?: string;
  @IsString() @Length(1, 200) templateId!: string;
  @IsString() @Length(3, 8000) input!: string;
  @IsOptional() @IsString() @MaxLength(2000) direction?: string;
}
