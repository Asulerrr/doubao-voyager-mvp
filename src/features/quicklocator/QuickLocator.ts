import { storageService } from '../../core/services/StorageService';

export interface MessageMarker {
  id: string;
  messageId: string;
  element: HTMLElement;
  text: string;
  index: number;
  starred: boolean;
  scrollTop: number;
}

export class QuickLocator {
  private markers: MessageMarker[] = [];
  private locatorBar: HTMLElement | null = null;
  private initialized = false;
  private observer: MutationObserver | null = null;
  private starredMarkers: Set<number> = new Set();
  private conversationId: string = 'unknown';
  private scannedVirtualHistory = false;
  private isScanningVirtualHistory = false;
  private observedScrollContainer: HTMLElement | null = null;
  private handleContainerScroll = (): void => this.updateActiveMarker();

  private get scrollContainer(): HTMLElement | null {
    const message = document.querySelector<HTMLElement>('[data-message-id]');
    if (message) {
      let ancestor = message.parentElement;
      while (ancestor && ancestor !== document.body) {
        const style = window.getComputedStyle(ancestor);
        if (ancestor.scrollHeight > ancestor.clientHeight && /(auto|scroll)/.test(style.overflowY)) {
          return ancestor;
        }
        ancestor = ancestor.parentElement;
      }
    }

    return document.querySelector<HTMLElement>('[class*="v_list_scroller"], [data-testid="flow_chat_page"], [class*="chat-container"], [class*="page-main"], main');
  }

  init(): void {
    if (this.initialized) return;
    
    this.conversationId = this.getConversationId();
    this.loadStarredMessages();
    this.waitForChatContainer();
    this.setupUrlChangeListener();
    this.initialized = true;
  }

