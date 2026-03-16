const serverUrlInput = document.getElementById('serverUrl');
const saveUrlBtn = document.getElementById('saveUrl');
const statusDiv = document.getElementById('status');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const logDiv = document.getElementById('log');

chrome.storage.local.get('serverUrl', (data) => {
    if (data.serverUrl) serverUrlInput.value = data.serverUrl;
});

saveUrlBtn.addEventListener('click', () => {
    const url = serverUrlInput.value.trim();
    if (url) {
        chrome.storage.local.set({ serverUrl: url }, () => {
            addLog('✅ URL сохранён: ' + url);
        });
    }
});

function addLog(message) {
    const line = document.createElement('div');
    line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + message;
    logDiv.appendChild(line);
    logDiv.scrollTop = logDiv.scrollHeight;
    while (logDiv.children.length > 100) logDiv.removeChild(logDiv.firstChild);
}

function updateStatus(connected) {
    if (connected) {
        statusDiv.className = 'status connected';
        statusDiv.textContent = '✅ Подключено';
        connectBtn.disabled = true;
        disconnectBtn.disabled = false;
    } else {
        statusDiv.className = 'status disconnected';
        statusDiv.textContent = '❌ Отключено';
        connectBtn.disabled = false;
        disconnectBtn.disabled = true;
    }
}

connectBtn.addEventListener('click', () => {
    const url = serverUrlInput.value.trim();
    if (url) {
        // Сохраняем URL в storage
        chrome.storage.local.set({ serverUrl: url }, () => {
            // После сохранения отправляем команду подключения
            chrome.runtime.sendMessage({ target: 'offscreen', type: 'connect' });
            addLog('🔄 Подключение к ' + url + '...');
        });
    } else {
        addLog('❌ Введите URL сервера');
    }
});

disconnectBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'disconnect' });
    addLog('🛑 Отключение...');
});

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'log') addLog(msg.text);
    else if (msg.type === 'status') updateStatus(msg.connected);
});

// Запрос статуса при открытии
chrome.runtime.sendMessage({ target: 'offscreen', type: 'getStatus' }, (response) => {
    if (response) updateStatus(response.connected);
});