/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { resolveBuildReleaseIdentity } from './release.config';
import { resolveWhatsNewLatest } from './whats-new.config';

const RELEASE_IDENTITY = resolveBuildReleaseIdentity();

/**
 * Vitest config for the webui (dev-only). Kept SEPARATE from `vite.config.ts`
 * (the production build config) so the build path is untouched. Runs component
 * tests in jsdom with the React plugin and the jest-dom setup.
 */
export default defineConfig({
  plugins: [react()],
  define: {
    __TLSOC_RELEASE_IDENTITY__: JSON.stringify(RELEASE_IDENTITY),
    __AGENTIC_SOC_WHATS_NEW_LATEST__: JSON.stringify(resolveWhatsNewLatest()),
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
