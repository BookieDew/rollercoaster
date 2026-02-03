import express from 'express';
import path from 'path';
import { config } from './config';
import { errorHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import routes from './routes';

const app = express();

// Body parsing middleware (captures raw body for HMAC verification)
app.use(express.json({
  verify: (req, _res, buf) => {
    (req as { rawBody?: string }).rawBody = buf.toString('utf8');
  },
}));

// Request logging
app.use(requestLogger);

// Demo UI (local use)
app.use('/demo', express.static(path.join(__dirname, '../public/demo')));

// Mount all routes
app.use('/api', routes);

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Global error handler (must be last)
app.use(errorHandler);

// Only start server if this file is run directly (not imported for tests)
let server: ReturnType<typeof app.listen> | null = null;

function startServer(port?: number): ReturnType<typeof app.listen> {
  const listenPort = port ?? config.server.port;
  server = app.listen(listenPort, () => {
    console.log(`Server running on port ${listenPort} in ${config.server.env} mode`);
  });
  return server;
}

// Auto-start only when run directly (not in test environment)
if (require.main === module) {
  startServer();
}

export { app, server, startServer };
