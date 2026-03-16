// WebRTC логика выполняется здесь
let socket = null;
let peerConnection = null;
let dataChannel = null;
let serverUrl = null;
let reconnectTimer = null;
let pendingConnections = new Map(); // connId -> socketId
let connected = false;

function log(text) {
    console.log('[Offscreen]', text);
    chrome.runtime.sendMessage({ target: 'popup', type: 'log', text });
}

function updateStatus(connected) {
    chrome.runtime.sendMessage({ target: 'popup', type: 'status', connected });
}

function startConnection(url) {
	if (socket) socket.close();
    serverUrl = url;
    log('Подключение к ' + serverUrl);

    socket = new WebSocket(serverUrl);

    // Таймаут на случай, если сервер не отвечает
    const connectionTimeout = setTimeout(() => {
        if (socket.readyState === WebSocket.CONNECTING) {
            socket.close();
            log('❌ Таймаут подключения к серверу');
        }
    }, 10000); // 10 секунд

    socket.onopen = () => {
		clearTimeout(connectionTimeout);
        log('WebSocket открыт, начинаем WebRTC сигнализацию');
        peerConnection = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                socket.send(JSON.stringify({
                    type: 'candidate',
                    candidate: event.candidate.toJSON()
                }));
            }
        };

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
                    log('Ошибка парсинга DataChannel: ' + e);
                }
            };
        };

        peerConnection.createOffer()
            .then(offer => peerConnection.setLocalDescription(offer))
            .then(() => {
                socket.send(JSON.stringify({
                    type: 'offer',
                    sdp: peerConnection.localDescription.sdp
                }));
            })
            .catch(e => log('Ошибка создания offer: ' + e));
    };

    socket.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            handleSignalMessage(msg);
        } catch (e) {
            log('Ошибка сигнального сообщения: ' + e);
        }
    };

    socket.onclose = () => {
        log('WebSocket закрыт');
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
        dataChannel = null;
        connected = false;
        updateStatus(false);
        for (let [connId, sockId] of pendingConnections.entries()) {
            chrome.sockets.tcp.close(sockId, () => {});
            pendingConnections.delete(connId);
        }
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => startConnection(serverUrl), 5000);
    };

    socket.onerror = (error) => {
        clearTimeout(connectionTimeout);
        log('❌ WebSocket ошибка: ' + (error.message || 'unknown'));
    };
}

function handleSignalMessage(msg) {
    switch (msg.type) {
        case 'answer':
            if (peerConnection) {
                peerConnection.setRemoteDescription(new RTCSessionDescription(msg))
                    .catch(e => log('setRemoteDescription error: ' + e));
            }
            break;
        case 'candidate':
            if (peerConnection && msg.candidate) {
                peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate))
                    .catch(e => log('addIceCandidate error: ' + e));
            }
            break;
        default:
            log('Неизвестный сигнальный тип: ' + msg.type);
    }
}

function handleDataChannelMessage(msg) {
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
                    log('✅ TCP connected: ' + connId + ' (' + address + ')');
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
                            log('TCP receive error on ' + connId + ': ' + info.resultCode);
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
                        log('TCP send error on ' + dataConnId + ': ' + sendInfo.resultCode);
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
                log('TCP closed by server: ' + closeConnId);
            }
            break;
        default:
            log('Неизвестный тип DataChannel: ' + msg.type);
    }
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
    updateStatus(false);
    for (let [connId, sockId] of pendingConnections.entries()) {
        chrome.sockets.tcp.close(sockId, () => {});
        pendingConnections.delete(connId);
    }
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    log('🛑 Отключено вручную');
}

// Слушаем команды от background
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.target === 'offscreen') {
        switch (msg.type) {
            case 'connect':
                chrome.storage.local.get('serverUrl', (data) => {
                    if (data.serverUrl) startConnection(data.serverUrl);
                    else log('❌ URL сервера не сохранён');
                });
                break;
            case 'disconnect':
                disconnect();
                break;
            case 'getStatus':
                sendResponse({ connected });
                break;
        }
    }
});