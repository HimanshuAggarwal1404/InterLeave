// Entry point: node victims/approval/main.ts [--addr 127.0.0.1:8087] [--dsn ...] [--fixed]
import { startVictim } from '../common/main.ts';
import { newHandler } from './app.ts';

await startVictim('approval', 8087, newHandler);
