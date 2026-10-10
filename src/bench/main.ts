// Entry point: node src/bench/main.ts [flags] [URL ...]
import { run } from './bench.ts';

process.exitCode = await run(process.argv.slice(2));
