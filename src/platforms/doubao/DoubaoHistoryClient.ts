export interface HistoryMessage {
  id: string;
  text: string;
  index: number;
  signature: string;
  explicitRole: 'user' | 'assistant' | 'unknown';
}

interface HistoryPage {
  messages: HistoryMessage[];
  nextAnchor: number | null;
  hasMore: boolean;
}

interface BridgeResponse {
  requestId: string;
  ok: boolean;
  error?: string;
  payload?: unknown;
}

const REQUEST_EVENT = 'dbx-history-request';
const RESPONSE_EVENT = 'dbx-history-response';
const PAGE_LIMIT = 160;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numericValue(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function findValue(record: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (name in record) return record[name];
  }
  return undefined;
}

function textFromValue(value: unknown, depth = 0): string {
  if (depth > 4 || value === null || value === undefined) return '';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '';
    try {
      return textFromValue(JSON.parse(trimmed), depth + 1) || trimmed;
    } catch {
      return trimmed;
    }
  }
  if (Array.isArray(value)) {
    return value.map((item) => textFromValue(item, depth + 1)).filter(Boolean).join(' ');
  }
  const record = asRecord(value);
  if (!record) return '';

  const preferred = ['text', 'content', 'content_text', 'message_content', 'display_text', 'question'];
  for (const key of preferred) {
    if (key in record) {
      const text = textFromValue(record[key], depth + 1);
      if (text) return text;
    }
  }
  return '';
}

function roleFromRecord(record: Record<string, unknown>): 'user' | 'assistant' | 'unknown' {
  const values = ['role', 'sender_type', 'sender_role', 'from_role', 'author_role']
    .map((key) => stringValue(record[key])?.toLowerCase() ?? '');
  if (values.some((value) => /user|human|customer|client/.test(value))) return 'user';
  if (values.some((value) => /assistant|bot|ai|model/.test(value))) return 'assistant';
  return 'unknown';
}

function signatureFromRecord(record: Record<string, unknown>): string {
  const fields = ['role', 'sender_type', 'sender_role', 'from_role', 'author_role', 'message_type', 'type'];
  return fields
    .filter((field) => record[field] !== undefined)
    .map((field) => `${field}:${String(record[field])}`)
    .join('|');
}

function collectMessageRecords(value: unknown, collected: Record<string, unknown>[] = [], seen = new Set<unknown>()): Record<string, unknown>[] {
  if (typeof value !== 'object' || value === null || seen.has(value)) return collected;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item) => collectMessageRecords(item, collected, seen));
    return collected;
  }

  const record = value as Record<string, unknown>;
  const id = stringValue(findValue(record, ['message_id', 'messageId']));
  const content = findValue(record, ['content', 'message_content', 'content_text', 'text']);
  if (id && content !== undefined) collected.push(record);
  Object.values(record).forEach((item) => collectMessageRecords(item, collected, seen));
  return collected;
}

function findPagination(value: unknown, state = { nextAnchor: null as number | null, hasMore: false }, seen = new Set<unknown>()): typeof state {
  if (typeof value !== 'object' || value === null || seen.has(value)) return state;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => findPagination(item, state, seen));
    return state;
  }

  const record = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    const normalized = key.toLowerCase();
    if (state.nextAnchor === null && /(next.*anchor|anchor.*next|next.*index|cursor)/.test(normalized)) {
      state.nextAnchor = numericValue(item);
    }
    if (/(has.*more|more.*history)/.test(normalized) && item === true) state.hasMore = true;
    findPagination(item, state, seen);
  }
  return state;
}

function parsePage(payload: unknown): HistoryPage {
  const records = collectMessageRecords(payload);
  const messages = new Map<string, HistoryMessage>();
  records.forEach((record) => {
    const id = stringValue(findValue(record, ['message_id', 'messageId']));
    if (!id) return;
    const text = textFromValue(findValue(record, ['content', 'message_content', 'content_text', 'text']));
    if (!text) return;
    const index = numericValue(findValue(record, ['index', 'message_index', 'sequence', 'seq'])) ?? 0;
    messages.set(id, {
      id,
      text,
      index,
      signature: signatureFromRecord(record),
      explicitRole: roleFromRecord(record),
    });
  });

  const pagination = findPagination(payload);
  const messageIndexes = Array.from(messages.values())
    .map((message) => message.index)
    .filter((index) => index > 0);
  return {
    messages: Array.from(messages.values()),
    nextAnchor: pagination.nextAnchor ?? (messageIndexes.length ? Math.min(...messageIndexes) - 1 : null),
    hasMore: pagination.hasMore,
  };
}

export class DoubaoHistoryClient {
  private pending = new Map<string, (response: BridgeResponse) => void>();

  constructor() {
    window.addEventListener(RESPONSE_EVENT, (event: Event) => {
      try {
        const response = JSON.parse((event as CustomEvent<string>).detail) as BridgeResponse;
        const resolve = this.pending.get(response.requestId);
        if (!resolve) return;
        this.pending.delete(response.requestId);
        resolve(response);
      } catch {
        // Ignore malformed page-world messages.
      }
    });
  }

  async loadConversation(conversationId: string): Promise<HistoryMessage[]> {
    const allMessages = new Map<string, HistoryMessage>();
    let anchorIndex: number | undefined;
    for (let pageNumber = 0; pageNumber < PAGE_LIMIT; pageNumber++) {
      const response = await this.requestPage(conversationId, anchorIndex);
      if (!response.ok || !response.payload) break;

      const page = parsePage(response.payload);
      page.messages.forEach((message) => allMessages.set(message.id, message));
      const mayHaveAnotherPage = page.hasMore || page.messages.length >= 20;
      if (page.messages.length === 0 || !mayHaveAnotherPage || page.nextAnchor === null || page.nextAnchor === anchorIndex) break;
      anchorIndex = page.nextAnchor;
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    return Array.from(allMessages.values()).sort((a, b) => a.index - b.index);
  }

  private requestPage(conversationId: string, anchorIndex?: number): Promise<BridgeResponse> {
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ requestId, ok: false, error: 'history_request_timeout' });
      }, 10_000);
      this.pending.set(requestId, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      window.dispatchEvent(new CustomEvent(REQUEST_EVENT, {
        detail: JSON.stringify({ requestId, conversationId, anchorIndex }),
      }));
    });
  }
}

export const doubaoHistoryClient = new DoubaoHistoryClient();
