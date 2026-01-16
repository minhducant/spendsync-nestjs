import * as dotenv from 'dotenv';
dotenv.config();
import helmet from 'helmet';
import * as config from 'config';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import * as Sentry from '@sentry/node';
import * as compression from 'compression';
import { NestFactory } from '@nestjs/core';
import fastifyCsrf from '@fastify/csrf-protection';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Logger, VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModules } from 'src/app.module';
import { BodyValidationPipe } from 'src/shares/pipes/body.validation.pipe';
import { HttpExceptionFilter } from 'src/shares/filters/http-exception.filter';
import { SentryInterceptor } from 'src/shares/interceptors/sentry.interceptor';
import { ResponseTransformInterceptor } from 'src/shares/interceptors/response.interceptor';

const { name, port, prefix, node_env, sentry_dns } = config.get<any>('app');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModules,
    new FastifyAdapter({
      bodyLimit: 50 * 1024 * 1024,
    }),
  );
  Sentry.init({
    dsn: sentry_dns,
    environment: node_env,
  });
  app.use(helmet());
  app.enableCors({});
  app.use(compression());
  app.register(fastifyCsrf);
  app.enableShutdownHooks();
  app.setGlobalPrefix(prefix);
  app.register(require('@fastify/multipart'), {
    limits: { fileSize: 50 * 1024 * 1024 },
  });
  app.useWebSocketAdapter(new IoAdapter(app));
  app.useGlobalPipes(new BodyValidationPipe());
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new SentryInterceptor());
  app.enableVersioning({ type: VersioningType.URI });
  app.useGlobalInterceptors(new ResponseTransformInterceptor());
  const options = new DocumentBuilder()
    .addBearerAuth()
    .setTitle(name)
    .setVersion('0.0.1')
    .setDescription(`${name} description`)
    .setExternalDoc('Postman Collection', `/${prefix}/docs-json`)
    .build();
  const document = SwaggerModule.createDocument(app, options);
  SwaggerModule.setup(`${prefix}/docs`, app, document, {
    customSiteTitle: name,
    swaggerUiEnabled: true,
    swaggerOptions: {
      filter: true,
      deepLinking: true,
      docExpansion: 'list',
      persistAuthorization: true,
      displayRequestDuration: true,
      defaultModelsExpandDepth: -1,
    },
  });
  await app.listen(port).then(async () => {
    const logger = app.get(Logger);
    logger.debug(
      `Application is running on: ${await app.getUrl()}/${prefix}/docs/#/`,
    );
  });
}
bootstrap();
