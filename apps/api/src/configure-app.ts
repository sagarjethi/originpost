import { ValidationPipe, VersioningType } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import multipart from "@fastify/multipart";
import { DomainExceptionFilter } from "./common/domain-exception.filter.js";

export function configureApp(app: NestFastifyApplication, config: ConfigService): void {
  void app.register(multipart, {
    limits: { files: 2, fields: 8, parts: 12, fileSize: 500 * 1024 * 1024, fieldSize: 16 * 1024 },
  });
  app.enableCors({
    origin: config.get<string>("CORS_ORIGIN") ?? "http://localhost:3000",
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  });
  app.enableVersioning({ type: VersioningType.URI, prefix: "v", defaultVersion: "1" });
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  }));
  app.useGlobalFilters(new DomainExceptionFilter());
  app.enableShutdownHooks();
}
