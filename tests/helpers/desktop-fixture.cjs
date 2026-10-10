// Synthetic worker used only by the native UI scenarios. Production receives
// authoritative completed/pending snapshots from ApplicationController.
function createDesktopFixture() {
 let voice = {}; let conversationHistory = []; let revision = 0;
 const previousConversations = new Map();
 return { previousConversations, update(update = {}) {
  if (update.purgeHistory) previousConversations.clear();
  const switchedThread = 'threadId' in update && update.threadId !== voice.threadId;
  if (switchedThread && voice.threadId) {
    const exchanges = [...conversationHistory];
    if (voice.answer) exchanges.push({ question: voice.question, answer: voice.answer, ...(voice.images?.length && { images: voice.images }) });
    previousConversations.delete(voice.threadId);
    previousConversations.set(voice.threadId, exchanges);
    if (previousConversations.size > 2) previousConversations.delete(previousConversations.keys().next().value);
  }
  if (Array.isArray(update.exchanges) || update.restored) {
    const exchanges = update.exchanges || previousConversations.get(update.threadId) || [];
    const latest = exchanges.at(-1);
    conversationHistory = exchanges.slice(0, -1);
    update = { ...update, question: latest?.question || '', answer: latest?.answer || '', images: latest?.images || [] };
  } else if (update.reset) {
    conversationHistory = [];
    update = { ...update, question: '', answer: '', images: [] };
  } else if (voice.answer && (update.state === 'listening'
    || (typeof update.question === 'string' && (update.question !== voice.question || update.answer === '')))) {
    conversationHistory.push({ question: voice.question, answer: voice.answer, ...(voice.images?.length && { images: voice.images }) });
  }
  if (update.answer === '' && !('images' in update)) update = { ...update, images: [] };
  voice = { ...voice, message: '', ...update, history: conversationHistory };
return { ...voice, conversation: { id: voice.threadId || null, revision: ++revision,
  completed: voice.answer ? [...conversationHistory, { question: voice.question, answer: voice.answer, images: voice.images || [] }] : [...conversationHistory],
  pending: voice.answer ? null : { id: 'fixture-pending', revision, question: voice.question || '', answer: '' } } };

 } };
}
module.exports = { createDesktopFixture };
