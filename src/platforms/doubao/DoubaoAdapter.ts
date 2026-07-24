import type { ChatPlatformAdapter, ConversationContext } from '../types';

const CHAT_PATH_PATTERN = /^\/chat\/([^/?#]+)/;
const SIDEBAR_SELECTOR = '#flow_chat_sidebar';

class DoubaoAdapter implements ChatPlatformAdapter {
  readonly id = 'doubao';

  isSupportedPage(): boolean {
    return /(^|\.)doubao\.com$/i.test(window.location.hostname);
  }

  getConversationContext(): ConversationContext {
    const match = window.location.pathname.match(CHAT_PATH_PATTERN);
    return { id: match?.[1] ?? null, url: window.location.href };
  }

  async waitForWorkspace(): Promise<void> {
    if (!this.isSupportedPage() || document.querySelector(SIDEBAR_SELECTOR)) return;

    await new Promise<void>((resolve) => {
      const observer = new MutationObserver(() => {
        if (document.querySelector(SIDEBAR_SELECTOR)) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      window.setTimeout(() => {
        observer.disconnect();
        resolve();
      }, 10_000);
    });
  }
}

export const doubaoAdapter = new DoubaoAdapter();
