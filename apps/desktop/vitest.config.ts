import type { TestProjectConfiguration } from 'vitest/config'
import { defineConfig } from 'vitest/config'

const windowsSerial = process.platform === 'win32'

const reactUi: TestProjectConfiguration = {
  extends: './vite.config.ts',
  test: {
    name: 'ui',
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    globals: true,
    ...(windowsSerial ? { fileParallelism: false, sequence: { groupOrder: 1 } } : {})
  }
}

const electronNative: TestProjectConfiguration = {
  test: {
    name: 'electron',
    environment: 'node',
    include: ['electron/**/*.test.ts', 'scripts/**.test.{ts,mjs}'],
    ...(windowsSerial ? { fileParallelism: false, sequence: { groupOrder: 0 } } : {})
  }
}

export default defineConfig({
  test: {
    projects: [reactUi, electronNative]
  }
})
