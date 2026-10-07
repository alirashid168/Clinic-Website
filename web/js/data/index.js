// Picks the data layer: live Supabase when configured, otherwise demo data.
// Both are loaded only when needed, so the live site never downloads the demo
// dataset (and the demo never downloads the Supabase code).
import { DEMO_MODE } from '../config.js';

let adapterPromise;

export function getData() {
  if (!adapterPromise) {
    adapterPromise = (DEMO_MODE
      ? import('./demo.js').then((m) => m.createDemoAdapter())
      : import('./supabase.js').then((m) => m.createSupabaseAdapter())
    ).catch((e) => { adapterPromise = null; throw e; }); // a failed load can be tried again
  }
  return adapterPromise;
}
