// Entry point: node victims/seat/main.ts [--addr 127.0.0.1:8083] [--dsn ...] [--fixed]
import { startVictim } from '../common/main.ts';
import { newHandler } from './app.ts';

await startVictim('seat', 8083, newHandler);
