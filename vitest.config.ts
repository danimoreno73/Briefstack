import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // BRIEFSTACK_HOME and the home folder point at a temp folder in every test file.
    setupFiles: ['tests/setup-env.ts'],
    // Many tests run git: under a full parallel run on Windows the 5 s default was too tight.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
