const { writeAtomic } = require('./atomic-file.cjs');
const { readImage } = require('./image-files.cjs');

async function conversationMarkdown(exchanges, imageDirectory) {
  if (!Array.isArray(exchanges) || !exchanges.length || exchanges.some(exchange =>
    typeof exchange.question !== 'string' || typeof exchange.answer !== 'string' || (!exchange.answer.trim() && !exchange.interrupted))) {
    throw new Error('No completed conversation to save');
  }
  const sections = ['# Rozmowa\n'];
  for (const exchange of exchanges) {
    sections.push(`## Ty\n\n${exchange.question}\n\n## Asystent\n\n${exchange.answer}${exchange.interrupted ? '\n\n_Odpowiedź przerwana._' : ''}\n`);
    for (const image of exchange.images || []) {
      const bytes = await readImage(imageDirectory, image.id);
      const alt = String(image.alt || 'Wygenerowany obraz').replace(/[\[\]\r\n]/g, ' ');
      sections.push(`![${alt}](data:image/png;base64,${bytes.toString('base64')})\n`);
    }
  }
  return sections.join('\n');
}
async function saveConversation(filename, exchanges, imageDirectory) {
  const markdown = await conversationMarkdown(exchanges, imageDirectory);
  await writeAtomic(filename, markdown);
}
module.exports = { conversationMarkdown, saveConversation };
