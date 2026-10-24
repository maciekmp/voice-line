const { z } = require('zod');
const { imageIdSchema, conversationViewSchema, revisionSchema, identifierSchema } = require('./conversation-schemas.cjs');
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function imageId(value) { return imageIdSchema.safeParse(value).success; }
const workerEventSchema = z.union([
  z.object({ type: z.literal('notice'), message: z.string(), source: z.literal('shortcut').optional() }),
  z.object({ type: z.literal('level'), source: z.enum(['listening', 'speaking']),
    level: z.number().transform(value => Math.min(1, Math.max(0, value))) }),
  z.object({ type: z.literal('ui'), action: z.enum(['compose', 'correct', 'continue', 'voice-input', 'text-input']) }),
  z.object({ type: z.literal('voice'),
    state: z.enum(['starting', 'idle', 'listening', 'transcribing', 'thinking', 'preparing-speech', 'speaking', 'error']),
    health: z.enum(['starting', 'ready', 'error', 'stopped']), mode: z.enum(['local', 'realtime']),
    ready: z.boolean(), canRestorePrevious: z.boolean(), revision: revisionSchema,
    operationId: revisionSchema.nullable(), threadId: identifierSchema.nullable(),
    conversation: conversationViewSchema, message: z.string().optional(), generatingImage: z.boolean().optional(),
    capabilities: z.object({
      text: z.object({ state: z.enum(['starting', 'ready', 'error', 'stopped']), message: z.string().optional() }),
      recording: z.object({ state: z.enum(['starting', 'ready', 'error', 'stopped', 'disabled']), message: z.string().optional() }),
      playback: z.object({ state: z.enum(['starting', 'ready', 'error', 'stopped', 'disabled']), message: z.string().optional() }),
    }),
  }).refine(value => value.ready === (value.health === 'ready') && value.threadId === value.conversation.id && value.capabilities.text.state === value.health),
]);
/** @param {import('./application-contract.ts').ConversationView} value */
function copyConversation(value) {
  return { id: value.id, revision: value.revision,
    completed: value.completed.map(item => ({ question: item.question, answer: item.answer,
      ...(item.questionSource !== undefined && { questionSource: item.questionSource }),
      ...(item.interrupted !== undefined && { interrupted: item.interrupted }),
      ...(item.id !== undefined && { id: item.id }), ...(item.revision !== undefined && { revision: item.revision }),
      ...(item.images !== undefined && { images: item.images.map(image => ({ id: image.id, alt: image.alt })) }),
      ...(item.imageTask !== undefined && { imageTask: { threadId: item.imageTask.threadId, turnId: item.imageTask.turnId } }),
    })),
    pending: value.pending && { id: value.pending.id, revision: value.pending.revision,
      question: value.pending.question, answer: value.pending.answer,
      ...(value.pending.questionSource !== undefined && { questionSource: value.pending.questionSource }) },
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
      || !['peek', 'chat', 'compose', 'compact'].includes(/** @type {string} */ (value.mode)) || typeof value.reducedMotion !== 'boolean') return null;
    return { channel, value: { height: value.height, mode: /** @type {import('./desktop-contract.ts').PanelMode} */ (value.mode), reducedMotion: value.reducedMotion } };
  }
  if (channel === 'voice:open' || channel === 'voice:ready') return value === undefined ? { channel } : null;
  return null;
}

/** @param {unknown} value @returns {import('./application-contract.ts').ApplicationEvent | null} */
function parseWorkerEvent(value) {
  const parsed = workerEventSchema.safeParse(value);
  if (!parsed.success) return null;
  if (parsed.data.type !== 'voice') return parsed.data;
  return { ...parsed.data, conversation: copyConversation(parsed.data.conversation) };
}
module.exports = { parseDesktopRequest, parseWorkerEvent };
