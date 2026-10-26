import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './lib/config';
import { errorHandler } from './middleware/error-handler';
import { requestLogger } from './middleware/requestLogger';

import authRoutes from './routes/auth';
import documentRoutes from './routes/documents';
//import conversationRoutes from './routes/conversations';
import './events/auth.events';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger';
import './events/document.events';

import './queues/document.worker';
import { bullBoardAdapter } from './config/bull-board';

import './events/cache.events';  

import './events/security.events';  

import { sanitizeInput } from './middleware/sanitize';

import { metricsRegistry } from './lib/metrics';
import { metricsMiddleware } from './middleware/metricsMiddleware';
import './events/ingestion.events';  


const app = express();
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
});

// === MIDDLEWARE (runs on every request) ===
app.use(helmet());              // Security headers
app.use(cors());                // Cross-origin requests
app.use(express.json());        // Parse JSON request bodies
app.use(requestLogger);        // Request and response logging
app.use(sanitizeInput);         // Sanitize before anything else sees the data

// Apply IP-based rate limiting to API routes.
app.use('/api/v1', apiLimiter);

// === HEALTH CHECK ===
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: config.NODE_ENV,
  });
});

// === ROUTES (mounted here as you build them) ===
// app.use('/api/v1/auth', authRoutes);
// app.use('/api/v1/documents', documentRoutes);
// app.use('/api/v1/chat', chatRoutes);

app.use('/api/auth', authRoutes);

// API v1
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/documents', documentRoutes);

// Serve Swagger UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Also serve the raw JSON spec (useful for code generators)
app.get('/api-docs.json', (req, res) => {
  res.json(swaggerSpec);
});


// That's it. The import runs the file, which creates the worker.
// The worker starts listening for jobs immediately.



// Mount the dashboard (protect with auth in production)
app.use('/admin/queues', bullBoardAdapter.getRouter());

app.use(errorHandler);


app.use(metricsMiddleware);

// Metrics endpoint (no auth — Prometheus needs to scrape it)
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', metricsRegistry.contentType);
  res.send(await metricsRegistry.metrics());
});

app.use(healthRoutes);

export default app;
export { app };