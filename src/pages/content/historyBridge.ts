const REQUEST_EVENT = 'dbx-history-request';
const RESPONSE_EVENT = 'dbx-history-response';
const INITIAL_ANCHOR = Number.MAX_SAFE_INTEGER;

interface HistoryRequest {
  requestId: string;
  conversationId: string;
  anchorIndex?: number;
}

function sendResponse(requestId: string, response: Record<string, unknown>): void {
  window.dispatchEvent(new CustomEvent(RESPONSE_EVENT, {
    detail: JSON.stringify({ requestId, ...response }),
  }));
}

function findHistoryEndpoint(): string | null {
  const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  return entries
    .map((entry) => entry.name)
    .filter((url) => url.includes('/im/chain/single'))
    .at(-1) ?? null;
}

window.addEventListener(REQUEST_EVENT, (event: Event) => {
  const detail = (event as CustomEvent<string>).detail;
  let request: HistoryRequest;
  try {
    request = JSON.parse(detail) as HistoryRequest;
  } catch {
    return;
  }

  const endpoint = findHistoryEndpoint();
  if (!endpoint) {
    sendResponse(request.requestId, { ok: false, error: 'history_endpoint_unavailable' });
    return;
  }

  const body = {
    cmd: 3100,
    uplink_body: {
      pull_singe_chain_uplink_body: {
        conversation_id: request.conversationId,
        anchor_index: request.anchorIndex ?? INITIAL_ANCHOR,
        conversation_type: 3,
        direction: 1,
        limit: 20,
        ext: {},
        filter: { index_list: [] },
        evaluate_ab_params: '',
        evaluate_common_params: '',
      },
    },
    sequence_id: crypto.randomUUID(),
    channel: 2,
    version: '1',
  };

  void fetch(endpoint, {
    method: 'POST',
    credentials: 'include',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json; encoding=utf-8',
      'agw-js-conv': 'str',
    },
    body: JSON.stringify(body),
  })
    .then(async (response) => {
      const payload = await response.json() as unknown;
      sendResponse(request.requestId, { ok: response.ok, payload });
    })
    .catch(() => {
      sendResponse(request.requestId, { ok: false, error: 'history_request_failed' });
    });
});
