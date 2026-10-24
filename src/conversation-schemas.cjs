// CommonJS keeps the same schemas usable by Electron's main process and Node's TS worker.
const { z } = require('zod');

const revisionSchema = z.number().int().nonnegative();
const identifierSchema = z.string().min(1);
// Keep the legacy ID format: existing data does not require an RFC UUID.
const conversationIdSchema = z.string().regex(/^[a-f\d-]{36}$/i);
const exchangeIdSchema = z.string().regex(/^[a-z\d_-]{1,128}$/i);
const imageIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
const questionSourceSchema = z.enum(['voice', 'text']);
const generatedImageSchema = z.object({ id: imageIdSchema, alt: z.string() });
const imageTaskSchema = z.object({ threadId: conversationIdSchema, turnId: exchangeIdSchema });
const exchangeSchema = z.object({
  question: z.string(), answer: z.string(),
  questionSource: questionSourceSchema.optional(), interrupted: z.boolean().optional(),
  id: exchangeIdSchema.optional(), revision: revisionSchema.min(1).optional(),
  images: z.array(generatedImageSchema).optional(), imageTask: imageTaskSchema.optional(),
});

// IPC also accepts synthetic preview IDs and revision zero. Storage stays stricter.
const desktopExchangeSchema = exchangeSchema.extend({
  id: identifierSchema.optional(), revision: revisionSchema.optional(),
  imageTask: imageTaskSchema.extend({ threadId: identifierSchema, turnId: identifierSchema }).optional(),
});
const conversationViewSchema = z.object({
  id: identifierSchema.nullable(), revision: revisionSchema,
  completed: z.array(desktopExchangeSchema),
  pending: z.object({ id: identifierSchema, revision: revisionSchema,
    question: z.string(), answer: z.string(), questionSource: questionSourceSchema.optional() }).nullable(),
}).refine(value => {
  const ids = value.completed.flatMap(item => item.id === undefined ? [] : [item.id]);
  return new Set(ids).size === ids.length;
}, 'Duplicate conversation exchange ID');

const timeSchema = z.number().nonnegative().nullable();
const metadataFields = {
  threadId: conversationIdSchema.nullable(), lastAnswerAt: timeSchema,
  previousThreadId: conversationIdSchema.nullable().optional(), previousLastAnswerAt: timeSchema.optional(),
  localContextIds: z.array(conversationIdSchema).optional(),
};
const legacyMetadataSchema = z.object(metadataFields);
const sessionMetadataSchema = z.object({
  ...metadataFields, version: z.literal(2), revision: revisionSchema,
  receipts: z.record(conversationIdSchema, z.record(exchangeIdSchema, imageIdSchema)).optional(),
  providerThreads: z.record(conversationIdSchema, conversationIdSchema).optional(),
});
const historySchema = z.object({
  version: z.literal(2), id: z.string(), revision: revisionSchema,
  exchanges: z.array(exchangeSchema.extend({ id: exchangeIdSchema, revision: revisionSchema.min(1) })),
});
const legacyHistorySchema = z.array(exchangeSchema);

module.exports = { revisionSchema, identifierSchema, imageIdSchema, questionSourceSchema,
  generatedImageSchema, imageTaskSchema, exchangeSchema, conversationViewSchema,
  legacyMetadataSchema, sessionMetadataSchema, historySchema, legacyHistorySchema };
