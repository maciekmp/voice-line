// Compatibility entrypoint for older launch commands.
if (process.argv.includes('--debug-keys')) {
  await import('../scripts/diagnose-keys.ts');
} else if (process.argv.includes('--desktop')) {
  await import('./worker-main.ts');
} else {
  await import('./cli-main.ts');
}
