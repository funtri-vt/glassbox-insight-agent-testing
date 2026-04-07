import { vi } from 'vitest';

// Mock the global Chrome API shell so top-level listeners don't crash on import
global.chrome = {
    runtime: {
        onInstalled: { addListener: vi.fn() },
        onStartup: { addListener: vi.fn() }
    },
    idle: {
        setDetectionInterval: vi.fn(),
        onStateChanged: { addListener: vi.fn() }
    },
    alarms: {
        create: vi.fn(),
        onAlarm: { addListener: vi.fn() }
    },
    tabs: {
        onActivated: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn() },
        onReplaced: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() }
    },
    windows: {
        onFocusChanged: { addListener: vi.fn() },
        WINDOW_ID_NONE: -1
    },
    webNavigation: {
        onHistoryStateUpdated: { addListener: vi.fn() },
        onReferenceFragmentUpdated: { addListener: vi.fn() }
    },
    storage: {
        local: {
            get: vi.fn(),
            set: vi.fn()
        }
    },
    identity: {
        getProfileUserInfo: vi.fn()
    }
};