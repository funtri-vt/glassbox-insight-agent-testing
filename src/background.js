// ==========================================
// 🚀 INITIALIZATION & SETUP
// ==========================================
chrome.runtime.onInstalled.addListener(async () => {
    console.log("Glassbox Insight Installed. Initializing Engine...");

    // 1. Set Chrome to detect "Idle" state after 60 seconds of no mouse/keyboard input
    chrome.idle.setDetectionInterval(60);

    // 2. Create our recurring alarms
    // Sync settings every 6 hours, but batch upload data every 1 hour
    chrome.alarms.create("syncInsightConfig", { periodInMinutes: 360 });
    chrome.alarms.create("ingestInsightLogs", { periodInMinutes: 60 });
    
    // 3. Identity Hashing Setup (Same as Filter Agent)
    try {
        const userInfo = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" });
        const email = userInfo.email || "anonymous@student.local";
        
        const encoder = new TextEncoder();
        const data = encoder.encode(email);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const studentHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        await chrome.storage.local.set({ studentHash: studentHash });
        console.log("✅ Student ID securely hashed:", studentHash);
        
        // 4. Trigger an immediate sync right after installation
        await syncConfig();
        
    } catch (error) {
        console.error("❌ Failed to hash identity:", error);
    }
});

// ==========================================
// ⏱️ THE STOPWATCH STATE MACHINE
// ==========================================

// Helper: Safely extract domain from URL (removes www.)
function extractDomain(urlStr) {
    try {
        const urlObj = new URL(urlStr);
        return urlObj.hostname.replace(/^www\./, '');
    } catch (e) {
        return null; // Invalid URL or internal chrome:// page
    }
}

// Core logic: Closes the previous timer and starts a new one
async function updateActiveSession(newUrl, isIdleOrInactive) {
    const data = await chrome.storage.local.get(['activeSession', 'timeLogs']);
    let timeLogs = data.timeLogs || {};
    let activeSession = data.activeSession || null;

    const now = Date.now();

    // 1. Close out the previous session if one exists
    if (activeSession) {
        const elapsedMs = now - activeSession.startTime;
        const elapsedMins = elapsedMs / (1000 * 60);

        // Sanity Check: Cap at 4 hours just in case the computer fell asleep weirdly
        if (elapsedMins > 0 && elapsedMins < 240) {
            timeLogs[activeSession.domain] = (timeLogs[activeSession.domain] || 0) + elapsedMins;
        }
    }

    // 2. Start the new session
    if (isIdleOrInactive || !newUrl || newUrl.startsWith('chrome://')) {
        activeSession = null; // Pause the stopwatch entirely
    } else {
        const domain = extractDomain(newUrl);
        if (domain) {
            activeSession = { domain: domain, startTime: now };
        } else {
            activeSession = null;
        }
    }

    // 3. Save the updated stopwatch state back to Chrome storage
    await chrome.storage.local.set({ activeSession, timeLogs });
}

// ==========================================
// 🎧 BROWSER EVENT LISTENERS
// ==========================================

// Trigger 1: User switches tabs
chrome.tabs.onActivated.addListener(async (activeInfo) => {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    await updateActiveSession(tab.url, false);
});

// Trigger 2: User navigates to a new URL in the current tab
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.url && tab.active) {
        await updateActiveSession(changeInfo.url, false);
    }
});

// Trigger 3: User minimizes Chrome or switches to another desktop app
chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
        // Chrome lost focus completely. Pause the stopwatch!
        await updateActiveSession(null, true);
    } else {
        // Chrome regained focus. Find the active tab and resume!
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length > 0) {
            await updateActiveSession(tabs[0].url, false);
        }
    }
});

// Trigger 4: User walks away from the keyboard (Idle Detection)
chrome.idle.onStateChanged.addListener(async (newState) => {
    if (newState === 'idle' || newState === 'locked') {
        console.log("User went idle. Pausing stopwatch.");
        await updateActiveSession(null, true);
    } else if (newState === 'active') {
        console.log("User returned. Resuming stopwatch.");
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length > 0) {
            await updateActiveSession(tabs[0].url, false);
        }
    }
});

// ==========================================
// ☁️ CLOUDFLARE SYNC & INGEST ENGINE
// ==========================================

async function syncConfig() {
    console.log("🔄 Fetching Insight Settings from Cloudflare...");
    try {
        const configUrl = chrome.runtime.getURL("config.json");
        const localConfig = await (await fetch(configUrl)).json();
        const baseUrl = localConfig.workerUrl.endsWith('/') ? localConfig.workerUrl.slice(0, -1) : localConfig.workerUrl;

        const response = await fetch(`${baseUrl}/api/insight/sync`);
        if (!response.ok) throw new Error("Sync failed");
        
        const data = await response.json();
        
        // Save the approved apps and thresholds locally
        await chrome.storage.local.set({
            approvedApps: data.approvedApps,
            systemConfig: data.config
        });
        
        console.log("✅ Config Synced!");
    } catch (err) {
        console.error("❌ Sync Error:", err);
    }
}

async function uploadLogs() {
    console.log("📤 Preparing to batch upload time logs...");
    try {
        // 1. Force the stopwatch to close out the current session so the data is fresh
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length > 0) {
            await updateActiveSession(tabs[0].url, false);
        }

        const data = await chrome.storage.local.get(['studentHash', 'timeLogs', 'approvedApps', 'systemConfig']);
        
        const timeLogs = data.timeLogs || {};
        const approvedSet = new Set(data.approvedApps || []);
        // Default to 5 mins if the config is missing
        const threshold = parseFloat(data.systemConfig?.insight_unapproved_threshold_minutes || "5");

        const logsToUpload = [];

        // 2. Filter the logs based on the School's Settings!
        for (const [domain, minutes] of Object.entries(timeLogs)) {
            if (approvedSet.has(domain)) {
                // ALWAYS upload approved app data (for ROI calculation)
                logsToUpload.push({ target: domain, minutes: minutes });
            } else if (minutes >= threshold) {
                // ONLY upload shadow IT data if they spent more than the threshold on it
                logsToUpload.push({ target: domain, minutes: minutes });
            }
        }

        if (logsToUpload.length === 0) {
            console.log("No significant logs to upload this hour.");
            return;
        }

        const configUrl = chrome.runtime.getURL("config.json");
        const localConfig = await (await fetch(configUrl)).json();
        const baseUrl = localConfig.workerUrl.endsWith('/') ? localConfig.workerUrl.slice(0, -1) : localConfig.workerUrl;

        // 3. Send the batched array to the server
        const response = await fetch(`${baseUrl}/api/insight/ingest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                studentHash: data.studentHash,
                logs: logsToUpload
            })
        });

        if (response.ok) {
            // 4. CRITICAL: Wipe the local timeLogs so we don't upload duplicates next hour!
            await chrome.storage.local.set({ timeLogs: {} });
            console.log(`✅ Uploaded ${logsToUpload.length} app logs successfully!`);
        } else {
            console.error("❌ Upload failed. Will try again next hour.");
        }

    } catch (err) {
        console.error("❌ Batch Upload Error:", err);
    }
}

// Route our Alarms
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "syncInsightConfig") {
        syncConfig();
    } else if (alarm.name === "ingestInsightLogs") {
        uploadLogs();
    }
});
