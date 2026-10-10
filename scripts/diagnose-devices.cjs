const { spawn } = require('node:child_process');
const { loadProjectEnv, projectRoot } = require('./lib/project.cjs');

function deviceListingSucceeded(output) {
  return /\[dshow[^\]]*\]\s+"[^"\r\n]+"\s+\((?:audio|video)\)/i.test(output)
    || /DirectShow (?:audio|video) devices/i.test(output);
}

function diagnoseDevices() {
  loadProjectEnv();
  const child = spawn(process.env.FFMPEG_BIN || 'ffmpeg.exe', ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
    { cwd: projectRoot, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let failed = false;
  for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.setEncoding('utf8').on('data', chunk => { output = (output + chunk).slice(-100_000); destination.write(chunk); });
  }
  child.once('error', error => { failed = true; console.error(`Cannot list audio devices: ${error.message}`); });
  child.once('close', code => {
    // FFmpeg intentionally exits nonzero after listing DirectShow devices.
    process.exitCode = !failed && deviceListingSucceeded(output) ? 0 : code || 1;
  });
}

if (require.main === module) {
  try { diagnoseDevices(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { deviceListingSucceeded };
