// Structured logging configuration (pino via Fastify). Operational logs are separated from user
// content: we never log cookies, authorization headers, request bodies, or signed file tokens.
import type { FastifyServerOptions } from 'fastify';

const TOKEN_IN_PATH = /(\/api\/files\/t\/)[^/?#]+/;

export function redactUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  return url.replace(TOKEN_IN_PATH, '$1[redacted]');
}

export function loggerOptions(level: string): FastifyServerOptions['logger'] {
  if (level === 'silent') return false;
  return {
    level,
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        'res.headers["set-cookie"]',
        '*.password',
        '*.current_password',
        '*.new_password',
        '*.recovery_code',
        '*.token',
      ],
      censor: '[redacted]',
    },
    serializers: {
      req(req: { method?: string; url?: string; id?: string; ip?: string; headers?: Record<string, unknown> }) {
        return {
          id: req.id,
          method: req.method,
          url: redactUrl(req.url),
          ua: typeof req.headers?.['user-agent'] === 'string' ? (req.headers['user-agent'] as string).slice(0, 200) : undefined,
        };
      },
    },
  };
}
