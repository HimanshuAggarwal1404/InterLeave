// Entry point: node src/cli/main.ts <command> [flags]
import { run } from './interleave.ts';

// exitCode instead of process.exit(): Node exits by itself once nothing is
// left running, so a leaked socket or timer would show up as a hang.
process.exitCode = await run(process.argv.slice(2));
