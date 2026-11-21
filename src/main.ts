import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule, ObserveInstrument } from './app.module.js';

async function bootstrap() {
    const app = await NestFactory.create<NestExpressApplication>(AppModule, {
        instrument: ObserveInstrument,
    });
    const root = join(import.meta.dirname, '..');
    app.useStaticAssets(join(root, 'public'));
    app.useStaticAssets(
        join(root, 'node_modules', 'markdown-it', 'dist', 'browser'),
        { prefix: '/vendor/markdown-it' },
    );
    app.useStaticAssets(
        join(root, 'node_modules', '@highlightjs', 'cdn-assets'),
        { prefix: '/vendor/highlight' },
    );
    app.enableShutdownHooks();
    const config = app.get(ConfigService);
    await app.listen(
        config.getOrThrow<number>('PORT'),
        config.getOrThrow<string>('HOST'),
    );
}
await bootstrap();
