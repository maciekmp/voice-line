import type { ApplicationState, ConversationView, ServiceHealth } from './application-contract.ts';
import type { ConversationExchange, GeneratedImage } from './conversation-contract.ts';

export type DesktopCommand = 'record' | 'release' | 'cancel' | 'reset' | 'previous' | 'pin' | 'hide' | 'retry';
export type PanelMode = 'peek' | 'chat' | 'compose';
export type Presence = 'visible' | 'hidden' | 'leaving';
export type SaveResult = 'saved' | 'cancelled' | 'error';
export type PanelMeasurement = { height: number; mode: PanelMode; reducedMotion: boolean };
export type DesktopSettings = { state: 'idle' | 'listening' | 'speaking'; paused: boolean };
export type DesktopVoice = {
  state: ApplicationState; ready: boolean; health?: ServiceHealth; mode?: 'local' | 'realtime';
  threadId?: string | null; canRestorePrevious?: boolean; revision?: number; operationId?: number | null;
  generatingImage?: boolean; question: string; answer: string; message: string;
  images: GeneratedImage[]; history: ConversationExchange[]; conversation: ConversationView;
};
export type DesktopEvent =
  | { channel: 'voice:snapshot'; value: DesktopVoice }
  | { channel: 'voice:mode'; value: PanelMode }
  | { channel: 'voice:pinned' | 'voice:resizing'; value: boolean }
  | { channel: 'orb:level'; value: number }
  | { channel: 'orb:presence'; value: Presence }
  | { channel: 'orb:settings'; value: DesktopSettings };
export type DesktopRequest =
  | { channel: 'voice:command'; value: DesktopCommand }
  | { channel: 'voice:text' | 'voice:copy-code'; value: string }
  | { channel: 'voice:image-preview' | 'voice:image-save'; value: string }
  | { channel: 'voice:resize'; value: PanelMeasurement }
  | { channel: 'voice:hover'; value: boolean }
  | { channel: 'voice:open' | 'orb:ready' | 'orb:exit-complete' };
export interface DesktopApi {
  ready(): void;
  open(): void;
  hover(entered: boolean): void;
  text(text: string): Promise<boolean>;
  copyCode(text: string): Promise<boolean>;
  imagePreview(id: string): Promise<string | null>;
  saveImage(id: string): Promise<SaveResult>;
  resize(size: PanelMeasurement): void;
  command(command: DesktopCommand): void;
  exitComplete(): void;
  onLevel(callback: (level: number) => void): () => void;
  onVoice(callback: (snapshot: DesktopVoice) => void): () => void;
  onMode(callback: (mode: PanelMode) => void): () => void;
  onPinned(callback: (pinned: boolean) => void): () => void;
  onResizing(callback: (resizing: boolean) => void): () => void;
  onPresence(callback: (presence: Presence) => void): () => void;
  onSettings(callback: (settings: DesktopSettings) => void): () => void;
}
declare global { interface Window { orbDesktop: DesktopApi } }
