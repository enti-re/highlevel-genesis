/**
 * `window.hl` for the sandboxed preview: forwards calls to the parent over postMessage,
 * so no token ever enters the iframe. Keep in sync with functions/src/generation/spec.ts.
 */
export const HL_RUNTIME = String.raw`
(function () {
  var pending = {};
  var seq = 0;
  function HLError(p) {
    var e = new Error((p && p.message) || 'HighLevel request failed');
    e.name = 'HLError';
    e.code = (p && p.code) || 'HL_ERROR';
    e.status = (p && p.status) || 0;
    e.retryable = !!(p && p.retryable);
    return e;
  }
  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (ev.source !== window.parent || !m || m.__genesis !== 'hl:response' || !pending[m.id]) return;
    var p = pending[m.id];
    delete pending[m.id];
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m.data); else p.reject(HLError(m.error));
  });
  function call(op, params) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      var timer = setTimeout(function () {
        delete pending[id];
        reject(HLError({ code: 'HL_TIMEOUT', message: 'HighLevel request timed out.', retryable: true }));
      }, 30000);
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      window.parent.postMessage({ __genesis: 'hl:request', id: id, op: op, params: params || {} }, '*');
    });
  }
  function op(name) { return function (params) { return call(name, params); }; }
  async function listAll(params) {
    params = params || {};
    var max = Math.min(params.max || 200, 1000);
    var all = [], page = 1, total = 0;
    while (all.length < max) {
      var r = await call('contacts.list', { query: params.query, limit: 100, page: page });
      all = all.concat(r.contacts || []);
      total = r.total;
      if (!r.hasMore || !(r.contacts || []).length) break;
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
  window.addEventListener('error', function (e) { report(e.message, e.filename ? e.filename + ':' + e.lineno : null); });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    report((r && (r.message || String(r))) || 'Unhandled promise rejection', r && r.code);
  });
})();
`
