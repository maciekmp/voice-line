import { startCli } from './cli.ts';

const cli = startCli({ debug: process.argv.includes('--debug') });
const stop = () => { void cli.shutdown(); };
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.exitCode = await cli.finished;
process.removeListener('SIGTERM', stop);
process.removeListener('SIGINT', stop);
