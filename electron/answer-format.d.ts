export type AnswerPart = { type: 'text' | 'code'; text: string; language?: string };
export function splitAnswer(text: string): AnswerPart[];
export function splitInline(text: string): AnswerPart[];
export function speechText(answer: string): string;
