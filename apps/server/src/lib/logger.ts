import pino from 'pino';
import { config } from './config.ts';

/** Structured JSON logs (the api uses the same logger through Fastify). */
export const logger = pino({ level: config.logLevel, base: { service: process.env.SERVICE_NAME ?? 'server' } });
