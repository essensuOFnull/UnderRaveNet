let socket = null;
let reconnectTimer = null;
let serverUrl = null;
let pendingConnections = new Map(); // connId -> socketId
let peerConnection = null;
let dataChannel = null;
let connected = false; // флаг, что DataChannel открыт

function log(text) {
    console.log(text);
    chrome.runtime.sendMessage({ type: 'log', text }).catch(() => {});
}

function updateStatus(connected) {
    chrome.runtime.sendMessage({ type: 'status', connected });
}

function disconnect() {
    if (socket) {
        socket.close();
        socket = null;
    }
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    dataChannel = null;
    connected = false;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    for (let [connId, sockId] of pendingConnections.entries()) {
        chrome.sockets.tcp.close(sockId, () => {});
        pendingConnections.delete(connId);
    }
    updateStatus(false);
    log('🛑 Отключено вручную');
}

function startConnection() {
    if (!serverUrl) {
        log('❌ Ошибка: не сохранён URL сервера');
        return;
    }
    if (socket) {
        socket.close();
    }
    log('🔄 Подключение к ' + serverUrl + '...');
    socket = new WebSocket(serverUrl);

    socket.onopen = () => {
        log('✅ WebSocket открыт, начинаем сигнализацию WebRTC');
        // Создаём PeerConnection
        peerConnection = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });

        // Обработка ICE кандидатов
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                socket.send(JSON.stringify({
                    type: 'candidate',
                    candidate: event.candidate.toJSON()
                }));
            }
        };

        // Обработка входящего DataChannel (сервер создаёт канал)
        peerConnection.ondatachannel = (event) => {
            dataChannel = event.channel;
            dataChannel.onopen = () => {
                log('✅ DataChannel открыт');
                connected = true;
                updateStatus(true);
            };
            dataChannel.onclose = () => {
                log('🔌 DataChannel закрыт');
                connected = false;
                updateStatus(false);
            };
            dataChannel.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    handleDataChannelMessage(msg);
                } catch (e) {
                    log('❌ Ошибка парсинга сообщения DataChannel: ' + e);
                }
            };
        };

        // Создаём offer
        peerConnection.createOffer()
            .then(offer => peerConnection.setLocalDescription(offer))
            .then(() => {
                socket.send(JSON.stringify({
                    type: 'offer',
                    sdp: peerConnection.localDescription.sdp
                }));
            })
            .catch(e => log('❌ Ошибка создания offer: ' + e));
    };

    socket.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            handleSignalMessage(msg);
        } catch (e) {
            log('❌ Ошибка обработки сигнального сообщения: ' + e);
        }
    };

    socket.onclose = () => {
        log('🔌 WebSocket закрыт');
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
        dataChannel = null;
        connected = false;
        updateStatus(false);
        // Закрываем все TCP-соединения
        for (let [connId, sockId] of pendingConnections.entries()) {
            chrome.sockets.tcp.close(sockId, () => {});
            pendingConnections.delete(connId);
        }
        // Переподключаемся, если не было ручного отключения
        if (!reconnectTimer && serverUrl) {
            reconnectTimer = setTimeout(startConnection, 5000);
        }
    };

    socket.onerror = (error) => {
        log('❌ WebSocket ошибка: ' + (error.message || 'undefined'));
    };
}

function handleSignalMessage(msg) {
    switch (msg.type) {
        case 'answer':
            if (peerConnection) {
                peerConnection.setRemoteDescription(new RTCSessionDescription(msg))
                    .catch(e => log('❌ Ошибка setRemoteDescription: ' + e));
            }
            break;
        case 'candidate':
            if (peerConnection && msg.candidate) {
                peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate))
                    .catch(e => log('❌ Ошибка addIceCandidate: ' + e));
            }
            break;
        default:
            log('⚠️ Неизвестный сигнальный тип: ' + msg.type);
    }
}

async function handleDataChannelMessage(msg) {
    switch (msg.type) {
        case 'tcp_connect':
            const { connId, address } = msg;
            const [host, portStr] = address.split(':');
            const port = parseInt(portStr, 10);

            chrome.sockets.tcp.create({}, (createInfo) => {
                if (chrome.runtime.lastError) {
                    dataChannel.send(JSON.stringify({
                        type: 'tcp_error',
                        connId,
                        error: chrome.runtime.lastError.message
                    }));
                    return;
                }
                const socketId = createInfo.socketId;

                chrome.sockets.tcp.connect(socketId, host, port, (result) => {
                    if (result < 0) {
                        dataChannel.send(JSON.stringify({
                            type: 'tcp_error',
                            connId,
                            error: 'Connection failed: ' + result
                        }));
                        chrome.sockets.tcp.close(socketId);
                        return;
                    }
                    pendingConnections.set(connId, socketId);
                    log(`✅ TCP connected: ${connId} (${address})`);

                    dataChannel.send(JSON.stringify({
                        type: 'tcp_connected',
                        connId
                    }));

                    chrome.sockets.tcp.onReceive.addListener((info) => {
                        if (info.socketId === socketId) {
                            const dataB64 = btoa(String.fromCharCode(...new Uint8Array(info.data)));
                            dataChannel.send(JSON.stringify({
                                type: 'tcp_data',
                                connId,
                                data: dataB64
                            }));
                        }
                    });

                    chrome.sockets.tcp.onReceiveError.addListener((info) => {
                        if (info.socketId === socketId) {
                            log(`TCP receive error on ${connId}: ${info.resultCode}`);
                            dataChannel.send(JSON.stringify({
                                type: 'tcp_error',
                                connId,
                                error: 'Receive error: ' + info.resultCode
                            }));
                            chrome.sockets.tcp.close(socketId);
                            pendingConnections.delete(connId);
                        }
                    });
                });
            });
            break;

        case 'tcp_data':
            const dataConnId = msg.connId;
            const dataB64 = msg.data;
            const sockId = pendingConnections.get(dataConnId);
            if (sockId) {
                const data = Uint8Array.from(atob(dataB64), c => c.charCodeAt(0));
                chrome.sockets.tcp.send(sockId, data.buffer, (sendInfo) => {
                    if (sendInfo.resultCode < 0) {
                        log(`TCP send error on ${dataConnId}: ${sendInfo.resultCode}`);
                    }
                });
            }
            break;

        case 'tcp_close':
            const closeConnId = msg.connId;
            const closeSockId = pendingConnections.get(closeConnId);
            if (closeSockId) {
                chrome.sockets.tcp.close(closeSockId, () => {});
                pendingConnections.delete(closeConnId);
                log(`TCP closed by server: ${closeConnId}`);
            }
            break;

        default:
            log('⚠️ Неизвестный тип сообщения DataChannel: ' + msg.type);
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'connect') {
        chrome.storage.local.get('serverUrl', (data) => {
            if (data.serverUrl) {
                serverUrl = data.serverUrl;
                startConnection();
            } else {
                log('❌ Сначала сохраните URL сервера');
            }
        });
        sendResponse({});
    } else if (request.type === 'disconnect') {
        disconnect();
        sendResponse({});
    } else if (request.type === 'getStatus') {
        sendResponse({ connected });
    }
});

// Автоподключение при старте расширения (если есть URL)
chrome.storage.local.get('serverUrl', (data) => {
    if (data.serverUrl) {
        serverUrl = data.serverUrl;
        startConnection();
    }
});