  private setupUrlChangeListener(): void {
    let lastUrl = window.location.href;
    new MutationObserver(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        this.onConversationChange();
      }
    }).observe(document.body, { childList: true, subtree: true });
    
    setInterval(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        this.onConversationChange();
      }
    }, 1000);
  }

  private async onConversationChange(): Promise<void> {
    const newConversationId = this.getConversationId();
    if (newConversationId !== this.conversationId) {
      this.conversationId = newConversationId;
      
      this.markers = [];
      this.scannedVirtualHistory = false;
      if (this.locatorBar) {
        this.locatorBar.remove();
        this.locatorBar = null;
      }
      
      await this.loadStarredMessages();
      await this.waitForChatContainer();
    }
  }

  private getConversationId(): string {
    const urlMatch = window.location.pathname.match(/\/chat\/([^/?#]+)/);
    if (urlMatch) {
      return urlMatch[1];
    }
    return 'unknown';
  }

  private async waitForChatContainer(): Promise<void> {
    let retries = 0;
    const maxRetries = 30;
    
    const checkContainer = async () => {
      const container = this.scrollContainer;
      if (container || retries >= maxRetries) {
        if (container) {
          await this.loadStarredMessages();
          await this.scanMessages();
          this.createLocatorBar();
          this.setupObserver();
          this.setupScrollListener();
        }
        return;
      }
      retries++;
      setTimeout(checkContainer, 500);
    };
    
    checkContainer();
  }

  private async loadStarredMessages(): Promise<void> {
    if (!this.conversationId || this.conversationId === 'unknown') {
      return;
    }
    
    try {
      this.starredMarkers = new Set();
      const starred = await storageService.getStarredMessages(this.conversationId);
      this.starredMarkers = new Set(starred);
    } catch (error) {
    }
  }

  private async scanMessages(): Promise<void> {
    const container = this.scrollContainer;
    if (!container) {
      return;
    }

    this.conversationId = this.getConversationId();
    await this.loadStarredMessages();

    this.collectVisibleMessages(container);

    if (!this.scannedVirtualHistory && this.shouldScanVirtualHistory(container)) {
      await this.scanVirtualHistory(container);
    }

    this.updateLocatorDots();
  }

  private collectVisibleMessages(container: HTMLElement): void {
    const markersById = new Map(this.markers.map((marker) => [marker.messageId, marker]));
    const containerRect = container.getBoundingClientRect();

    const messageElements = container.querySelectorAll<HTMLElement>('[data-message-id]');
    messageElements.forEach((el) => {
      if (el.parentElement?.closest('[data-message-id]')) return;

      if (!this.isUserMessage(el)) return;

      const messageId = el.getAttribute('data-message-id');
      if (!messageId) return;

      const messageTop = Math.max(0, container.scrollTop + el.getBoundingClientRect().top - containerRect.top);
      const existing = markersById.get(messageId);
      markersById.set(messageId, {
        id: `marker_${messageId}`,
        messageId,
        element: el,
        text: this.extractMessageText(el) || existing?.text || '问题',
        index: existing?.index ?? 0,
        starred: existing?.starred ?? false,
        scrollTop: messageTop,
      });
    });

    this.markers = Array.from(markersById.values())
      .sort((a, b) => a.scrollTop - b.scrollTop)
      .map((marker, index) => ({
        ...marker,
        index,
        text: marker.text === '问题' ? `问题 ${index + 1}` : marker.text,
        starred: marker.starred || this.starredMarkers.has(index),
      }));
  }

  private isUserMessage(element: HTMLElement): boolean {
    const userBubbleSelector = '.bg-g-send-msg-bubble-bg, [class*="send-msg"], [class*="send_message"], [class*="user-bubble"]';
    const hasUserBubble = element.matches(userBubbleSelector) || Boolean(element.querySelector(userBubbleSelector));
    if (hasUserBubble) return true;

    const hasUserImageBlock = Boolean(element.querySelector('[data-plugin-identifier*="block_type:10052"]'));
    const hasJustifyEnd = element.matches('[class*="justify-end"]') || Boolean(element.querySelector('[class*="justify-end"]'));
    return hasUserImageBlock && hasJustifyEnd;
  }

  private shouldScanVirtualHistory(container: HTMLElement): boolean {
    return container.scrollHeight > container.clientHeight;
  }

  private async scanVirtualHistory(container: HTMLElement): Promise<void> {
    const originalScrollTop = container.scrollTop;
    const originalOffsetFromBottom = Math.max(0, container.scrollHeight - container.clientHeight - originalScrollTop);
    const step = Math.max(240, Math.floor(container.clientHeight * 0.65));
    const maxSteps = 160;
    let idleAtTop = 0;

    this.isScanningVirtualHistory = true;
    try {
      for (let stepIndex = 0; stepIndex < maxSteps; stepIndex++) {
        const heightBeforeScroll = container.scrollHeight;
        container.scrollBy({ top: -step, behavior: 'auto' });
        container.dispatchEvent(new Event('scroll'));
        this.collectVisibleMessages(container);
        await this.waitForVirtualRender(240);
        this.collectVisibleMessages(container);

        if (container.scrollTop > 1) continue;

        await this.waitForVirtualRender(480);
        this.collectVisibleMessages(container);
        const historyLoaded = container.scrollHeight > heightBeforeScroll + 8;
        idleAtTop = historyLoaded ? 0 : idleAtTop + 1;
        if (idleAtTop >= 3) break;
      }
    } finally {
      const restoredScrollTop = Math.max(0, container.scrollHeight - container.clientHeight - originalOffsetFromBottom);
      container.scrollTop = restoredScrollTop;
      container.dispatchEvent(new Event('scroll'));
      await this.waitForVirtualRender(240);
      this.collectVisibleMessages(container);
      this.scannedVirtualHistory = true;
      this.isScanningVirtualHistory = false;
    }
  }

  private waitForVirtualRender(delay = 120): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, delay));
  }

  private extractMessageText(element: HTMLElement): string {
    const clone = element.cloneNode(true) as HTMLElement;
    
    const removeSelectors = [
      'svg', 'button', '[class*="avatar"]', '[class*="time"]', 
      '[class*="timestamp"]', '[class*="meta"]', '[class*="action"]',
      '[class*="toolbar"]', '[data-testid*="action"]'
    ];
    removeSelectors.forEach(sel => {
      clone.querySelectorAll(sel).forEach(el => el.remove());
    });

    let text = clone.textContent?.trim() || '';
    text = text.replace(/\s+/g, ' ').trim();
    
    if (!text) {
      const hasImage = clone.querySelector('img') || 
                       clone.querySelector('[class*="image"]') ||
                       clone.querySelector('[data-testid*="image"]') ||
                       clone.innerHTML.includes('imagex-type');
      if (hasImage) {
        return '[图片]';
      }
    }
    
    if (text.length > 40) {
      return text.substring(0, 40) + '...';
    }
    return text;
  }

  private createLocatorBar(): void {
    if (this.locatorBar) return;

    const bar = document.createElement('div');
    bar.id = 'dbx-quick-locator';
    bar.classList.toggle('dbx-locator-dark', this.isDarkMode());
    bar.innerHTML = `
      <div class="dbx-locator-panel"><div class="dbx-locator-message-list"></div></div>
      <div class="dbx-locator-strip"></div>
    `;
    
    document.body.appendChild(bar);
    this.locatorBar = bar;
    this.updateLocatorDots();
  }

  private updateLocatorDots(): void {
    if (!this.locatorBar) return;

    this.locatorBar.classList.toggle('dbx-locator-dark', this.isDarkMode());
    
    const strip = this.locatorBar.querySelector<HTMLElement>('.dbx-locator-strip');
    const messageList = this.locatorBar.querySelector<HTMLElement>('.dbx-locator-message-list');
    if (!strip || !messageList) return;

    const maxHeight = Math.floor(window.innerHeight * 0.55);
    const locatorHeight = Math.min(maxHeight, Math.max(150, this.markers.length * 4));
    this.locatorBar.style.height = `${locatorHeight}px`;
    strip.classList.toggle('single', this.markers.length === 1);
    strip.innerHTML = '';
    messageList.innerHTML = '';

    this.markers.forEach((marker, index) => {
      const jumpToMarker = () => {
        void this.scrollToMessage(marker);
      };

      const stripItem = document.createElement('button');
      stripItem.className = 'dbx-locator-bar' + (marker.starred ? ' starred' : '');
      stripItem.setAttribute('data-marker-index', String(index));
      stripItem.setAttribute('aria-label', `跳转到问题 ${index + 1}: ${marker.text}`);
      stripItem.addEventListener('click', jumpToMarker);
      strip.appendChild(stripItem);

      const messageItem = document.createElement('button');
      messageItem.className = 'dbx-locator-message' + (marker.starred ? ' starred' : '');
      messageItem.setAttribute('data-marker-index', String(index));
      messageItem.textContent = marker.text;
      messageItem.title = marker.text;
      messageItem.addEventListener('click', jumpToMarker);
      messageList.appendChild(messageItem);
    });

    this.updateActiveMarker();
  }

  private isDarkMode(): boolean {
    return document.documentElement.dataset.theme === 'dark' ||
      document.body.classList.contains('dark') ||
      window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  private setupScrollListener(): void {
    const container = this.scrollContainer;
    if (!container || this.observedScrollContainer === container) return;

    this.observedScrollContainer?.removeEventListener('scroll', this.handleContainerScroll);
    this.observedScrollContainer = container;
    container.addEventListener('scroll', this.handleContainerScroll, { passive: true });
  }

  private updateActiveMarker(): void {
    if (!this.locatorBar || this.markers.length === 0) return;

    const container = this.scrollContainer;
    if (!container) return;

    const viewportCenter = container.scrollTop + container.clientHeight / 2;
    let activeIndex = 0;
    let smallestDistance = Number.POSITIVE_INFINITY;
    this.markers.forEach((marker, index) => {
      const distance = Math.abs(marker.scrollTop - viewportCenter);
      if (distance < smallestDistance) {
        smallestDistance = distance;
        activeIndex = index;
      }
    });

    this.locatorBar.querySelectorAll<HTMLElement>('[data-marker-index]').forEach((element) => {
      element.classList.toggle('active', Number(element.dataset.markerIndex) === activeIndex);
    });
  }

  private async scrollToMessage(marker: MessageMarker): Promise<void> {
    const container = this.scrollContainer;
    if (!container) return;

    let messageElement: HTMLElement | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      container.scrollTo({ top: marker.scrollTop, behavior: 'auto' });
      container.dispatchEvent(new Event('scroll'));
      await this.waitForVirtualRender(200);
      messageElement = Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]'))
        .find((element) => element.getAttribute('data-message-id') === marker.messageId);
      if (messageElement) break;
    }

    messageElement ??= marker.element.isConnected && marker.element.getAttribute('data-message-id') === marker.messageId
      ? marker.element
      : undefined;
    if (!messageElement) return;

    marker.element = messageElement;
    messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    
    messageElement.classList.add('dbx-message-highlight');
    setTimeout(() => {
      messageElement.classList.remove('dbx-message-highlight');
    }, 2000);
    
  }

  private setupObserver(): void {
    const container = this.scrollContainer;
    if (!container) return;

    this.observer?.disconnect();

    this.observer = new MutationObserver((mutations) => {
      let shouldRescan = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          shouldRescan = true;
          break;
        }
      }
      
      if (shouldRescan && !this.isScanningVirtualHistory) {
        this.debounceScan();
      }
    });

    this.observer.observe(container, { childList: true, subtree: true });
  }

  private debounceScan = this.debounce(async () => {
    await this.scanMessages();
    this.updateLocatorDots();
  }, 1000);

  private debounce(fn: () => void | Promise<void>, delay: number): () => void {
    let timer: number | null = null;
    return () => {
      if (timer) clearTimeout(timer);
      timer = window.setTimeout(fn, delay);
    };
  }

  destroy(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.observedScrollContainer?.removeEventListener('scroll', this.handleContainerScroll);
    this.observedScrollContainer = null;
    if (this.locatorBar) {
      this.locatorBar.remove();
      this.locatorBar = null;
    }
    this.markers = [];
    this.initialized = false;
  }
}

export const quickLocator = new QuickLocator();
