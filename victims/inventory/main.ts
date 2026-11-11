// Entry point: node victims/inventory/main.ts [--addr 127.0.0.1:8082] [--dsn ...] [--fixed]
import { startVictim } from '../common/main.ts';
import { newHandler } from './app.ts';

await startVictim('inventory', 8082, newHandler);
