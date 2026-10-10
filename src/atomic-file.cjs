const fs = require('node:fs/promises');
const { dirname, basename, join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: pause } = require('node:timers/promises');

async function writeAtomic(filename, contents, filesystem = fs) {
  const temporary = join(dirname(filename), `.${basename(filename)}.${randomUUID()}.tmp`);
  try {
    await filesystem.writeFile(temporary, contents, { flag: 'wx' });
    for (let attempt = 0; ; attempt++) {
      try { await filesystem.rename(temporary, filename); break; }
      catch (error) {
        if (process.platform !== 'win32' || error.code !== 'EPERM' || attempt === 3) throw error;
        await pause(20 * (attempt + 1));
      }
    }
  } finally {
    await filesystem.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
function writeAtomicSync(filename, contents, filesystem = require('node:fs')) {
  const temporary = join(dirname(filename), `.${basename(filename)}.${randomUUID()}.tmp`);
  filesystem.mkdirSync(dirname(filename), { recursive: true });
  try {
    filesystem.writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx' });
    for (let attempt = 0; ; attempt++) {
      try { filesystem.renameSync(temporary, filename); break; }
      catch (error) {
        if (process.platform !== 'win32' || error.code !== 'EPERM' || attempt === 3) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
      }
    }
  } finally {
    try { filesystem.unlinkSync(temporary); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
module.exports = { writeAtomic, writeAtomicSync };
