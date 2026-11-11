// Entry point: node victims/wallet/main.ts [--addr 127.0.0.1:8084] [--dsn ...] [--fixed]
import { startVictim } from '../common/main.ts';
import { newHandler } from './app.ts';

await startVictim('wallet', 8084, newHandler);
