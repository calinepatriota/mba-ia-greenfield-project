import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateVideoDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  @IsString()
  @IsNotEmpty()
  contentType: string;

  @IsString()
  @IsOptional()
  @MaxLength(10)
  fileExtension?: string;
}
