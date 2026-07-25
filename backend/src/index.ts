import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { pool, waitForDatabase } from './db';
import { HttpError } from './http';
import { migrate } from './migrations';
import { connectionsRouter } from './routes/connections';
import { locationsRouter } from './routes/locations';
import { mapsRouter } from './routes/maps';

const PORT = Number(process.env.PORT ?? 4000);

async function main() {
  await waitForDatabase();
  await migrate();

  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: process.env.CORS_ORIGIN ?? true }));
  app.use(express.json({ limit: '32mb' }));

  app.get('/api/health', async (_req, res) => {
    const r = await pool.query('SELECT now() AS now');
    res.json({ ok: true, db: r.rows[0].now });
  });

  app.use('/api/maps', mapsRouter);
  app.use('/api', locationsRouter);
  app.use('/api', connectionsRouter);

  app.use((_req, res) => res.status(404).json({ error: 'route not found' }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: 'validation failed', details: err.issues });
    }
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('[error]', err);
    const message = err instanceof Error ? err.message : 'internal error';
    res.status(500).json({ error: message });
  });

  app.listen(PORT, () => console.log(`[api] listening on :${PORT}`));
}

main().catch((err) => {
  console.error('fatal startup error', err);
  process.exit(1);
});
