import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // BRIEFSTACK_HOME and the home folder point at a temp folder in every test file.
    setupFiles: ['tests/setup-env.ts'],
    // Many tests run git: under a full parallel run on Windows the 5 s default was too tight,
    // and on a slow Windows CI runner 30 s was too (phase 11: a validation test that takes
    // 18 s there took 34 s in another run).
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
