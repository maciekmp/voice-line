import type { ApplicationState, ConversationView, ServiceHealth, ApplicationCapabilities } from './application-contract.ts';
import type { ConversationExchange, GeneratedImage } from './conversation-contract.ts';

export type DesktopCommand = 'record' | 'release' | 'cancel' | 'reset' | 'previous' | 'pin' | 'hide' | 'retry';
export type PanelMode = 'peek' | 'chat' | 'compose' | 'compact';
export type SaveResult = 'saved' | 'cancelled' | 'error';
export type PanelMeasurement = { height: number; mode: PanelMode; reducedMotion: boolean };
export type AudioIndicator = 'bars' | 'orb' | 'glow' | 'waves';
export type DesktopSettings = { indicator: AudioIndicator; paused: boolean };
export type DesktopVoice = {
  state: ApplicationState; ready: boolean; health?: ServiceHealth; mode?: 'local' | 'realtime';
  capabilities?: ApplicationCapabilities;
  threadId?: string | null; canRestorePrevious?: boolean; revision?: number; operationId?: number | null;
  generatingImage?: boolean; question: string; answer: string; message: string;
  inputMessage?: string;
  interrupted?: boolean; questionSource?: import('./conversation-contract.ts').QuestionSource;
  images: GeneratedImage[]; history: ConversationExchange[]; conversation: ConversationView;
};
export type DesktopEvent =
  | { channel: 'voice:snapshot'; value: DesktopVoice }
  | { channel: 'voice:mode'; value: PanelMode }
  | { channel: 'voice:pinned' | 'voice:resizing' | 'voice:visible'; value: boolean }
  | { channel: 'voice:level'; value: number }
  | { channel: 'voice:visual-settings'; value: DesktopSettings };
export type DesktopRequest =
  | { channel: 'voice:command'; value: DesktopCommand }
  | { channel: 'voice:text' | 'voice:copy-code'; value: string }
  | { channel: 'voice:image-preview' | 'voice:image-save'; value: string }
  | { channel: 'voice:resize'; value: PanelMeasurement }
  | { channel: 'voice:hover' | 'voice:composer-focus'; value: boolean }
  | { channel: 'voice:open' | 'voice:ready' };
export interface DesktopApi {
  ready(): void;
  open(): void;
  hover(entered: boolean): void;
  composerFocus(focused: boolean): void;
  text(text: string): Promise<boolean>;
  copyCode(text: string): Promise<boolean>;
  imagePreview(id: string): Promise<string | null>;
  saveImage(id: string): Promise<SaveResult>;
  resize(size: PanelMeasurement): void;
  command(command: DesktopCommand): Promise<boolean>;
  onLevel(callback: (level: number) => void): () => void;
  onVoice(callback: (snapshot: DesktopVoice) => void): () => void;
  onMode(callback: (mode: PanelMode) => void): () => void;
  onClearDraft(callback: () => void): () => void;
  onPinned(callback: (pinned: boolean) => void): () => void;
  onResizing(callback: (resizing: boolean) => void): () => void;
  onVisible(callback: (visible: boolean) => void): () => void;
  onSettings(callback: (settings: DesktopSettings) => void): () => void;
}
declare global { interface Window { voiceDesktop: DesktopApi } }
