import path from 'node:path';
import { networkInterfaces } from 'node:os';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { OsmGeoProvider, OsmRouteProvider, osmConfigFromEnv } from '../geo/osm.ts';
import { OutingService } from './service.ts';
import { createStore } from './store-factory.ts';
import { createPlanningEngine } from '../workflows/planning.ts';
import { initTelemetry } from '../telemetry.ts';

import { existsSync } from 'node:fs';

// Optional .env (Node's built-in loader; no dependency). Real environment variables take precedence.
if (existsSync('.env')) process.loadEnvFile('.env');
const config = loadConfig();
const sentryOn = await initTelemetry(process.env.SENTRY_DSN || null);
const osm = osmConfigFromEnv();
const store = await createStore(config);
const service = new OutingService(store, new OsmGeoProvider(osm), new OsmRouteProvider(osm), config, () => new Date(), null);
service.planning = createPlanningEngine({
  now: () => Date.now(), ollama: () => service.ollamaConfig(),
  runLogFile: path.resolve(config.localStoreDir, 'workflow-runs.jsonl'),
});
const staticDir = path.resolve('dist', 'web');
if (!existsSync(path.join(staticDir, 'index.html'))) console.warn('No built web app found. Run "npm run build" first (or use "npm run dev").');
const app = createApp(service, config, { staticDir });

const sweep = async () => {
  try { const n = await store.deleteExpired(new Date()); if (n) console.log(`[retention] deleted ${n} expired outing(s)`); } catch (e) { console.error('[retention] sweep failed:', (e as Error).message); }
};
await sweep();
setInterval(sweep, 60 * 60 * 1000).unref();

app.listen(config.port, config.bindHost, () => {
  console.log(`Common Ground listening on http://${config.bindHost}:${config.port}`);
  console.log(`  store:   ${store.name}`);
  console.log(`  planning: Mastra workflow plan-outing (in-memory runs; run log in ${config.localStoreDir}/workflow-runs.jsonl)`);
  console.log(`  Sentry:  ${sentryOn ? 'enabled (manual spans only, scrubbed)' : 'off (no SENTRY_DSN)'}`);
  console.log(`  AI:      ${config.aiEnabled ? `Ollama ${config.ollamaModel} (local)` : 'disabled'}`);
  console.log(`  places:  ${service.geo.name} — real data, © OpenStreetMap contributors`);
  console.log(`  routing: ${service.routes.name}${service.routes.transitAvailable ? '' : ' (public transport: people enter their usual time; set TRANSITOUS_ENABLED=true to use timetables)'}`);
  if (config.bindHost === '0.0.0.0') {
    for (const addrs of Object.values(networkInterfaces())) for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  on your Wi-Fi: http://${a.address}:${config.port}`);
    }
  }
});
