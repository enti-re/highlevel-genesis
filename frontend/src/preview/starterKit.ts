/**
 * Preloaded into every preview: Vue 3, Tailwind v4, shadcn tokens, lucide, `genesis` helpers.
 * Keep in sync with the "Starter kit" section of functions/src/generation/prompt.ts.
 */

export const KIT_VERSIONS = { vue: '3.5.44', tailwind: '4.3.3', lucide: '1.59.0' }

/** SRI for the pinned CDN files. Update with KIT_VERSIONS: curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A */
const KIT_SRI = {
  vue: 'sha384-tORx0bXmMnTC28EYQe1coaGZKSQupXQEYDBNex8xkzJ9iqUoNy9Y+VFBhVxi4kUr',
  tailwind: 'sha384-2ql948lIdLcGEE0/qxNiudyTjgauA3RDJERu5xW75kFCvSl5a9odyQYCb6tEjnmB',
  lucide: 'sha384-4VQAGBhahgTiMVvXUqbh6qcs45zGzR/8znv7XORRfWkxZfzRbhLL5Uh+fSdvdqdM',
}
const cdnScript = (url: string, integrity: string) => `<script src="${url}" integrity="${integrity}" crossorigin="anonymous"></script>`

const THEME_CSS = `
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --radius-sm: calc(var(--radius) * 0.6);
  --radius-md: calc(var(--radius) * 0.8);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) * 1.4);
  --font-sans: 'Inter', ui-sans-serif, system-ui, sans-serif;
}
:root {
  --radius: 0.625rem;
  --background: oklch(1 0 0);
  --foreground: oklch(0.141 0.005 285.823);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.141 0.005 285.823);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.141 0.005 285.823);
  --primary: oklch(0.21 0.006 285.885);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.967 0.001 286.375);
  --secondary-foreground: oklch(0.21 0.006 285.885);
  --muted: oklch(0.967 0.001 286.375);
  --muted-foreground: oklch(0.552 0.016 285.938);
  --accent: oklch(0.967 0.001 286.375);
  --accent-foreground: oklch(0.21 0.006 285.885);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.92 0.004 286.32);
  --input: oklch(0.92 0.004 286.32);
  --ring: oklch(0.705 0.015 286.067);
}
@layer base {
  * { border-color: var(--border); }
  body { background: var(--background); color: var(--foreground); font-family: var(--font-sans); -webkit-font-smoothing: antialiased; }
}`

/** `window.genesis`: resolves Vue lazily so it always uses the single loaded Vue instance. */
const HELPERS_JS = String.raw`
(function () {
  var V = function () { return window.Vue; };
  var MESSAGES = {
    HL_NOT_CONNECTED: 'Connect HighLevel from the Genesis dashboard to see your data.',
    HL_RECONNECT: 'Your HighLevel connection expired. Reconnect it from the Genesis dashboard.',
    HL_FORBIDDEN: 'This app needs a HighLevel permission that is not granted yet.',
    HL_RATE_LIMITED: 'Too many requests to HighLevel. Try again in a moment.',
    HL_TIMEOUT: 'HighLevel took too long to respond. Try again.',
    HL_UNAVAILABLE: 'HighLevel is having trouble right now. Try again shortly.',
    HL_NOT_FOUND: 'That record was not found in HighLevel.'
  };
  function toPascal(name) {
    return String(name || '').split(/[-_\s]+/).map(function (p) { return p.charAt(0).toUpperCase() + p.slice(1); }).join('');
  }
  var GIcon = {
    name: 'GIcon',
    props: { name: { type: String, required: true }, size: { type: [Number, String], default: 16 }, strokeWidth: { type: [Number, String], default: 2 } },
    setup: function (props) {
      return function () {
        var h = V().h;
        var icons = (window.lucide && window.lucide.icons) || {};
        var node = icons[toPascal(props.name)] || icons.CircleHelp || [];
        return h('svg', {
          xmlns: 'http://www.w3.org/2000/svg', width: props.size, height: props.size, viewBox: '0 0 24 24',
          fill: 'none', stroke: 'currentColor', 'stroke-width': props.strokeWidth,
          'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'
        }, node.map(function (n) { return h(n[0], n[1]); }));
      };
    }
  };
  window.genesis = Object.freeze({
    install: function (app) { app.component('GIcon', GIcon); },
    /** Wraps an hl call: { data, loading, error, reload }. Stale responses (e.g. fast typing) are dropped. */
    useHl: function (loader, opts) {
      var ref = V().ref;
      var data = ref(null), loading = ref(false), error = ref(null), seq = 0;
      function reload() {
        var id = ++seq, args = arguments;
        loading.value = true; error.value = null;
        return Promise.resolve().then(function () { return loader.apply(null, args); }).then(
          function (r) { if (id === seq) { data.value = r; loading.value = false; } return r; },
          function (e) { if (id === seq) { error.value = e; loading.value = false; } }
        );
      }
      if (!opts || opts.immediate !== false) reload();
      return { data: data, loading: loading, error: error, reload: reload };
    },
    errorText: function (err) {
      return (err && MESSAGES[err.code]) || (err && err.message) || 'Something went wrong.';
    },
    formatDate: function (d) {
      if (!d) return '-';
      var x = new Date(d);
      return isNaN(x) ? '-' : x.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    },
    formatDateTime: function (d) {
      if (!d) return '-';
      var x = new Date(d);
      return isNaN(x) ? '-' : x.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    },
    initials: function (name) {
      return String(name || '?').trim().split(/\s+/).slice(0, 2).map(function (p) { return p.charAt(0).toUpperCase(); }).join('') || '?';
    }
  });
})();
`

export const KIT_HEAD = [
  '<meta charset="utf-8" />',
  '<meta name="viewport" content="width=device-width, initial-scale=1" />',
  '<link rel="preconnect" href="https://fonts.googleapis.com" />',
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" />',
  cdnScript(`https://cdn.jsdelivr.net/npm/vue@${KIT_VERSIONS.vue}/dist/vue.global.prod.js`, KIT_SRI.vue),
  cdnScript(`https://cdn.jsdelivr.net/npm/@tailwindcss/browser@${KIT_VERSIONS.tailwind}/dist/index.global.js`, KIT_SRI.tailwind),
  cdnScript(`https://cdn.jsdelivr.net/npm/lucide@${KIT_VERSIONS.lucide}/dist/umd/lucide.min.js`, KIT_SRI.lucide),
  `<style type="text/tailwindcss">${THEME_CSS}</style>`,
  `<script>${HELPERS_JS}</script>`,
].join('\n')

/** Kit libraries the model may add again; a second Vue silently breaks reactivity, so they are stripped. */
export const KIT_DUPLICATE_SCRIPT =
  /<script\b[^>]*\bsrc\s*=\s*["'][^"']*(vue(@[\d.]+)?\/dist\/vue\.|tailwindcss|lucide)[^"']*["'][^>]*>\s*<\/script>/gi
