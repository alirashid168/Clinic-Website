// Picks the data layer: live Supabase when configured, otherwise demo data.
import { DEMO_MODE } from '../config.js';
import { createDemoAdapter } from './demo.js';

let adapterPromise;

export function getData() {
  if (!adapterPromise) {
    adapterPromise = DEMO_MODE
      ? Promise.resolve(createDemoAdapter())
      : import('./supabase.js').then((m) => m.createSupabaseAdapter());
  }
  return adapterPromise;
}
