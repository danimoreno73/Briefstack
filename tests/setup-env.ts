import { afterAll } from 'vitest';
import { isolateEnvironment } from './sandboxEnv.js';

// Runs before every test file (vitest `setupFiles`).
const remove = isolateEnvironment({ appData: true });
afterAll(remove);
