import path from 'node:path';
import type { AppConfig } from './config.ts';
import { FileStore, MemoryStore, type OutingStore } from './store.ts';

export async function createStore(config: AppConfig): Promise<OutingStore> {
  if (config.storeAdapter === 'memory') return new MemoryStore();
  if (config.storeAdapter === 'mongodb') {
    if (!config.mongodbUri) throw new Error('STORE_ADAPTER=mongodb requires MONGODB_URI. Leave STORE_ADAPTER unset to use the local file store.');
    const { MongoStore } = await import('./store-mongo.ts');
    return MongoStore.connect(config.mongodbUri, config.mongodbDb);
  }
  const store = new FileStore(path.resolve(config.localStoreDir, 'outings'));
  await store.init();
  return store;
}
