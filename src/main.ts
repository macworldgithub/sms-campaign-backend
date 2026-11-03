import './environment';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  app.useBodyParser('json', { limit: '8mb' });
  app.setGlobalPrefix('api');

  // Complete Swagger / OpenAPI Configuration
  const config = new DocumentBuilder()
    .setTitle('Booran SMS Campaign Operations API')
    .setDescription(
      'Enterprise SMS Campaign Orchestration and CRM Connector for Booran Motor Group (South Morang Hyundai).\n\n' +
        '### Capabilities\n' +
        '- **Campaign Operations**: Draft creation, compliance validation, and multi-part SMS dispatch.\n' +
        '- **Audience & Suppression**: Spam Act 2003 consent tracking, batch & XLSX imports, and automated opt-out suppression.\n' +
        '- **DealerSocket Integration**: Lead synchronization, Chrome automation worker jobs, and CRM manager routing.\n' +
        '- **Inbound Webhooks**: Landing page lead capture and MobileMessage delivery receipts & STOP opt-outs.\n' +
        '- **Shortlinks & Tracking**: Click tracking redirect with UTM analytics.',
    )
    .setVersion('1.0.0')
    .addApiKey(
      {
        type: 'apiKey',
        name: 'x-portal-key',
        in: 'header',
        description:
          'Operator & Worker authentication key (configured via PORTAL_API_KEY)',
      },
      'portal-key',
    )
    .addApiKey(
      {
        type: 'apiKey',
        name: 'x-webhook-key',
        in: 'header',
        description:
          'Landing page lead capture key (configured via LEAD_WEBHOOK_KEY)',
      },
      'webhook-key',
    )
    .addApiKey(
      {
        type: 'apiKey',
        name: 'x-mm-signature',
        in: 'header',
        description: 'HMAC-SHA256 signature for MobileMessage inbound webhooks',
      },
      'sms-webhook-signature',
    )
    .addTag('Health & System', 'System health checks and root status')
    .addTag(
      'Dashboard & Operations',
      'Operator portal state and readiness metrics',
    )
    .addTag('Campaigns', 'SMS campaign drafting, approvals, and dispatch')
    .addTag('Contacts & Audience', 'Audience contact imports (JSON and XLSX)')
    .addTag('Suppressions', 'Opt-out suppression list management')
    .addTag(
      'DealerSocket & Chrome Worker',
      'DealerSocket connector actions and Chrome worker synchronization',
    )
    .addTag(
      'Webhooks',
      'Inbound lead capture and SMS provider delivery webhooks',
    )
    .addTag('Tracking', 'Campaign click tracking and redirection')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    customSiteTitle: 'Booran • SMS Campaign API Documentation',
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
      docExpansion: 'list',
      filter: true,
    },
  });

  await app.listen(process.env.PORT ?? 4000, '127.0.0.1');
}
bootstrap();

