// Entry point: node victims/transfer/main.ts [--addr 127.0.0.1:8086] [--dsn ...] [--fixed]
import { startVictim } from '../common/main.ts';
import { newHandler } from './app.ts';

await startVictim('transfer', 8086, newHandler);
