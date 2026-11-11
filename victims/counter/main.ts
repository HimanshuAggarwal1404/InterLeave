// Entry point: node victims/counter/main.ts [--addr 127.0.0.1:8088] [--dsn ...] [--fixed]
import { startVictim } from '../common/main.ts';
import { newHandler } from './app.ts';

await startVictim('counter', 8088, newHandler);
