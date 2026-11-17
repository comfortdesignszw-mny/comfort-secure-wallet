import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { correlationIdMiddleware } from './security/middleware.ts';
import { createV1Router } from './routes/v1.ts';

export function createApiApp() {
  const app = express();
  app.set('trust proxy', 1);

  app.use(
    helmet({
      xFrameOptions: false,
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", 'blob:', 'https://apis.google.com', 'https://www.gstatic.com', 'https://accounts.google.com', 'https://*.firebaseapp.com'],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://accounts.google.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
          imgSrc: ["'self'", 'data:', 'blob:', 'https://*.googleusercontent.com', 'https:'],
          workerSrc: ["'self'", 'blob:'],
          connectSrc: [
            "'self'",
            'ws:',
            'wss:',
            'https://*.googleapis.com',
            'https://*.firebaseio.com',
            'https://*.firebaseapp.com',
            'https://identitytoolkit.googleapis.com',
            'https://securetoken.googleapis.com',
            'https://accounts.google.com',
          ],
          frameSrc: ["'self'", 'https://*.firebaseapp.com', 'https://accounts.google.com', 'https://*.google.com'],
          frameAncestors: [
            "'self'",
            'https://aistudio.google.com',
            'https://*.google.com',
            'https://*.googleusercontent.com',
            'https://*.usercontent.goog',
          ],
        },
      },
    }),
  );

  app.use(cookieParser());
  app.use(express.json({ limit: '4mb' }));
  app.use(correlationIdMiddleware);

  app.use('/api/v1', createV1Router());

  return app;
}
