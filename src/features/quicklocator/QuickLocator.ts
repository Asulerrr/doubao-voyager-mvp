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

  private get scrollContainer(): HTMLElement | null {
    return document.querySelector('[class*="v_list_scroller"], [class*="scroller"], [data-testid="flow_chat_page"], [class*="chat-container"], main, [class*="page-main"]') as HTMLElement;
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
    return container.scrollHeight > container.clientHeight && this.markers.length <= 8;
  }

  private async scanVirtualHistory(container: HTMLElement): Promise<void> {
    const originalScrollTop = container.scrollTop;
    const step = Math.max(320, Math.floor(container.clientHeight * 0.75));
    const maxSteps = 80;
    let position = 0;
    let steps = 0;

    this.isScanningVirtualHistory = true;
    try {
      while (steps < maxSteps) {
        const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        container.scrollTop = Math.min(position, maxScrollTop);
        await this.waitForVirtualRender();
        this.collectVisibleMessages(container);

        if (position >= maxScrollTop) break;
        position += step;
        steps++;
      }
    } finally {
      container.scrollTop = originalScrollTop;
      await this.waitForVirtualRender();
      this.collectVisibleMessages(container);
      this.scannedVirtualHistory = true;
      this.isScanningVirtualHistory = false;
    }
  }

  private waitForVirtualRender(): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, 120));
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
    bar.innerHTML = `
      <div class="dbx-locator-track"></div>
    `;
    
    document.body.appendChild(bar);
    this.locatorBar = bar;
    this.updateLocatorDots();
  }

  private updateLocatorDots(): void {
    if (!this.locatorBar) return;
    
    const track = this.locatorBar.querySelector('.dbx-locator-track');
    if (!track) return;

    track.innerHTML = '';

    this.markers.forEach((marker, index) => {
      const dot = document.createElement('button');
      dot.className = 'dbx-locator-dot' + (marker.starred ? ' starred' : '');
      dot.setAttribute('data-marker-index', String(index));
      dot.setAttribute('data-marker-text', marker.text);
      
      dot.addEventListener('mouseenter', (e) => {
        this.showTooltip(e.target as HTMLElement, marker);
      });
      
      dot.addEventListener('mouseleave', (e) => {
        const relatedTarget = e.relatedTarget as HTMLElement;
        if (!this.tooltipEl || !this.tooltipEl.contains(relatedTarget)) {
          this.hideTooltip();
        }
      });
      
      dot.addEventListener('click', () => {
        void this.scrollToMessage(marker);
      });

      track.appendChild(dot);
    });
  }

  private tooltipEl: HTMLElement | null = null;
  private hideTooltipTimeout: number | null = null;

  private showTooltip(dot: HTMLElement, marker: MessageMarker): void {
    if (this.hideTooltipTimeout) {
      clearTimeout(this.hideTooltipTimeout);
      this.hideTooltipTimeout = null;
    }
    
    if (!this.tooltipEl) {
      this.tooltipEl = document.createElement('div');
      this.tooltipEl.id = 'dbx-locator-tooltip-floating';
      this.tooltipEl.style.cssText = 'position: fixed; z-index: 99999; background: #fff; color: #333; padding: 10px 12px; border-radius: 10px; font-size: 13px; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15); width: 240px; height: 90px; display: none; flex-direction: column; gap: 8px; overflow: hidden;';
      document.body.appendChild(this.tooltipEl);
      
      this.tooltipEl.addEventListener('mouseenter', () => {
        if (this.hideTooltipTimeout) {
          clearTimeout(this.hideTooltipTimeout);
          this.hideTooltipTimeout = null;
        }
      });
      this.tooltipEl.addEventListener('mouseleave', () => {
        this.hideTooltip();
      });
    }
    
    const textEl = this.tooltipEl.querySelector('.tooltip-text');
    if (textEl) {
      textEl.textContent = marker.text;
    } else {
      const text = document.createElement('div');
      text.className = 'tooltip-text';
      text.textContent = marker.text;
      text.style.cssText = 'color: #333; line-height: 1.4; height: 54px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; word-wrap: break-word; word-break: break-all;';
      this.tooltipEl.appendChild(text);
    }
    
    let starBtn = this.tooltipEl.querySelector('.tooltip-star') as HTMLButtonElement;
    if (!starBtn) {
      starBtn = document.createElement('button');
      starBtn.className = 'tooltip-star';
      starBtn.style.cssText = 'display: flex; align-items: center; justify-content: flex-start; gap: 6px; padding: 6px 8px; margin: 0 -4px; border-radius: 6px; font-size: 12px; color: #666; cursor: pointer; background: transparent; border: none; width: fit-content;';
      this.tooltipEl.appendChild(starBtn);
    }
    starBtn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="${marker.starred ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
      </svg>
      ${marker.starred ? '已收藏' : '收藏'}
    `;
    starBtn.onclick = async (e) => {
      e.stopPropagation();
      const isNowStarred = !marker.starred;
      
      starBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="${isNowStarred ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
        </svg>
        ${isNowStarred ? '已收藏' : '收藏'}
      `;
      starBtn.style.color = isNowStarred ? '#f59e0b' : '#666';
      
      const dot = this.locatorBar?.querySelector(`[data-marker-index="${marker.index}"]`) as HTMLElement;
      if (dot) {
        dot.classList.toggle('starred', isNowStarred);
      }
      
      if (this.starredMarkers.has(marker.index)) {
        this.starredMarkers.delete(marker.index);
      } else {
        this.starredMarkers.add(marker.index);
      }
      this.markers[marker.index].starred = isNowStarred;
      
      if (this.conversationId) {
        try {
          if (isNowStarred) {
            await storageService.addStarredMessage(this.conversationId, marker.index);
          } else {
            await storageService.removeStarredMessage(this.conversationId, marker.index);
          }
        } catch (error) {
        }
      }
    };
    
    const rect = dot.getBoundingClientRect();
    this.tooltipEl.style.display = 'flex';
    this.tooltipEl.style.left = (rect.left - 240) + 'px';
    this.tooltipEl.style.top = (rect.top + rect.height / 2 - 35) + 'px';
  }

  private hideTooltip(): void {
    if (this.hideTooltipTimeout) return;
    
    this.hideTooltipTimeout = window.setTimeout(() => {
      if (this.tooltipEl) {
        this.tooltipEl.style.display = 'none';
      }
      this.hideTooltipTimeout = null;
    }, 150);
  }

  private async scrollToMessage(marker: MessageMarker): Promise<void> {
    const container = this.scrollContainer;
    if (!container) return;

    container.scrollTo({ top: marker.scrollTop, behavior: 'auto' });
    await this.waitForVirtualRender();

    const messageElement = Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]'))
      .find((element) => element.getAttribute('data-message-id') === marker.messageId);
    if (!messageElement) return;

    marker.element = messageElement;
    messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    
    messageElement.classList.add('dbx-message-highlight');
    setTimeout(() => {
      messageElement.classList.remove('dbx-message-highlight');
    }, 2000);
    
    this.scrollLocatorToMarker(marker.index);
  }
  
  private scrollLocatorToMarker(index: number): void {
    const track = this.locatorBar?.querySelector('.dbx-locator-track');
    if (!track) return;
    
    const dots = track.querySelectorAll('.dbx-locator-dot');
    const targetDot = dots[index] as HTMLElement;
    if (!targetDot) return;
    
    const trackRect = track.getBoundingClientRect();
    const dotRect = targetDot.getBoundingClientRect();
    
    const trackHeight = trackRect.height;
    const dotTop = dotRect.top - trackRect.top;
    const dotCenter = dotTop + dotRect.height / 2;
    const scrollTarget = track.scrollTop + dotCenter - trackHeight / 2;
    
    track.scrollTo({
      top: scrollTarget,
      behavior: 'smooth'
    });
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
    if (this.locatorBar) {
      this.locatorBar.remove();
      this.locatorBar = null;
    }
    this.markers = [];
    this.initialized = false;
  }
}

export const quickLocator = new QuickLocator();
