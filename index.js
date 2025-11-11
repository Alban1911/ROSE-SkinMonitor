console.log("[SkinMonitor] Plugin loaded");

const LOG_PREFIX = "[SkinMonitor]";
const SKIN_SELECTOR = ".skin-name-text";
const POLL_INTERVAL_MS = 250;

let lastLoggedSkin = null;
let pollTimer = null;
let observer = null;

function logHover(skinName) {
    console.log(`${LOG_PREFIX} Hovered skin: ${skinName}`);
}

function isVisible(element) {
    if (typeof element.offsetParent === "undefined") {
        return true;
    }
    return element.offsetParent !== null;
}

function readCurrentSkin() {
    const nodes = document.querySelectorAll(SKIN_SELECTOR);
    if (!nodes.length) {
        return null;
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

    return candidate;
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
