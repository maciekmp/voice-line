import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startCli } from '../../src/cli.ts';
import { ApplicationController, type AudioRecorder } from '../../src/application-controller.ts';
import { ApplicationInput } from '../../src/application-input.ts';
import type { ApplicationEvent } from '../../src/application-contract.ts';
import type { VoiceEngine } from '../../src/voice-engine.ts';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(condition: () => boolean) {
  for (let i = 0; i < 100; i++) { if (condition()) return; await flush(); }
  assert.ok(condition(), 'Expected terminal event');
}
function fixture(terminal = false, save?: NonNullable<Parameters<typeof startCli>[0]>['save']) {
  const previousTerminal = process.env.TERM;
  if (terminal) process.env.TERM = 'xterm'; // Model an editable terminal, not the runner's TERM=dumb.
  const stdin = new PassThrough(), stdout = new PassThrough();
  let output = ''; stdout.on('data', value => { output += value.toString(); });
  const prompts: string[] = [], events: ApplicationEvent[] = [];
  let core!: ApplicationController, input!: ApplicationInput;
  let time = 0;
  const timers = new Map<object, { at: number; callback: () => void }>();
  const clock = { now: () => time,
    setTimeout(callback: () => void, delay: number) {
      const timer = { unref() {} }; timers.set(timer, { at: time + delay, callback });
      return timer as ReturnType<typeof setTimeout>;
    },
    clearTimeout(timer: ReturnType<typeof setTimeout> | undefined) { if (timer) timers.delete(timer); },
    setInterval, clearInterval,
  };
  let stopped = 0, captures = 0, audioTurns = 0;
  const engine: VoiceEngine = {
    mode: 'local', startupDescription: 'fake', currentThreadId: 'conversation', currentExchanges: [], canRestorePrevious: false,
    start: async () => {}, startVoice: async () => {}, startPlayback: async () => {},
    stop() { stopped++; }, cancel() {}, reset() { engine.currentExchanges.length = 0; }, expireConversation() {}, restorePrevious: async () => false,
    respond: async text => {
      prompts.push(text); const reply = { prompt: text, answer: `Odpowiedź: ${text}`, questionSource: 'text' as const };
      engine.currentExchanges.push({ id: `turn-${prompts.length}`, revision: 1, question: text, answer: reply.answer, questionSource: 'text' }); return reply;
    },
    respondAudio: async () => {
      audioTurns++;
      const reply = { prompt: 'Pytanie głosowe', answer: 'Odpowiedź głosowa' };
      engine.currentExchanges.push({ id: `voice-${audioTurns}`, revision: 1, question: reply.prompt, answer: reply.answer, questionSource: 'voice' }); return reply;
    },
  };
  const recorder: AudioRecorder = { startCapture: async () => {}, start() { captures++; }, stop: async () => 'fake.wav', cancel() {}, shutdown() {},
    lastDurationSeconds: 1, lastRmsDbfs: -10, lastPeakDbfs: -5 };
  const cli = startCli({ input: stdin, output: stdout, terminal, save,
    createRuntime(emit) {
      const publish = (event: ApplicationEvent) => { events.push(event); emit(event); };
      core = new ApplicationController({ engine, recorder, clock, emit: publish, removeAudio: async () => {}, log: { log() {}, error() {} } });
      input = new ApplicationInput(core, publish, { clock });
      return { snapshot: () => core.snapshot(), dispatch: value => input.dispatch(value), start: () => core.start(),
        shutdown: () => { input.dispose(); return core.shutdown(); } };
    },
  });
  const shutdown = async () => {
    await cli.shutdown();
    if (previousTerminal === undefined) delete process.env.TERM; else process.env.TERM = previousTerminal;
  };
  return { cli: { ...cli, shutdown }, stdin, engine, recorder, prompts, events,
    get output() { return stripVTControlCharacters(output); }, get core() { return core; }, get input() { return input; },
    get stopped() { return stopped; }, get captures() { return captures; }, get audioTurns() { return audioTurns; },
    advance(ms: number) {
      time += ms;
      for (const [timer, value] of timers) if (value.at <= time) { timers.delete(timer); value.callback(); }
    },
  };
}

test('piped CLI waits for startup and successive turns, renders text and history, and shuts down on EOF', async () => {
  const f = fixture();
  f.stdin.end('Pierwsze pytanie\nDrugie pytanie\n/history\n');
  await f.cli.finished;
  assert.deepEqual(f.prompts, ['Pierwsze pytanie', 'Drugie pytanie']);
  assert.match(f.output, /Asystent: Odpowiedź: Pierwsze pytanie/);
  assert.match(f.output, /Asystent: Odpowiedź: Drugie pytanie/);
  assert.equal(f.output.match(/Rozmowa tekstowa gotowa\./g)?.length, 1);
  assert.equal(f.output.match(/Nagrywanie gotowe/g)?.length, 1);
  assert.equal(f.stopped, 1);
});

