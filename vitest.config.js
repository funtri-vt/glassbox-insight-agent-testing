import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    // Clear mocks between tests to ensure a clean slate
    clearMocks: true,
  },
});