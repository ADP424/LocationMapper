import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { pool, waitForDatabase } from './db';
import { HttpError, ah, pgErrorResponse } from './http';
import { ensureSchema } from './schema';
import { seedDemoMap } from './seed';
import { connectionsRouter } from './routes/connections';
import { groupsRouter } from './routes/groups';
import { labelsRouter } from './routes/labels';
import { locationsRouter } from './routes/locations';
import { mapsRouter } from './routes/maps';

const PORT = Number(process.env.PORT ?? 4000);

async function main() {
  await waitForDatabase();
  /* the schema is idempotent; a brand-new database also gets the demo map */
  if (await ensureSchema()) await seedDemoMap();

  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: process.env.CORS_ORIGIN ?? true }));
  app.use(express.json({ limit: '32mb' }));

  /* a healthcheck must fail fast, not hang on a dead connection */
  app.get(
    '/api/health',
    ah(async (_req, res) => {
      const timeout = new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new HttpError(503, 'database did not respond')), 2_000)
      );
      const result = await Promise.race([pool.query('SELECT now() AS now'), timeout]);
      res.json({ ok: true, db: (result as { rows: Array<{ now: string }> }).rows[0].now });
    })
  );

  app.use('/api/maps', mapsRouter);
  app.use('/api', groupsRouter);
  app.use('/api', labelsRouter);
  app.use('/api', locationsRouter);
  app.use('/api', connectionsRouter);

  app.use((_req, res) => res.status(404).json({ error: 'route not found' }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: 'validation failed', details: err.issues });
    }
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    const pg = pgErrorResponse(err);
    if (pg) {
      if (pg.status >= 500) console.error('[db]', err);
      return res.status(pg.status).json(pg.body);
    }
    console.error('[error]', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'internal error' });
  });

  app.listen(PORT, () => console.log(`[api] listening on :${PORT}`));
}

main().catch((err) => {
  console.error('fatal startup error', err);
  process.exit(1);
});
