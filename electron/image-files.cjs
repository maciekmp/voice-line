const fs = require('node:fs/promises');
const path = require('node:path');
function imagePath(directory, id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid image ID');
  return path.join(directory, `${id}.png`);
}
async function readImage(directory, id) {
  const filename = imagePath(directory, id);
  const info = await fs.stat(filename);
  if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error('Invalid image size');
  const bytes = await fs.readFile(filename);
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid PNG');
  return bytes;
}
module.exports = { imagePath, readImage };
