/**
 * @name Rose-SkinMonitor
 * @author Rose Team
 * @description Skin monitor for Pengu Loader
 * @link https://github.com/Alban1911/Rose-SkinMonitor
 */

console.log("[SkinMonitor] Plugin loaded");

const LOG_PREFIX = "[SkinMonitor]";
const STATE_EVENT = "lu-skin-monitor-state";
const SKIN_SELECTORS = [
  ".skin-name-text", // Classic Champ Select
  ".skin-name", // Swiftplay lobby
];
const POLL_INTERVAL_MS = 250;
let BRIDGE_PORT = 50000; // Default, will be updated from /bridge-port endpoint
let BRIDGE_URL = `ws://localhost:${BRIDGE_PORT}`;
const BRIDGE_PORT_STORAGE_KEY = "rose_bridge_port";
const DISCOVERY_START_PORT = 50000;
const DISCOVERY_END_PORT = 50010;

// Load bridge port with file-based discovery and localStorage caching
async function loadBridgePort() {
  try {
    // First, check localStorage for cached port
    const cachedPort = localStorage.getItem(BRIDGE_PORT_STORAGE_KEY);
    if (cachedPort) {
      const port = parseInt(cachedPort, 10);
      if (!isNaN(port) && port > 0) {
        // Verify cached port is still valid
        try {
          const response = await fetch(`http://localhost:${port}/bridge-port`, {
            signal: AbortSignal.timeout(1000)
          });
          if (response.ok) {
            const portText = await response.text();
            const fetchedPort = parseInt(portText.trim(), 10);
            if (!isNaN(fetchedPort) && fetchedPort > 0) {
              BRIDGE_PORT = fetchedPort;
              BRIDGE_URL = `ws://localhost:${BRIDGE_PORT}`;
              console.log(`${LOG_PREFIX} Loaded bridge port from cache: ${BRIDGE_PORT}`);
              return true;
            }
          }
        } catch (e) {
          // Cached port invalid, continue to discovery
          localStorage.removeItem(BRIDGE_PORT_STORAGE_KEY);
        }
      }
    }
    
    // Discovery: try /bridge-port endpoint on high ports (50000-50010)
    for (let port = DISCOVERY_START_PORT; port <= DISCOVERY_END_PORT; port++) {
      try {
        const response = await fetch(`http://localhost:${port}/bridge-port`, {
          signal: AbortSignal.timeout(1000)
        });
        if (response.ok) {
          const portText = await response.text();
          const fetchedPort = parseInt(portText.trim(), 10);
          if (!isNaN(fetchedPort) && fetchedPort > 0) {
            BRIDGE_PORT = fetchedPort;
            BRIDGE_URL = `ws://localhost:${BRIDGE_PORT}`;
            // Cache the discovered port
            localStorage.setItem(BRIDGE_PORT_STORAGE_KEY, String(BRIDGE_PORT));
            console.log(`${LOG_PREFIX} Loaded bridge port: ${BRIDGE_PORT}`);
            return true;
          }
        }
      } catch (e) {
        continue;
      }
    }
    
    // Fallback: try old /port endpoint for backward compatibility
    for (let port = DISCOVERY_START_PORT; port <= DISCOVERY_END_PORT; port++) {
      try {
        const response = await fetch(`http://localhost:${port}/port`, {
          signal: AbortSignal.timeout(1000)
        });
        if (response.ok) {
          const portText = await response.text();
          const fetchedPort = parseInt(portText.trim(), 10);
          if (!isNaN(fetchedPort) && fetchedPort > 0) {
            BRIDGE_PORT = fetchedPort;
            BRIDGE_URL = `ws://localhost:${BRIDGE_PORT}`;
            localStorage.setItem(BRIDGE_PORT_STORAGE_KEY, String(BRIDGE_PORT));
            console.log(`${LOG_PREFIX} Loaded bridge port (legacy): ${BRIDGE_PORT}`);
            return true;
          }
        }
      } catch (e) {
        continue;
      }
    }
    
    console.warn(`${LOG_PREFIX} Failed to load bridge port, using default (50000)`);
    return false;
  } catch (e) {
    console.warn(`${LOG_PREFIX} Error loading bridge port:`, e);
    return false;
  }
}

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
    championId: Number.isFinite(payload?.championId)
      ? payload.championId
      : null,
    hasChromas: Boolean(payload?.hasChromas),
    updatedAt: Date.now(),
  };
  window.__roseSkinState = detail;
  try {
    window.__roseCurrentSkin = detail.name;
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
  window.__roseBridgeEmit = sendBridgePayload;
}

function sendToBridge(payload) {
  if (
    !bridgeSocket ||
    bridgeSocket.readyState === WebSocket.CLOSING ||
    bridgeSocket.readyState === WebSocket.CLOSED
  ) {
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
  if (
    bridgeSocket &&
    (bridgeSocket.readyState === WebSocket.OPEN ||
      bridgeSocket.readyState === WebSocket.CONNECTING)
  ) {
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
    window.__roseBridgeEmit = sendBridgePayload;
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

    if (data && data.type === "skin-mods-response") {
      window.dispatchEvent(
        new CustomEvent("rose-custom-wheel-skin-mods", { detail: data })
      );
      return;
    }

    if (data && data.type === "maps-response") {
      window.dispatchEvent(
        new CustomEvent("rose-custom-wheel-maps", { detail: data })
      );
      return;
    }

    if (data && data.type === "fonts-response") {
      window.dispatchEvent(
        new CustomEvent("rose-custom-wheel-fonts", { detail: data })
      );
      return;
    }

    if (data && data.type === "announcers-response") {
      window.dispatchEvent(
        new CustomEvent("rose-custom-wheel-announcers", { detail: data })
      );
      return;
    }

    if (data && data.type === "others-response") {
      window.dispatchEvent(
        new CustomEvent("rose-custom-wheel-others", { detail: data })
      );
      return;
    }

    // Reset skin state when entering Lobby phase (so same skin in next game triggers detection)
    if (data && data.type === "champion-locked") {
      window.dispatchEvent(
        new CustomEvent("rose-custom-wheel-champion-locked", { detail: data })
      );
      return;
    }

    if (data && data.type === "phase-change" && data.phase === "Lobby") {
      lastLoggedSkin = null;
      console.log(`${LOG_PREFIX} Reset skin state for new game (Lobby phase)`);
      window.dispatchEvent(new CustomEvent("rose-custom-wheel-reset"));
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

async function start() {
  if (!document.body) {
    console.log(`${LOG_PREFIX} Waiting for document.body...`);
    setTimeout(start, 250);
    return;
  }

  // Load bridge port before initializing socket
  await loadBridgePort();

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
