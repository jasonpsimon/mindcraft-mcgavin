import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // Stub domain modules that don't exist yet (created in Tasks 8 and 9).
      {
        find: /.*\/skills\/blocks\.js$/,
        replacement: path.resolve(__dirname, 'tests/stubs/blocks.stub.js'),
      },
      {
        find: /.*\/skills\/movement\.js$/,
        replacement: path.resolve(__dirname, 'tests/stubs/movement.stub.js'),
      },
    ],
  },
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup/vitest-setup.js'],
  },
});
