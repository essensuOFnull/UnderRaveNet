package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/armon/go-socks5"
	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v3"
)

const (
	socks5Port = 1080
	httpPort   = 8080
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Helper представляет подключённого помощника (расширение друга)
type Helper struct {
	pc          *webrtc.PeerConnection
	dataChannel *webrtc.DataChannel
	mu          sync.Mutex
	pendingReqs map[string]chan *proxyResponse // для HTTP-запросов (если понадобятся)
	pendingTCP  map[string]net.Conn            // для TCP-соединений
	pendingMu   sync.RWMutex
}

type proxyResponse struct {
	Status int
	Body   []byte
}

var (
	currentHelper *Helper
	helperMu      sync.RWMutex
)

func main() {
	// Запускаем SOCKS5 сервер в горутине
	go startSocks5()

	// HTTP сервер для статики и сигналинга
	http.HandleFunc("/", serveHome)
	http.HandleFunc("/signal", handleSignal)

	log.Printf("Сервер запущен на порту %d (HTTP) и SOCKS5 на порту %d", httpPort, socks5Port)
	log.Fatal(http.ListenAndServe(fmt.Sprintf(":%d", httpPort), nil))
}

// serveHome отдаёт простую HTML-страницу (можно сделать информационную)
func serveHome(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprint(w, `<h1>WebRTC Tunnel Server</h1><p>Сервер работает. Используйте расширение для подключения.</p>`)
}

// handleSignal обрабатывает WebSocket-сигналинг для WebRTC
func handleSignal(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Failed to upgrade: %v", err)
		return
	}
	defer conn.Close()

	// Создаём PeerConnection
	peerConnection, err := webrtc.NewPeerConnection(webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{URLs: []string{"stun:stun.l.google.com:19302"}},
		},
	})
	if err != nil {
		log.Printf("Failed to create peer connection: %v", err)
		return
	}
	defer peerConnection.Close()

	// Создаём DataChannel (сервер инициирует)
	dataChannel, err := peerConnection.CreateDataChannel("tunnel", nil)
	if err != nil {
		log.Printf("Failed to create data channel: %v", err)
		return
	}

	// Обработчик открытия канала
	dataChannel.OnOpen(func() {
		log.Println("DataChannel opened")

		helperMu.Lock()
		currentHelper = &Helper{
			pc:          peerConnection,
			dataChannel: dataChannel,
			pendingReqs: make(map[string]chan *proxyResponse),
			pendingTCP:  make(map[string]net.Conn),
		}
		helperMu.Unlock()
	})

	// Обработчик входящих сообщений (от расширения)
	dataChannel.OnMessage(func(msg webrtc.DataChannelMessage) {
		helperMu.RLock()
		h := currentHelper
		helperMu.RUnlock()
		if h == nil {
			return
		}

		var baseMsg map[string]interface{}
		if err := json.Unmarshal(msg.Data, &baseMsg); err != nil {
			log.Printf("Failed to parse message: %v", err)
			return
		}

		msgType, _ := baseMsg["type"].(string)
		switch msgType {
		case "tcp_connected":
			// Подтверждение TCP-соединения (можно игнорировать)
			connID, _ := baseMsg["connId"].(string)
			log.Printf("TCP connected: %s", connID)

		case "tcp_data":
			connID, _ := baseMsg["connId"].(string)
			dataB64, _ := baseMsg["data"].(string)
			if connID == "" || dataB64 == "" {
				return
			}
			data, err := base64.StdEncoding.DecodeString(dataB64)
			if err != nil {
				log.Printf("Failed to decode tcp data: %v", err)
				return
			}

			h.pendingMu.RLock()
			remoteConn, ok := h.pendingTCP[connID]
			h.pendingMu.RUnlock()
			if ok {
				_, err := remoteConn.Write(data)
				if err != nil {
					log.Printf("Write to local connection failed: %v", err)
				}
			}

		case "tcp_close":
			connID, _ := baseMsg["connId"].(string)
			h.pendingMu.Lock()
			if remoteConn, ok := h.pendingTCP[connID]; ok {
				remoteConn.Close()
				delete(h.pendingTCP, connID)
			}
			h.pendingMu.Unlock()
			log.Printf("TCP closed: %s", connID)

		case "tcp_error":
			connID, _ := baseMsg["connId"].(string)
			errMsg, _ := baseMsg["error"].(string)
			log.Printf("TCP error on %s: %s", connID, errMsg)
			h.pendingMu.Lock()
			if remoteConn, ok := h.pendingTCP[connID]; ok {
				remoteConn.Close()
				delete(h.pendingTCP, connID)
			}
			h.pendingMu.Unlock()

		default:
			log.Printf("Unknown message type: %s", msgType)
		}
	})

	// Обработка ICE-кандидатов
	peerConnection.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		conn.WriteJSON(map[string]interface{}{
			"type":      "candidate",
			"candidate": c.ToJSON(),
		})
	})

	// Канал для сигналинга
	signal := make(chan map[string]interface{})
	go func() {
		for {
			var msg map[string]interface{}
			if err := conn.ReadJSON(&msg); err != nil {
				log.Printf("WebSocket read error: %v", err)
				close(signal)
				return
			}
			signal <- msg
		}
	}()

	// Ожидаем offer от браузера
	offerMsg := <-signal
	if offerMsg["type"] != "offer" {
		log.Println("Expected offer")
		return
	}
	offer := webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  offerMsg["sdp"].(string),
	}
	if err := peerConnection.SetRemoteDescription(offer); err != nil {
		log.Printf("Failed to set remote description: %v", err)
		return
	}

	// Создаём answer
	answer, err := peerConnection.CreateAnswer(nil)
	if err != nil {
		log.Printf("Failed to create answer: %v", err)
		return
	}
	if err := peerConnection.SetLocalDescription(answer); err != nil {
		log.Printf("Failed to set local description: %v", err)
		return
	}

	// Отправляем answer браузеру
	conn.WriteJSON(map[string]interface{}{
		"type": "answer",
		"sdp":  answer.SDP,
	})

	// Обрабатываем дальнейшие ICE-кандидаты
	for msg := range signal {
		switch msg["type"] {
		case "candidate":
			candidate := webrtc.ICECandidateInit{}
			if cand, ok := msg["candidate"].(map[string]interface{}); ok {
				if c, ok := cand["candidate"].(string); ok {
					candidate.Candidate = c
				}
				if sdpMid, ok := cand["sdpMid"].(string); ok {
					candidate.SDPMid = &sdpMid
				}
				if sdpMLineIndex, ok := cand["sdpMLineIndex"].(float64); ok {
					idx := uint16(sdpMLineIndex)
					candidate.SDPMLineIndex = &idx
				}
			}
			peerConnection.AddICECandidate(candidate)
		}
	}
}

