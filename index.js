console.log("[SkinMonitor] Plugin loaded");

const LOG_PREFIX = "[SkinMonitor]";
const STATE_EVENT = "lu-skin-monitor-state";
const SKIN_SELECTORS = [
    ".skin-name-text", // Classic Champ Select
    ".skin-name", // Swiftplay lobby
];
const POLL_INTERVAL_MS = 250;
const BRIDGE_URL = "ws://localhost:3000";

let lastLoggedSkin = null;
let pollTimer = null;
let observer = null;
let bridgeSocket = null;
let bridgeReady = false;
let bridgeQueue = [];
let bridgeErrorLogged = false;
let bridgeSetupWarned = false;

function publishSkinState(payload) {
    const detail = {
        name: payload?.skinName || null,
        skinId: Number.isFinite(payload?.skinId) ? payload.skinId : null,
        championId: Number.isFinite(payload?.championId) ? payload.championId : null,
        hasChromas: Boolean(payload?.hasChromas),
        updatedAt: Date.now(),
    };
    window.__leagueUnlockedSkinState = detail;
    try {
        window.__leagueUnlockedCurrentSkin = detail.name;
    } catch {
        // ignore
    }
    window.dispatchEvent(new CustomEvent(STATE_EVENT, { detail }));
}

function logHover(skinName) {
    console.log(`${LOG_PREFIX} Hovered skin: ${skinName}`);
    sendBridgePayload({ skin: skinName, timestamp: Date.now() });
}

function sendBridgePayload(obj) {
    try {
        const payload = JSON.stringify(obj);
        sendToBridge(payload);
    } catch (error) {
        console.warn(`${LOG_PREFIX} Failed to serialize bridge payload`, error);
    }
}

if (typeof window !== "undefined") {
    window.__leagueUnlockedBridgeEmit = sendBridgePayload;
}

function sendToBridge(payload) {
    if (!bridgeSocket || bridgeSocket.readyState === WebSocket.CLOSING || bridgeSocket.readyState === WebSocket.CLOSED) {
        bridgeQueue.push(payload);
        setupBridgeSocket();
        return;
    }

    if (bridgeSocket.readyState === WebSocket.CONNECTING) {
        bridgeQueue.push(payload);
        return;
    }

    try {
        bridgeSocket.send(payload);
    } catch (error) {
        console.warn(`${LOG_PREFIX} Bridge send failed`, error);
        bridgeQueue.push(payload);
        resetBridgeSocket();
    }
}

function setupBridgeSocket() {
    if (bridgeSocket && (bridgeSocket.readyState === WebSocket.OPEN || bridgeSocket.readyState === WebSocket.CONNECTING)) {
        return;
    }

    try {
        bridgeSocket = new WebSocket(BRIDGE_URL);
    } catch (error) {
        if (!bridgeSetupWarned) {
            console.warn(`${LOG_PREFIX} Bridge socket setup failed`, error);
            bridgeSetupWarned = true;
        }
        scheduleBridgeRetry();
        return;
    }

    bridgeSocket.addEventListener("open", () => {
        bridgeReady = true;
        flushBridgeQueue();
        bridgeErrorLogged = false;
        bridgeSetupWarned = false;
        window.__leagueUnlockedBridgeEmit = sendBridgePayload;
    });

    bridgeSocket.addEventListener("message", (event) => {
        let data = null;
        try {
            data = JSON.parse(event.data);
        } catch (error) {
            console.log(`${LOG_PREFIX} Bridge message: ${event.data}`);
            return;
        }

        if (data && data.type === "skin-state") {
            publishSkinState(data);
            return;
        }
        
        // Reset skin state when entering Lobby phase (so same skin in next game triggers detection)
        if (data && data.type === "phase-change" && data.phase === "Lobby") {
            lastLoggedSkin = null;
            console.log(`${LOG_PREFIX} Reset skin state for new game (Lobby phase)`);
            return;
        }

        console.log(`${LOG_PREFIX} Bridge message: ${event.data}`);
    });

    bridgeSocket.addEventListener("close", () => {
        bridgeReady = false;
        scheduleBridgeRetry();
    });

    bridgeSocket.addEventListener("error", (error) => {
        if (!bridgeErrorLogged) {
            console.warn(`${LOG_PREFIX} Bridge socket error`, error);
            bridgeErrorLogged = true;
        }
        bridgeReady = false;
        scheduleBridgeRetry();
    });
}

function flushBridgeQueue() {
    if (!bridgeSocket || bridgeSocket.readyState !== WebSocket.OPEN) {
        return;
    }

    while (bridgeQueue.length) {
        const payload = bridgeQueue.shift();
        try {
            bridgeSocket.send(payload);
        } catch (error) {
            console.warn(`${LOG_PREFIX} Bridge flush failed`, error);
            bridgeQueue.unshift(payload);
            resetBridgeSocket();
            break;
        }
    }
}

function scheduleBridgeRetry() {
    if (bridgeReady) {
        return;
    }

    setTimeout(setupBridgeSocket, 1000);
}

function resetBridgeSocket() {
    if (bridgeSocket) {
        try {
            bridgeSocket.close();
        } catch (error) {
            console.warn(`${LOG_PREFIX} Bridge socket close failed`, error);
        }
    }

    bridgeSocket = null;
    bridgeReady = false;
    scheduleBridgeRetry();
}

function isVisible(element) {
    if (typeof element.offsetParent === "undefined") {
        return true;
    }
    return element.offsetParent !== null;
}

function readCurrentSkin() {
    for (const selector of SKIN_SELECTORS) {
        const nodes = document.querySelectorAll(selector);
        if (!nodes.length) {
            continue;
        }

        let candidate = null;

        nodes.forEach((node) => {
            const name = node.textContent.trim();
            if (!name) {
                return;
            }

            if (isVisible(node)) {
                candidate = name;
            } else if (!candidate) {
                candidate = name;
            }
        });

        if (candidate) {
            return candidate;
        }
    }

    return null;
}

function reportSkinIfChanged() {
    const name = readCurrentSkin();
    if (!name || name === lastLoggedSkin) {
        return;
    }

    lastLoggedSkin = name;
    logHover(name);
}

function attachObservers() {
    if (observer) {
        observer.disconnect();
    }

    observer = new MutationObserver(reportSkinIfChanged);
    observer.observe(document.body, { childList: true, subtree: true });

    document.querySelectorAll("*").forEach((node) => {
        if (!node.shadowRoot || !(node.shadowRoot instanceof Node)) {
            return;
        }

        try {
            observer.observe(node.shadowRoot, { childList: true, subtree: true });
        } catch (error) {
            console.warn(`${LOG_PREFIX} Cannot observe shadowRoot`, error);
        }
    });

    if (!pollTimer) {
        pollTimer = setInterval(reportSkinIfChanged, POLL_INTERVAL_MS);
    }
}

function start() {
    if (!document.body) {
        console.log(`${LOG_PREFIX} Waiting for document.body...`);
        setTimeout(start, 250);
        return;
    }

    setupBridgeSocket();
    attachObservers();
    reportSkinIfChanged();
}

function stop() {
    if (observer) {
        observer.disconnect();
        observer = null;
    }

    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }

    if (bridgeSocket) {
        bridgeSocket.close();
        bridgeSocket = null;
    }
}

function whenReady(callback) {
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", callback, { once: true });
        return;
    }

    callback();
}

whenReady(start);
window.addEventListener("beforeunload", stop);
