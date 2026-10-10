declare const identity: unique symbol;
export type ConversationId = string & { readonly [identity]: 'conversation' };
export type CodexThreadId = string & { readonly [identity]: 'codex-thread' };
export type TurnId = string & { readonly [identity]: 'turn' };
export type ImageId = string & { readonly [identity]: 'image' };
const uuid = /^[a-f\d-]{36}$/i;
export function conversationId(value: string): ConversationId {
  if (!uuid.test(value)) throw new Error('Invalid conversation ID'); return value as ConversationId;
}
export function codexThreadId(value: string): CodexThreadId {
  if (!uuid.test(value)) throw new Error('Invalid Codex thread ID'); return value as CodexThreadId;
}
export function turnId(value: string): TurnId {
  if (!/^[a-z\d_-]{1,128}$/i.test(value)) throw new Error('Invalid Codex turn ID'); return value as TurnId;
}
export function imageId(value: string): ImageId {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid image ID'); return value as ImageId;
}