test('CLI multiline text preserves line breaks and slash content; new and previous use the shared controller', async () => {
  const f = fixture();
  f.stdin.end('/paste\npierwszy wiersz\n/new is literal in paste\nostatni wiersz\n/send\n/new\n/previous\n');
  await f.cli.finished;
  assert.deepEqual(f.prompts, ['pierwszy wiersz\n/new is literal in paste\nostatni wiersz']);
  assert.match(f.output, /Nowa rozmowa/);
  assert.match(f.output, /Brak poprzedniej rozmowy/);
});

test('interactive CLI preserves a draft across asynchronous output and voice holds, and supports Copilot taps', async t => {
  const f = fixture(true); t.after(() => f.cli.shutdown());
  await until(() => f.core.snapshot().capabilities.recording.state === 'ready');
  f.stdin.write('mój draft'); await flush();
  f.input.handleKey({ event: 'down', vk: 134, scan: 0, flags: 0 });
  f.advance(250);
  f.input.handleKey({ event: 'up', vk: 134, scan: 0, flags: 0 });
  await until(() => f.audioTurns === 1 && f.core.snapshot().state === 'idle');
  f.stdin.write('\r'); await until(() => f.prompts.length === 1);
  assert.deepEqual(f.prompts, ['mój draft']);
  assert.match(f.output, /Ty \(głos\): Pytanie głosowe/);
  const audioTurns = f.audioTurns;
  f.input.handleKey({ event: 'down', vk: 134, scan: 0, flags: 0 });
  f.advance(80); f.input.handleKey({ event: 'up', vk: 134, scan: 0, flags: 0 });
  await flush(); assert.equal(f.audioTurns, audioTurns);
  assert.match(f.output, /Wpisz wiadomość lub przytrzymaj Copilot/);
});

test('interactive CLI rejects busy input without losing its draft and cancels inference on Copilot key-down', async t => {
  const f = fixture(true); t.after(() => f.cli.shutdown());
  await until(() => f.core.snapshot().ready);
  let resolve!: () => void; let aborted = false;
  f.engine.respond = async (_text, signal) => {
    signal?.addEventListener('abort', () => { aborted = true; });
    await new Promise<void>(done => { resolve = done; }); return { prompt: 'Q', answer: 'late' };
  };
  f.stdin.write('pierwsze\r'); await until(() => Boolean(resolve));
  f.stdin.write('drugi draft\r'); await flush();
  assert.match(f.output, /Trwa operacja/);
  f.stdin.write('\x1b[D'.repeat(5)); await flush();
  f.input.handleKey({ event: 'down', vk: 134, scan: 0, flags: 0 });
  assert.equal(aborted, true);
  f.advance(80); f.input.handleKey({ event: 'up', vk: 134, scan: 0, flags: 0 });
  assert.match(f.output, /Wpisz poprawione pytanie/);
  resolve(); await flush();
  assert.doesNotMatch(f.output, /Asystent: late/);
  f.engine.respond = async text => { f.prompts.push(text); return { prompt: text, answer: 'corrected' }; };
  f.stdin.write('poprawione\r'); await until(() => f.prompts.length === 1);
  assert.deepEqual(f.prompts, ['poprawione'], 'Correction clears the entire draft even when the cursor was in its middle');
});

test('terminal output strips provider escape sequences and retry ignores events from the old runtime', async t => {
  const f = fixture(true); t.after(() => f.cli.shutdown());
  await until(() => f.core.snapshot().ready);
  const original = f.core;
  f.engine.respond = async text => {
    f.engine.currentExchanges.push({ question: text, answer: '\x1b[31mred\x1b[0m\x1b]0;injected-title\x07' });
    return { prompt: text, answer: 'red' };
  };
  f.stdin.write('test\r'); await until(() => f.output.includes('Asystent: red'));
  assert.doesNotMatch(f.output, /injected-title/);
  await f.cli.restart(); assert.notEqual(f.core, original);
  assert.equal(original.snapshot().health, 'stopped');
});

test('CLI export receives a detached completed history and quoted destination paths', async () => {
  const exports: { file: string; history: unknown }[] = [];
  const f = fixture(false, async (file, history) => { exports.push({ file, history }); });
  f.stdin.end('Zapisz odpowiedź\n/save "folder with spaces/rozmowa.md"\n/new\n');
  assert.equal(await f.cli.finished, 0);
  assert.equal(exports.length, 1);
  assert.match(exports[0].file, /folder with spaces[\\/]rozmowa.md$/);
  assert.deepEqual(exports[0].history, [{ id: 'turn-1', revision: 1, question: 'Zapisz odpowiedź', answer: 'Odpowiedź: Zapisz odpowiedź', questionSource: 'text' }]);
  assert.match(f.output, /Zapisano rozmowę/);
});

test('real CLI entrypoint stays usable after configuration failure and reports failure to piped callers', async () => {
  const child = spawn(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('../../src/cli-main.ts', import.meta.url))], {
    env: { ...process.env, CODEX_MODE: 'invalid-test-mode' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  const done = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  child.stdin.end('/status\n/quit\n');
  assert.equal(await done, 1);
  assert.match(stdout, /CODEX_MODE/); assert.match(stdout, /Usługi nie są gotowe/);
  assert.equal(stderr, '');
});
