// background.js

let offscreenDocumentPath = 'offscreen.html';
let creatingOffscreen = false;
let offscreenCreated = false;

// Проверка существования offscreen-документа (используем chrome.runtime.getContexts для точности)
async function hasOffscreenDocument() {
    if (chrome.runtime.getContexts) {
        const contexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
            documentUrls: [chrome.runtime.getURL(offscreenDocumentPath)]
        });
        return contexts.length > 0;
    }
    // Fallback на флаг (не идеально, но работает)
    return offscreenCreated;
}

// Создание offscreen-документа с защитой от дублирования
async function setupOffscreenDocument() {
    if (offscreenCreated || creatingOffscreen) return;
    const exists = await hasOffscreenDocument();
    if (exists) {
        offscreenCreated = true;
        return;
    }
    creatingOffscreen = true;
    try {
        await chrome.offscreen.createDocument({
            url: offscreenDocumentPath,
            reasons: ['WEB_RTC'],
            justification: 'Need WebRTC for tunneling'
        });
        offscreenCreated = true;
        console.log('Offscreen document created');
    } catch (error) {
        console.error('Failed to create offscreen:', error);
    } finally {
        creatingOffscreen = false;
    }
}

// Закрытие offscreen-документа
async function closeOffscreenDocument() {
    if (!offscreenCreated) return;
    try {
        await chrome.offscreen.closeDocument();
        offscreenCreated = false;
        console.log('Offscreen document closed');
    } catch (error) {
        console.error('Failed to close offscreen:', error);
    }
}

// Проксирование сообщений между popup и offscreen
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.target === 'offscreen') {
        setupOffscreenDocument().then(() => {
            chrome.runtime.sendMessage(msg).catch(() => {});
        });
        sendResponse({ received: true });
    } else if (msg.target === 'popup') {
        chrome.runtime.sendMessage(msg).catch(() => {});
    }
    return true;
});

// Создаём документ при старте
setupOffscreenDocument();

// Закрываем при выгрузке
chrome.runtime.onSuspend.addListener(closeOffscreenDocument);