// startSocks5 запускает SOCKS5-сервер
func startSocks5() {
	conf := &socks5.Config{
		Dial: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return dialViaHelper(addr)
		},
	}
	server, err := socks5.New(conf)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("SOCKS5 server listening on :%d", socks5Port)
	if err := server.ListenAndServe("tcp", fmt.Sprintf(":%d", socks5Port)); err != nil {
		log.Fatal(err)
	}
}

// generateID создаёт уникальный идентификатор
func generateID() string {
	return fmt.Sprintf("%d", time.Now().UnixNano())
}

// dialViaHelper создаёт соединение через расширение друга
func dialViaHelper(addr string) (net.Conn, error) {
	helperMu.RLock()
	h := currentHelper
	helperMu.RUnlock()
	if h == nil {
		return nil, fmt.Errorf("no helper connected")
	}

	connID := generateID()

	// Создаём pipe для связи локального соединения с каналом
	localConn, remoteConn := net.Pipe()

	// Сохраняем remoteConn в pendingTCP
	h.pendingMu.Lock()
	h.pendingTCP[connID] = remoteConn
	h.pendingMu.Unlock()

	// Отправляем команду на TCP-соединение помощнику
	cmd := map[string]interface{}{
		"type":    "tcp_connect",
		"connId":  connID,
		"address": addr,
	}
	cmdData, err := json.Marshal(cmd)
	if err != nil {
		h.pendingMu.Lock()
		delete(h.pendingTCP, connID)
		h.pendingMu.Unlock()
		localConn.Close()
		remoteConn.Close()
		return nil, err
	}

	if err := h.dataChannel.Send(cmdData); err != nil {
		h.pendingMu.Lock()
		delete(h.pendingTCP, connID)
		h.pendingMu.Unlock()
		localConn.Close()
		remoteConn.Close()
		return nil, err
	}

	// Запускаем горутину для передачи данных из localConn в dataChannel
	go func() {
		buf := make([]byte, 8192)
		for {
			n, err := localConn.Read(buf)
			if err != nil {
				// Соединение закрыто локально – отправляем команду закрытия
				closeCmd := map[string]interface{}{
					"type":   "tcp_close",
					"connId": connID,
				}
				closeData, _ := json.Marshal(closeCmd)
				h.dataChannel.Send(closeData)
				return
			}
			// Отправляем данные помощнику
			dataMsg := map[string]interface{}{
				"type":   "tcp_data",
				"connId": connID,
				"data":   base64.StdEncoding.EncodeToString(buf[:n]),
			}
			msgData, _ := json.Marshal(dataMsg)
			h.dataChannel.Send(msgData)
		}
	}()

	return localConn, nil
}
