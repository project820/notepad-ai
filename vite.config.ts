import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';

/**
 * CSP split (Phase 1 security gate). The shipped index.html carries the strict
 * production policy (connect-src 'none', object/frame/base/form locked down). In
 * dev, Vite's HMR client needs a WebSocket to localhost:5173, so the serve build
 * relaxes connect-src to localhost only — never in the packaged app.
 */
const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none';";
const DEV_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ws://localhost:5173 http://localhost:5173; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none';";

function cspPlugin(isDev: boolean): Plugin {
  const csp = isDev ? DEV_CSP : PROD_CSP;
  return {
    name: 'notepad-ai-csp',
    transformIndexHtml(html) {
      return html.replace(
        /(<meta http-equiv="Content-Security-Policy" content=")[^"]*(")/,
        (_m, pre: string, post: string) => `${pre}${csp}${post}`,
      );
    },
  };
}

export default defineConfig(({ command }) => ({
  root: 'src/renderer',
  base: './',
  plugins: [cspPlugin(command === 'serve')],
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
}));
