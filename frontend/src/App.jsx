import React, { useState, useRef, useEffect } from "react";
import {
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Send,
  Settings,
  Play,
  Pause,
  Square,
  Wifi,
  WifiOff,
} from "lucide-react";
import "./App.css";
const App = () => {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [messages, setMessages] = useState([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioQueue, setAudioQueue] = useState([]);
  const [currentAudio, setCurrentAudio] = useState(null);
  const [volume, setVolume] = useState(0.8);
  const [selectedVoice, setSelectedVoice] = useState(null);
  const [voices, setVoices] = useState([]);
  const [isConnected, setIsConnected] = useState(false);
  const [wsConnection, setWsConnection] = useState(null);
  const [isAIThinking, setIsAIThinking] = useState(false);
  const [currentSpeaker, setCurrentSpeaker] = useState(null);
  const [availableSpeakers, setAvailableSpeakers] = useState([]);
  const [useStreamedAudio, setUseStreamedAudio] = useState(true);

  const recognitionRef = useRef(null);
  const audioContextRef = useRef(null);
  const messagesEndRef = useRef(null);
  const audioQueueRef = useRef([]);
  const isPlayingQueueRef = useRef(false);

  // Initialize Web Speech API and WebSocket
  useEffect(() => {
    initializeSpeechRecognition();
    connectToBackend();
    initializeAudioContext();

    return () => {
      if (wsConnection) {
        wsConnection.close();
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
    };
  }, []);

  // Initialize Audio Context
  const initializeAudioContext = () => {
    try {
      audioContextRef.current = new (window.AudioContext ||
        window.webkitAudioContext)();
    } catch (error) {
      console.error("Failed to initialize AudioContext:", error);
    }
  };

  // Initialize Speech Recognition
  const initializeSpeechRecognition = () => {
    if ("webkitSpeechRecognition" in window || "SpeechRecognition" in window) {
      const SpeechRecognition =
        window.webkitSpeechRecognition || window.SpeechRecognition;
      recognitionRef.current = new SpeechRecognition();

      recognitionRef.current.continuous = true;
      recognitionRef.current.interimResults = true;
      recognitionRef.current.lang = "en-US";

      recognitionRef.current.onresult = (event) => {
        let finalTranscript = "";
        let interimTranscript = "";

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalTranscript += transcript;
          } else {
            interimTranscript += transcript;
          }
        }

        setTranscript(finalTranscript + interimTranscript);
      };

      recognitionRef.current.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current.onerror = (event) => {
        console.error("Speech recognition error:", event.error);
        setIsListening(false);
      };
    }
  };

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // WebSocket connection to backend
  const connectToBackend = () => {
    try {
      const ws = new WebSocket("ws://localhost:8000");

      ws.onopen = () => {
        setIsConnected(true);
        console.log("Connected to backend");
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleWebSocketMessage(data);
      };

      ws.onclose = () => {
        setIsConnected(false);
        console.log("Disconnected from backend");
        // Attempt to reconnect after 3 seconds
        setTimeout(connectToBackend, 3000);
      };

      ws.onerror = (error) => {
        console.error("WebSocket error:", error);
        setIsConnected(false);
      };

      setWsConnection(ws);
    } catch (error) {
      console.error("Failed to connect to backend:", error);
    }
  };

  // Handle WebSocket messages
  const handleWebSocketMessage = (data) => {
    switch (data.type) {
      case "connected":
        console.log("Connected to TTS Assistant");
        if (data.tts_info) {
          setCurrentSpeaker(data.tts_info.speaker);
          setAvailableSpeakers(data.tts_info.available_speakers || []);
        }
        break;

      case "ai_thinking":
        setIsAIThinking(true);
        break;

      case "text_chunk":
        // Add AI text chunk to messages
        setMessages((prev) => {
          const lastMessage = prev[prev.length - 1];
          if (
            lastMessage &&
            lastMessage.type === "ai" &&
            lastMessage.isStreaming
          ) {
            // Update existing streaming message
            return prev.map((msg, index) =>
              index === prev.length - 1
                ? { ...msg, content: msg.content + " " + data.text }
                : msg
            );
          } else {
            // Create new streaming message
            return [
              ...prev,
              {
                id: Date.now() + data.chunk_id,
                type: "ai",
                content: data.text,
                timestamp: new Date().toLocaleTimeString(),
                isStreaming: true,
              },
            ];
          }
        });
        break;

      case "audio_chunk":
        if (useStreamedAudio && data.audio) {
          // Add audio chunk to queue
          addAudioToQueue(data.audio, data.chunk_id, data.text);
        }
        break;

      case "response_complete":
        setIsAIThinking(false);
        // Mark the last message as complete
        setMessages((prev) =>
          prev.map((msg, index) =>
            index === prev.length - 1 && msg.isStreaming
              ? { ...msg, isStreaming: false }
              : msg
          )
        );
        break;

      case "error":
        console.error("Backend error:", data.message);
        addMessage("system", `Error: ${data.message}`);
        setIsAIThinking(false);
        break;

      case "speaker_changed":
        setCurrentSpeaker(data.speaker);
        break;

      case "speakers_list":
        setAvailableSpeakers(data.speakers);
        setCurrentSpeaker(data.current_speaker);
        break;
    }
  };

  // Add audio to queue and play
  const addAudioToQueue = async (audioBase64, chunkId, text) => {
    try {
      // Decode base64 audio
      const audioData = atob(audioBase64);
      const audioBuffer = new Uint8Array(audioData.length);

      for (let i = 0; i < audioData.length; i++) {
        audioBuffer[i] = audioData.charCodeAt(i);
      }

      // Create audio element
      const audioBlob = new Blob([audioBuffer], { type: "audio/wav" });
      const audioUrl = URL.createObjectURL(audioBlob);

      const audioElement = new Audio(audioUrl);
      audioElement.volume = volume;

      // Add to queue
      const audioItem = {
        id: chunkId,
        audio: audioElement,
        text: text,
        url: audioUrl,
      };

      audioQueueRef.current.push(audioItem);

      // Start playing queue if not already playing
      if (!isPlayingQueueRef.current) {
        playAudioQueue();
      }
    } catch (error) {
      console.error("Error processing audio chunk:", error);
    }
  };

  // Play audio queue sequentially
  const playAudioQueue = async () => {
    if (isPlayingQueueRef.current || audioQueueRef.current.length === 0) {
      return;
    }

    isPlayingQueueRef.current = true;
    setIsPlaying(true);

    while (audioQueueRef.current.length > 0) {
      const audioItem = audioQueueRef.current.shift();

      try {
        await playAudioItem(audioItem);
      } catch (error) {
        console.error("Error playing audio item:", error);
      } finally {
        // Clean up URL
        URL.revokeObjectURL(audioItem.url);
      }
    }

    isPlayingQueueRef.current = false;
    setIsPlaying(false);
  };

  // Play individual audio item
  const playAudioItem = (audioItem) => {
    return new Promise((resolve, reject) => {
      const audio = audioItem.audio;

      audio.onended = () => {
        resolve();
      };

      audio.onerror = (error) => {
        console.error("Audio playback error:", error);
        reject(error);
      };

      audio.ontimeupdate = () => {
        // Update current audio reference
        setCurrentAudio({
          ...audioItem,
          currentTime: audio.currentTime,
          duration: audio.duration,
        });
      };

      // Start playback
      audio.play().catch((error) => {
        console.error("Failed to play audio:", error);
        reject(error);
      });
    });
  };

  // Stop current audio playback
  const stopAudio = () => {
    // Clear the audio queue
    audioQueueRef.current.forEach((item) => {
      item.audio.pause();
      URL.revokeObjectURL(item.url);
    });
    audioQueueRef.current = [];

    // Stop current audio
    if (currentAudio && currentAudio.audio) {
      currentAudio.audio.pause();
      currentAudio.audio.currentTime = 0;
    }

    isPlayingQueueRef.current = false;
    setIsPlaying(false);
    setCurrentAudio(null);
  };

  // Speech recognition controls
  const startListening = () => {
    if (recognitionRef.current && !isListening) {
      setTranscript("");
      recognitionRef.current.start();
      setIsListening(true);
    }
  };

  const stopListening = () => {
    if (recognitionRef.current && isListening) {
      recognitionRef.current.stop();
      setIsListening(false);
    }
  };

  // Message handling
  const addMessage = (type, content) => {
    const newMessage = {
      id: Date.now(),
      type,
      content,
      timestamp: new Date().toLocaleTimeString(),
    };
    setMessages((prev) => [...prev, newMessage]);
  };

  const sendMessage = async (text = transcript) => {
    if (!text.trim() || !wsConnection || !isConnected) return;

    addMessage("user", text);
    setTranscript("");

    // Send message to backend
    try {
      wsConnection.send(
        JSON.stringify({
          type: "user_message",
          text: text,
        })
      );
    } catch (error) {
      console.error("Error sending message:", error);
      addMessage("system", "Failed to send message to backend");
    }
  };

  // Change TTS speaker
  const changeSpeaker = (speakerName) => {
    if (wsConnection && isConnected) {
      wsConnection.send(
        JSON.stringify({
          type: "change_speaker",
          speaker: speakerName,
        })
      );
    }
  };

  const clearMessages = () => {
    setMessages([]);
    stopAudio(); // Also stop any playing audio
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-blue-900 to-purple-900">
      <div className="container mx-auto px-4 py-6 h-screen flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-gradient-to-r from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
              <Volume2 className="text-white w-6 h-6" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white">
                AI Voice Assistant
              </h1>
              <p className="text-blue-300 text-sm">
                Streaming TTS from backend •{" "}
                {useStreamedAudio ? "Custom TTS" : "Browser TTS"}
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-4">
            {/* Audio Status */}
            {isPlaying && (
              <div className="flex items-center space-x-2 text-green-400 text-sm">
                <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
                <span>Playing Audio</span>
              </div>
            )}

            {/* Connection Status */}
            <div className="flex items-center space-x-2">
              {isConnected ? (
                <Wifi className="w-4 h-4 text-green-400" />
              ) : (
                <WifiOff className="w-4 h-4 text-red-400" />
              )}
              <span className="text-white text-sm">
                {isConnected ? "Connected" : "Disconnected"}
              </span>
            </div>
          </div>
        </div>

        {/* Settings */}
        <div className="bg-white/10 backdrop-blur-md rounded-xl p-4 mb-6">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center space-x-4">
              <div className="flex items-center space-x-2">
                <Settings className="text-white w-4 h-4" />
                <select
                  value={currentSpeaker || ""}
                  onChange={(e) => changeSpeaker(e.target.value)}
                  disabled={!isConnected || availableSpeakers.length === 0}
                  className="bg-white/20 text-white rounded-lg px-3 py-1 text-sm disabled:opacity-50"
                >
                  <option value="">Default Voice</option>
                  {availableSpeakers.map((speaker) => (
                    <option
                      key={speaker}
                      value={speaker}
                      className="text-black"
                    >
                      {speaker}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center space-x-2">
                <Volume2 className="text-white w-4 h-4" />
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={volume}
                  onChange={(e) => setVolume(parseFloat(e.target.value))}
                  className="w-20"
                />
                <span className="text-white text-sm">
                  {Math.round(volume * 100)}%
                </span>
              </div>
            </div>

            <div className="flex items-center space-x-2">
              <label className="flex items-center space-x-2 text-white text-sm">
                <input
                  type="checkbox"
                  checked={useStreamedAudio}
                  onChange={(e) => setUseStreamedAudio(e.target.checked)}
                  className="rounded"
                />
                <span>Use Streamed Audio</span>
              </label>
            </div>
          </div>
        </div>

        {/* Audio Progress */}
        {currentAudio && isPlaying && (
          <div className="bg-white/10 backdrop-blur-md rounded-xl p-4 mb-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-white text-sm">Now Playing</span>
              <span className="text-blue-300 text-xs">
                {Math.round(currentAudio.currentTime || 0)}s /{" "}
                {Math.round(currentAudio.duration || 0)}s
              </span>
            </div>
            <div className="w-full bg-white/20 rounded-full h-2 mb-2">
              <div
                className="bg-gradient-to-r from-blue-500 to-purple-500 h-2 rounded-full transition-all"
                style={{
                  width: `${
                    ((currentAudio.currentTime || 0) /
                      (currentAudio.duration || 1)) *
                    100
                  }%`,
                }}
              ></div>
            </div>
            <p className="text-white text-sm truncate">{currentAudio.text}</p>
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 bg-white/10 backdrop-blur-md rounded-xl p-6 mb-6 overflow-hidden flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-white font-semibold">Conversation</h2>
            <div className="flex items-center space-x-2">
              {isAIThinking && (
                <div className="flex items-center space-x-2 text-yellow-400 text-sm">
                  <div className="w-2 h-2 bg-yellow-400 rounded-full animate-bounce"></div>
                  <span>AI thinking...</span>
                </div>
              )}
              <button
                onClick={clearMessages}
                className="text-blue-300 hover:text-white text-sm transition-colors"
              >
                Clear
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto space-y-4">
            {messages.length === 0 ? (
              <div className="text-center text-blue-300 py-12">
                <Mic className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>Start by speaking or typing your message</p>
                <p className="text-sm mt-2">
                  Audio will stream from the backend when connected
                </p>
              </div>
            ) : (
              messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex ${
                    message.type === "user" ? "justify-end" : "justify-start"
                  }`}
                >
                  <div
                    className={`max-w-[80%] rounded-2xl p-4 ${
                      message.type === "user"
                        ? "bg-gradient-to-r from-blue-500 to-blue-600 text-white"
                        : message.type === "system"
                        ? "bg-red-500/20 text-red-200 border border-red-400/30"
                        : "bg-white/20 text-white"
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <p className="mb-1 flex-1">{message.content}</p>
                      {message.isStreaming && (
                        <div className="ml-2 w-2 h-2 bg-blue-400 rounded-full animate-pulse"></div>
                      )}
                    </div>
                    <p className="text-xs opacity-70">{message.timestamp}</p>
                  </div>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input Area */}
        <div className="bg-white/10 backdrop-blur-md rounded-xl p-4">
          {/* Speech Recognition Display */}
          {(isListening || transcript) && (
            <div className="mb-4 p-3 bg-blue-500/20 rounded-lg border border-blue-400/30">
              <div className="flex items-center space-x-2 mb-2">
                <div
                  className={`w-2 h-2 rounded-full ${
                    isListening ? "bg-red-500 animate-pulse" : "bg-gray-400"
                  }`}
                ></div>
                <span className="text-white text-sm">
                  {isListening ? "Listening..." : "Speech captured"}
                </span>
              </div>
              <p className="text-white">{transcript || "Say something..."}</p>
            </div>
          )}

          <div className="flex items-center space-x-3">
            {/* Voice Input */}
            <button
              onClick={isListening ? stopListening : startListening}
              className={`p-3 rounded-full transition-all duration-200 ${
                isListening
                  ? "bg-red-500 hover:bg-red-600 animate-pulse"
                  : "bg-blue-500 hover:bg-blue-600"
              }`}
            >
              {isListening ? (
                <MicOff className="text-white w-5 h-5" />
              ) : (
                <Mic className="text-white w-5 h-5" />
              )}
            </button>

            {/* Text Input */}
            <input
              type="text"
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              onKeyPress={(e) => e.key === "Enter" && sendMessage()}
              placeholder="Type your message or use voice input..."
              className="flex-1 bg-white/20 text-white placeholder-blue-200 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-400"
            />

            {/* Send Button */}
            <button
              onClick={() => sendMessage()}
              disabled={!transcript.trim() || !isConnected}
              className="p-3 rounded-full bg-green-500 hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              <Send className="text-white w-5 h-5" />
            </button>

            {/* Audio Control */}
            <button
              onClick={isPlaying ? stopAudio : null}
              disabled={!isPlaying}
              className="p-3 rounded-full bg-purple-500 hover:bg-purple-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {isPlaying ? (
                <Square className="text-white w-5 h-5" />
              ) : (
                <Volume2 className="text-white w-5 h-5" />
              )}
            </button>
          </div>

          {/* Controls Info */}
          <div className="flex justify-center mt-3">
            <div className="flex items-center space-x-4 text-xs text-blue-300">
              <span>🎤 Voice input</span>
              <span>⌨️ Text chat</span>
              <span>🔊 Streamed audio</span>
              <span>🎵 Sequential playback</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;
