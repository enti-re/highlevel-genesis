/**
 * `window.hl` for the sandboxed preview: forwards calls to the parent over postMessage,
 * so no token ever enters the iframe. Keep in sync with functions/src/generation/spec.ts.
 */
/** A HighLevel call that gets no answer from the parent page in this time rejects with HL_TIMEOUT. */
const CALL_TIMEOUT_MS = 30_000
/** listAll(): default and hard cap on contacts collected, and the page size it requests. */
const LIST_ALL_DEFAULT_MAX = 200
const LIST_ALL_HARD_MAX = 1000
const LIST_ALL_PAGE_SIZE = 100

export const HL_RUNTIME = String.raw`
(function () {
  var pending = {};
  var seq = 0;
  function HLError(payload) {
    var error = new Error((payload && payload.message) || 'HighLevel request failed');
    error.name = 'HLError';
    error.code = (payload && payload.code) || 'HL_ERROR';
    error.status = (payload && payload.status) || 0;
    error.retryable = !!(payload && payload.retryable);
    return error;
  }
  window.addEventListener('message', function (event) {
    var message = event.data;
    if (event.source !== window.parent || !message || message.__genesis !== 'hl:response' || !pending[message.id]) return;
    var request = pending[message.id];
    delete pending[message.id];
    clearTimeout(request.timer);
    if (message.ok) request.resolve(message.data); else request.reject(HLError(message.error));
  });
  function call(op, params) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      var timer = setTimeout(function () {
        delete pending[id];
        reject(HLError({ code: 'HL_TIMEOUT', message: 'HighLevel request timed out.', retryable: true }));
      }, ${CALL_TIMEOUT_MS});
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      window.parent.postMessage({ __genesis: 'hl:request', id: id, op: op, params: params || {} }, '*');
    });
  }
  function op(name) { return function (params) { return call(name, params); }; }
  async function listAll(params) {
    params = params || {};
    var max = Math.min(params.max || ${LIST_ALL_DEFAULT_MAX}, ${LIST_ALL_HARD_MAX});
    var all = [], page = 1, total = 0;
    while (all.length < max) {
      var response = await call('contacts.list', { query: params.query, limit: ${LIST_ALL_PAGE_SIZE}, page: page });
      all = all.concat(response.contacts || []);
      total = response.total;
      if (!response.hasMore || !(response.contacts || []).length) break;
      page++;
    }
    return { contacts: all.slice(0, max), total: total };
  }
  window.hl = Object.freeze({
    location: { get: op('location.get') },
    contacts: { list: op('contacts.list'), listAll: listAll, get: op('contacts.get'), create: op('contacts.create'), update: op('contacts.update') },
    conversations: { list: op('conversations.list'), messages: op('conversations.messages'), sendMessage: op('conversations.sendMessage') },
    calendars: { list: op('calendars.list'), events: op('calendars.events'), freeSlots: op('calendars.freeSlots') }
  });
  function report(message, detail) {
    window.parent.postMessage({ __genesis: 'preview:error', message: String(message), detail: detail || null }, '*');
  }
  window.addEventListener('error', function (event) { report(event.message, event.filename ? event.filename + ':' + event.lineno : null); });
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    report((reason && (reason.message || String(reason))) || 'Unhandled promise rejection', reason && reason.code);
  });
})();
`
