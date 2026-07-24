export interface ConversationContext {
  readonly id: string | null;
  readonly url: string;
}

export interface ChatPlatformAdapter {
  readonly id: string;
  isSupportedPage(): boolean;
  getConversationContext(): ConversationContext;
  waitForWorkspace(): Promise<void>;
}
