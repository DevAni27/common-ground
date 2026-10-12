/** TEST-ONLY server for offline browser checks: real app, fake OSM providers. Never used by `npm start`. */
import path from 'node:path';
import { createApp } from '../src/server/app.ts';
import { loadConfig } from '../src/server/config.ts';
import { OutingService } from '../src/server/service.ts';
import { MemoryStore } from '../src/server/store.ts';
import { createPlanningEngine } from '../src/workflows/planning.ts';
import { FakeGeo, FakeRoutes } from './fixtures/fake-geo.ts';

const config = loadConfig();
const service = new OutingService(new MemoryStore(), new FakeGeo(), new FakeRoutes(true), config);
service.planning = createPlanningEngine({ now: () => Date.now(), ollama: () => service.ollamaConfig(), runLogFile: null });
createApp(service, config, { staticDir: path.resolve('dist', 'web') }).listen(config.port, '127.0.0.1', () => console.log(`e2e server on ${config.port}`));
