/** Runtime configuration, read from environment variables. */
import { DEFAULT_SERVER_PORT } from '@hub/shared';

export const config = {
  port: Number(process.env.PORT ?? DEFAULT_SERVER_PORT),
  host: process.env.HOST ?? '0.0.0.0',
  /**
   * Comma separated list of origins allowed to call the REST endpoints,
   * e.g. "https://hub.example.com". "*" (default) allows any origin.
   */
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim()),
  logLevel: process.env.LOG_LEVEL ?? 'info',
};
