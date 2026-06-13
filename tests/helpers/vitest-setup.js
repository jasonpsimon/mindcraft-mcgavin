import { vi } from 'vitest';

// Mock settings to avoid file-system reads at import time (plan Task 3 fallback)
vi.mock('../../src/agent/settings.js', () => ({
    default: { max_messages: 30, minecraft_version: '1.20.1' },
}));
