// Entry point: node victims/ledger/main.ts [--addr 127.0.0.1:8089] [--dsn ...] [--fixed]
import { startVictim } from '../common/main.ts';
import { newHandler } from './app.ts';

await startVictim('ledger', 8089, newHandler);
