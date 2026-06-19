import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for notepad-ai unit tests.
 * Tests run in a pure Node environment — no DOM, no Electron.
 *
 * Include patterns:
 *   - src/__tests__/**\/*.test.ts   (project-root test directory)
 *   - src/**\/__tests__/**\/*.test.ts  (co-located __tests__ folders per module)
 *   - src/**\/*.test.ts               (*.test.ts alongside source files)
 *
 * ROLLBACK SAFETY: This file is additive. Removing it (or the test script)
 * does not affect the production build pipeline.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/__tests__/**/*.test.ts',
      'src/**/__tests__/**/*.test.ts',
      'src/**/*.test.ts',
    ],
    exclude: [
      'dist/**',
      'node_modules/**',
      // overview-traversal.test.ts uses node:test (not Vitest) — excluded here;
      // run it via: node --test dist/main/overview-traversal.test.js
      'src/main/**/*.test.ts',
    ],
    globals: false,
    reporter: 'verbose',
  },
});
