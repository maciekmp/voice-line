/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** @param {unknown} value @returns {value is number} */
function revision(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
/** @param {unknown} value @returns {value is string} */
function identifier(value) { return typeof value === 'string' && value.length > 0; }
/** @param {unknown} value @returns {value is string} */
function imageId(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
/** @param {unknown} value */
function images(value) {
  return Array.isArray(value) && value.every(item => record(item) && imageId(item.id) && typeof item.alt === 'string');
}
/** @param {unknown} value */
function exchange(value) {
  return record(value) && typeof value.question === 'string' && typeof value.answer === 'string'
    && (value.id === undefined || identifier(value.id)) && (value.revision === undefined || revision(value.revision))
    && (value.images === undefined || images(value.images))
    && (value.imageTask === undefined || (record(value.imageTask) && identifier(value.imageTask.threadId) && identifier(value.imageTask.turnId)));
}
/** @param {unknown} value @returns {value is import('./application-contract.ts').ConversationView} */
function conversation(value) {
  if (!record(value) || !(value.id === null || identifier(value.id)) || !revision(value.revision)
    || !Array.isArray(value.completed) || !value.completed.every(exchange)) return false;
  const ids = value.completed.map(item => item.id).filter(id => id !== undefined);
  if (new Set(ids).size !== ids.length) return false;
  const pending = value.pending;
  return pending === null || (record(pending) && identifier(pending.id) && revision(pending.revision)
    && typeof pending.question === 'string' && typeof pending.answer === 'string');
}
/** @param {import('./application-contract.ts').ConversationView} value */
function copyConversation(value) {
  return { id: value.id, revision: value.revision,
    completed: value.completed.map(item => ({ question: item.question, answer: item.answer,
      ...(item.id !== undefined && { id: item.id }), ...(item.revision !== undefined && { revision: item.revision }),
      ...(item.images !== undefined && { images: item.images.map(image => ({ id: image.id, alt: image.alt })) }),
      ...(item.imageTask !== undefined && { imageTask: { threadId: item.imageTask.threadId, turnId: item.imageTask.turnId } }),
    })),
    pending: value.pending && { id: value.pending.id, revision: value.pending.revision,
      question: value.pending.question, answer: value.pending.answer },
  };
}

/** @param {string} channel @param {unknown} value @returns {import('./desktop-contract.ts').DesktopRequest | null} */
function parseDesktopRequest(channel, value) {
  if (channel === 'voice:text') {
    return typeof value === 'string' && value.trim() && value.length <= 12000 ? { channel, value: value.trim() } : null;
  }
  if (channel === 'voice:copy-code') return typeof value === 'string' ? { channel, value } : null;
  if (channel === 'voice:image-preview' || channel === 'voice:image-save') return imageId(value) ? { channel, value } : null;
  if (channel === 'voice:hover' || channel === 'voice:composer-focus') return typeof value === 'boolean' ? { channel, value } : null;
  if (channel === 'voice:command') {
    if (typeof value !== 'string' || !['record', 'release', 'cancel', 'reset', 'previous', 'pin', 'hide', 'retry'].includes(value)) return null;
    return { channel, value: /** @type {import('./desktop-contract.ts').DesktopCommand} */ (value) };
  }
  if (channel === 'voice:resize') {
    if (!record(value) || typeof value.height !== 'number' || !Number.isFinite(value.height) || value.height < 0
      || !['peek', 'chat', 'compose'].includes(/** @type {string} */ (value.mode)) || typeof value.reducedMotion !== 'boolean') return null;
    return { channel, value: { height: value.height, mode: /** @type {import('./desktop-contract.ts').PanelMode} */ (value.mode), reducedMotion: value.reducedMotion } };
  }
  if (channel === 'voice:open' || channel === 'orb:ready' || channel === 'orb:exit-complete') return value === undefined ? { channel } : null;
  return null;
}

/** @param {unknown} value @returns {import('./application-contract.ts').ApplicationEvent | null} */
function parseWorkerEvent(value) {
  if (!record(value)) return null;
  if (value.type === 'level') {
    if ((value.source !== 'listening' && value.source !== 'speaking') || typeof value.level !== 'number' || !Number.isFinite(value.level)) return null;
    return { type: 'level', source: value.source, level: Math.min(1, Math.max(0, value.level)) };
  }
  if (value.type === 'ui') return value.action === 'compose' ? { type: 'ui', action: 'compose' } : null;
  if (value.type !== 'voice' || typeof value.state !== 'string'
    || !['starting', 'idle', 'listening', 'transcribing', 'thinking', 'preparing-speech', 'speaking', 'error'].includes(value.state)
    || !['starting', 'ready', 'error', 'stopped'].includes(/** @type {string} */ (value.health))
    || (value.mode !== 'local' && value.mode !== 'realtime') || typeof value.ready !== 'boolean' || value.ready !== (value.health === 'ready')
    || typeof value.canRestorePrevious !== 'boolean' || !revision(value.revision)
    || !(value.operationId === null || revision(value.operationId)) || !conversation(value.conversation)
    || value.threadId !== value.conversation.id || (value.message !== undefined && typeof value.message !== 'string')
    || (value.generatingImage !== undefined && typeof value.generatingImage !== 'boolean')) return null;
  return {
    type: 'voice', state: /** @type {import('./application-contract.ts').ApplicationState} */ (value.state),
    ready: value.ready, health: /** @type {import('./application-contract.ts').ServiceHealth} */ (value.health),
    mode: value.mode, threadId: value.conversation.id, canRestorePrevious: value.canRestorePrevious,
    revision: value.revision, operationId: value.operationId, conversation: copyConversation(value.conversation),
    ...(value.message !== undefined && { message: value.message }),
    ...(value.generatingImage !== undefined && { generatingImage: value.generatingImage }),
  };
}
module.exports = { parseDesktopRequest, parseWorkerEvent };
