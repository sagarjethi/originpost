import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module.js";
import { configureApp } from "./configure-app.js";

export async function bootstrap(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ logger: true, routerOptions: { maxParamLength: 2048 } }), { rawBody: true });
  const config = app.get(ConfigService);
  configureApp(app, config);
  await app.listen(config.get<number>("API_PORT") ?? 4000, "0.0.0.0");
  return app;
}

if (process.env.NODE_ENV !== "test") await bootstrap();
