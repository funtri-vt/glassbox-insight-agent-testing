import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeUrl, extractDomain, updateActiveSession } from '../src/background.js';

describe('URL Normalizer Edge Cases (normalizeUrl)', () => {
    it('should extract standard domains and strip trailing slashes', () => {
        expect(normalizeUrl('https://example.com')).toBe('example.com');
        expect(normalizeUrl('https://www.example.com/')).toBe('example.com');
    });

    it('should strip query parameters', () => {
        expect(normalizeUrl('https://example.com/search?q=math+help')).toBe('example.com/search');
    });

    it('should strip standard anchor tags (hash)', () => {
        expect(normalizeUrl('https://example.com/page#section-2')).toBe('example.com/page');
    });

    it('should PRESERVE SPA hash routes', () => {
        expect(normalizeUrl('https://example.com/#/dashboard/grades')).toBe('example.com/#/dashboard/grades');
    });

    it('should act as a protocol bouncer and return null for internal pages', () => {
        expect(normalizeUrl('chrome://settings/')).toBeNull();
        expect(normalizeUrl('chrome-extension://abcdefg/options.html')).toBeNull();
        expect(normalizeUrl('file:///C:/Users/Student/homework.pdf')).toBeNull();
    });

    it('should fail gracefully on malformed strings', () => {
        expect(normalizeUrl('just some random text')).toBeNull();
    });
});

describe('The Stopwatch Logic (updateActiveSession)', () => {
    let mockStorage = {};

    beforeEach(() => {
        // Reset our fake Chrome Storage before every test
        mockStorage = { timeLogs: {}, activeSession: null };
        
        // Attach our custom logic to the global mock defined in setup.js
        global.chrome.storage.local.get.mockImplementation(async () => mockStorage);
        global.chrome.storage.local.set.mockImplementation(async (data) => {
            mockStorage = { ...mockStorage, ...data };
        });
        
        // Mock Date.now() to control time
        vi.useFakeTimers();
    });

    it('should start a new session correctly', async () => {
        vi.setSystemTime(1000000); // Set fixed start time
        await updateActiveSession('https://school.edu/math', false);
        
        expect(mockStorage.activeSession).toEqual({
            domain: 'school.edu',
            startTime: 1000000
        });
    });

    it('should close a session and calculate elapsed time correctly', async () => {
        // 1. Setup an existing 5-minute session
        const fiveMinutesMs = 5 * 60 * 1000;
        mockStorage.activeSession = {
            domain: 'school.edu',
            startTime: Date.now() - fiveMinutesMs
        };

        // 2. Trigger an update (switching to a new site)
        await updateActiveSession('https://wikipedia.org', false);

        // 3. Verify math
        expect(mockStorage.timeLogs['school.edu']).toBe(5);
        expect(mockStorage.activeSession.domain).toBe('wikipedia.org');
    });

    it('should drop the active session when idle', async () => {
        mockStorage.activeSession = { domain: 'school.edu', startTime: Date.now() };
        
        // Passing 'true' for isIdleOrInactive
        await updateActiveSession(null, true);
        
        expect(mockStorage.activeSession).toBeNull();
    });

    it('should ignore massive sessions over 240 minutes (cap limit)', async () => {
        const tenHoursMs = 10 * 60 * 60 * 1000;
        mockStorage.activeSession = {
            domain: 'school.edu',
            startTime: Date.now() - tenHoursMs
        };

        await updateActiveSession('https://wikipedia.org', false);

        // It should NOT have added 600 minutes to the ledger
        expect(mockStorage.timeLogs['school.edu']).toBeUndefined();
    });
});