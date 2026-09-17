import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min, ValidateNested } from 'class-validator';
export class AudioQueryDto {
  @IsString() @Length(1,100) workspaceId = 'default';
  @IsString() @Length(1,100) brandId!: string;
  @IsOptional() @IsString() @Length(1,500) cursor?: string;
}
export class AudioSkillDto {
  @Matches(/^[a-z0-9][a-z0-9-]{0,63}$/) id!: string;
  @Matches(/^\d+\.\d+\.\d+$/) version!: string;
  @IsString() @Length(1,100) name!: string;
  @Matches(/^[a-z]{2,3}$/) language!: string;
  @IsString() @Length(1,2000) instructions!: string;
  @IsInt() @Min(1) @Max(3000) maxCharacters!: number;
}
export class SaveAudioProfileDto extends AudioQueryDto {
  @IsOptional() @IsString() @Length(1,200) projectTemplateId?: string;
  @IsInt() @Min(0) version = 0;
  @IsIn(['elevenlabs']) provider: 'elevenlabs' = 'elevenlabs';
  @IsString() @Length(1,100) name!: string;
  @Matches(/^[a-zA-Z0-9_-]{1,100}$/) model!: string;
  @IsOptional() @IsString() @Length(19,1000) @Matches(/^sk_[a-zA-Z0-9_-]{16,}$/, { message: "Enter the ElevenLabs secret API key starting with sk_, not the key ID." }) apiKey?: string;
  @IsBoolean() enabled = true;
  @IsArray() @ArrayMaxSize(3) @ArrayUnique() @IsIn(['owner','manager','creator'], { each: true }) allowedRoles: ('owner'|'manager'|'creator')[] = ['owner'];
  @IsInt() @Min(1) @Max(3000) maxCharacters = 1500;
  @IsInt() @Min(1) @Max(1000) dailyRequests = 10;
  @IsInt() @Min(1) @Max(1000) dailyDraftRequests = 10;
  @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => AudioSkillDto) skills: AudioSkillDto[] = [];
}
export class GenerateAudioDto extends AudioQueryDto {
  @IsOptional() @IsString() @Length(1,200) projectTemplateId?: string;
  @IsString() @Length(1,100) profileId!: string;
  @Matches(/^[a-zA-Z0-9_-]{1,100}$/) voiceId!: string;
  @Matches(/^[a-z]{2,3}$/) language!: string;
  @IsString() @Length(1,3000) text!: string;
  @IsString() @Length(16,100) requestId!: string;
  @IsOptional() @IsString() @Length(1,100) contentItemId?: string;
  @IsOptional() @Matches(/^[a-z0-9][a-z0-9-]{0,63}$/) skillId?: string;
  @IsOptional() @IsBoolean() sample = false;
  @IsIn([true]) rightsConfirmed!: boolean;
}

export class DraftAudioScriptDto extends AudioQueryDto {
  @IsString() @Length(16,100) requestId!: string;
  @IsOptional() @IsString() @Length(1,200) projectTemplateId?: string;
  @IsString() @Length(1,100) profileId!: string;
  @IsString() @Length(1,100) contentItemId!: string;
  @Matches(/^[a-z]{2,3}$/) language!: string;
  @IsOptional() @Matches(/^[a-z0-9][a-z0-9-]{0,63}$/) skillId?: string;
  @IsOptional() @IsBoolean() sample = false;
}
