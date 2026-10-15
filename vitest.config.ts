import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // BRIEFSTACK_HOME and the home folder point at a temp folder in every test file.
    setupFiles: ['tests/setup-env.ts'],
  },
});
