// Entry point: node victims/username/main.ts [--addr 127.0.0.1:8085] [--dsn ...] [--fixed]
import { startVictim } from '../common/main.ts';
import { newHandler } from './app.ts';

await startVictim('username', 8085, newHandler);
