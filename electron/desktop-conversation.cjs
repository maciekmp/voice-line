// Presentation only: committed history and undo belong to the worker.
// No inferred commits, archives or expiry rules live in the desktop process.
/** @param {Partial<import('../src/desktop-contract.ts').DesktopVoice>} [initial] */
function createConversationPresentation(initial = {}) {
  /** @type {import('../src/application-contract.ts').ConversationView} */
  let conversation = { id: null, revision: 0, completed: [], pending: null };
  /** @type {import('../src/desktop-contract.ts').DesktopVoice} */
  let voice = { state: 'starting', ready: false, question: '', answer: '', message: '', history: [], images: [], conversation, ...initial };
  return {
    /** @param {Partial<import('../src/desktop-contract.ts').DesktopVoice>} [update] */
    update(update = {}) {
      if (update.conversation) {
        conversation = update.conversation;
        const active = conversation.pending || conversation.completed.at(-1);
        voice = { ...voice, message: '', ...update,
          interrupted: !!(active && 'interrupted' in active && active.interrupted),
          threadId: conversation.id, question: active?.question || '', answer: active?.answer || '',
          images: active && 'images' in active ? active.images || [] : [],
          history: conversation.pending ? conversation.completed : conversation.completed.slice(0, -1) };
      } else {
        // Local health and optimistic input may change the display, never history.
        voice = { ...voice, message: '', ...update };
        if (typeof update.question === 'string' && update.answer === '') {
          voice.history = conversation.completed;
          voice.images = [];
        }
      }
      return voice;
    },
    get completed() { return conversation.completed; },
  };
}
module.exports = { createConversationPresentation };
