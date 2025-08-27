import React, { useState, useRef, useEffect } from "react";
import {
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Volume2,
  VolumeX,
  Settings,
  User,
  Bot,
} from "lucide-react";
import "./App.css";

const App = () => {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [messages, setMessages] = useState([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [isConnected, setIsConnected] = useState(false);
  const [wsConnection, setWsConnection] = useState(null);
  const [isAIThinking, setIsAIThinking] = useState(false);
  const [currentSpeaker, setCurrentSpeaker] = useState(null);
  const [availableSpeakers, setAvailableSpeakers] = useState([]);
  const [showSettings, setShowSettings] = useState(false);
  const [callDuration, setCallDuration] = useState(0);

  const recognitionRef = useRef(null);
  const audioContextRef = useRef(null);
  const messagesEndRef = useRef(null);
  const audioQueueRef = useRef([]);
  const isPlayingQueueRef = useRef(false);
  const callStartTimeRef = useRef(null);

  // Call duration timer
  useEffect(() => {
    let interval;
    if (isConnected && callStartTimeRef.current) {
      interval = setInterval(() => {
        const elapsed = Math.floor(
          (Date.now() - callStartTimeRef.current) / 1000
        );
        setCallDuration(elapsed);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isConnected]);

  // Format call duration
  const formatDuration = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  };

  // Initialize Web Speech API and WebSocket
  useEffect(() => {
    initializeSpeechRecognition();
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

        // Auto-send when user stops speaking
        if (finalTranscript && !interimTranscript) {
          setTimeout(() => {
            if (finalTranscript.trim()) {
              sendMessage(finalTranscript);
            }
          }, 1000);
        }
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

  // WebSocket connection to backend
  const connectToBackend = () => {
    try {
      const ws = new WebSocket("ws://localhost:8000");

      ws.onopen = () => {
        setIsConnected(true);
        callStartTimeRef.current = Date.now();
        console.log("Connected to backend");
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleWebSocketMessage(data);
      };

      ws.onclose = () => {
        setIsConnected(false);
        callStartTimeRef.current = null;
        setCallDuration(0);
        console.log("Disconnected from backend");
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
        setMessages((prev) => {
          const lastMessage = prev[prev.length - 1];
          if (
            lastMessage &&
            lastMessage.type === "ai" &&
            lastMessage.isStreaming
          ) {
            return prev.map((msg, index) =>
              index === prev.length - 1
                ? { ...msg, content: msg.content + " " + data.text }
                : msg
            );
          } else {
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
        if (data.audio) {
          addAudioToQueue(data.audio, data.chunk_id, data.text);
        }
        break;

      case "response_complete":
        setIsAIThinking(false);
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
      const audioData = atob(audioBase64);
      const audioBuffer = new Uint8Array(audioData.length);

      for (let i = 0; i < audioData.length; i++) {
        audioBuffer[i] = audioData.charCodeAt(i);
      }

      const audioBlob = new Blob([audioBuffer], { type: "audio/wav" });
      const audioUrl = URL.createObjectURL(audioBlob);

      const audioElement = new Audio(audioUrl);
      audioElement.volume = volume;

      const audioItem = {
        id: chunkId,
        audio: audioElement,
        text: text,
        url: audioUrl,
      };

      audioQueueRef.current.push(audioItem);

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

      audio.play().catch((error) => {
        console.error("Failed to play audio:", error);
        reject(error);
      });
    });
  };

  // Speech recognition controls
  const startListening = () => {
    if (recognitionRef.current && !isListening && isConnected) {
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

    try {
      wsConnection.send(
        JSON.stringify({
          type: "user_message",
          text: text,
        })
      );
    } catch (error) {
      console.error("Error sending message:", error);
    }
  };

  // Connect/Disconnect call
  const toggleConnection = () => {
    if (isConnected && wsConnection) {
      wsConnection.close();
      setIsConnected(false);
      setMessages([]);
      callStartTimeRef.current = null;
      setCallDuration(0);
    } else {
      connectToBackend();
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

  return (
    <div className="min-h-screen bg-black text-white flex flex-col">
      {/* Header - Call Status */}
      <div className="bg-gray-900 px-6 py-4 border-b border-gray-700">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <div className="w-12 h-12 bg-blue-600 rounded-full flex items-center justify-center">
              <Bot className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-lg font-semibold">AI Assistant</h1>
              <p className="text-sm text-gray-400">
                {isConnected ? "Connected" : "Disconnected"}
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-4">
            {isConnected && (
              <div className="text-sm text-gray-400">
                {formatDuration(callDuration)}
              </div>
            )}

            <button
              onClick={() => setShowSettings(!showSettings)}
              className="p-2 rounded-full hover:bg-gray-700 transition-colors"
            >
              <Settings className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Settings Panel */}
        {showSettings && (
          <div className="mt-4 p-4 bg-gray-800 rounded-lg">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-medium">Settings</h3>
              <button
                onClick={() => setShowSettings(false)}
                className="text-gray-400 hover:text-white"
              >
                ×
              </button>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-400 mb-2">
                  Voice
                </label>
                <select
                  value={currentSpeaker || ""}
                  onChange={(e) => changeSpeaker(e.target.value)}
                  disabled={!isConnected || availableSpeakers.length === 0}
                  className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm"
                >
                  <option value="">Default</option>
                  {availableSpeakers.map((speaker) => (
                    <option key={speaker} value={speaker}>
                      {speaker}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-2">
                  Volume: {Math.round(volume * 100)}%
                </label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={volume}
                  onChange={(e) => setVolume(parseFloat(e.target.value))}
                  className="w-full"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Main Call Interface */}
      <div className="flex-1 flex flex-col justify-center items-center p-8">
        {!isConnected ? (
          // Connection Screen
          <div className="text-center space-y-8">
            <div className="w-32 h-32 bg-gray-800 rounded-full flex items-center justify-center mx-auto">
              <Bot className="w-16 h-16 text-gray-400" />
            </div>

            <div>
              <h2 className="text-2xl font-semibold mb-2">
                AI Voice Assistant
              </h2>
              <p className="text-gray-400">Tap to start a conversation</p>
            </div>

            <button
              onClick={toggleConnection}
              className="w-20 h-20 bg-green-600 hover:bg-green-700 rounded-full flex items-center justify-center transition-colors"
            >
              <Phone className="w-8 h-8" />
            </button>
          </div>
        ) : (
          // Active Call Screen
          <div className="w-full max-w-md mx-auto text-center space-y-8">
            {/* Avatar */}
            <div
              className={`w-32 h-32 rounded-full flex items-center justify-center mx-auto transition-all ${
                isPlaying
                  ? "bg-blue-600 animate-pulse"
                  : isAIThinking
                  ? "bg-yellow-600 animate-pulse"
                  : "bg-gray-700"
              }`}
            >
              <Bot className="w-16 h-16" />
            </div>

            {/* Status */}
            <div className="space-y-2">
              <div className="text-lg font-semibold">
                {isAIThinking
                  ? "AI is thinking..."
                  : isPlaying
                  ? "AI is speaking..."
                  : isListening
                  ? "Listening..."
                  : "Ready to chat"}
              </div>

              <div className="text-sm text-gray-400">
                Call duration: {formatDuration(callDuration)}
              </div>
            </div>

            {/* Current Transcript */}
            {transcript && (
              <div className="bg-gray-800 rounded-lg p-4 mx-4">
                <div className="text-sm text-gray-400 mb-2">You said:</div>
                <div className="text-white">{transcript}</div>
              </div>
            )}

            {/* Recent Messages */}
            <div className="space-y-3 max-h-40 overflow-y-auto">
              {messages.slice(-2).map((message) => (
                <div
                  key={message.id}
                  className={`px-4 py-2 rounded-lg mx-4 text-sm ${
                    message.type === "user"
                      ? "bg-blue-600 text-right"
                      : "bg-gray-700 text-left"
                  }`}
                >
                  <div className="flex items-center space-x-2 mb-1">
                    {message.type === "user" ? (
                      <User className="w-4 h-4 ml-auto" />
                    ) : (
                      <Bot className="w-4 h-4" />
                    )}
                    <span className="text-xs text-gray-300">
                      {message.timestamp}
                    </span>
                  </div>
                  <div>{message.content}</div>
                  {message.isStreaming && (
                    <div className="w-2 h-2 bg-blue-400 rounded-full animate-pulse mt-1"></div>
                  )}
                </div>
              ))}
            </div>

            {/* Call Controls */}
            <div className="flex items-center justify-center space-x-8 mt-8">
              {/* Mute/Unmute */}
              <button
                onClick={isListening ? stopListening : startListening}
                disabled={isAIThinking}
                className={`w-16 h-16 rounded-full flex items-center justify-center transition-colors ${
                  isListening
                    ? "bg-red-600 hover:bg-red-700"
                    : "bg-gray-700 hover:bg-gray-600"
                } disabled:opacity-50`}
              >
                {isListening ? (
                  <MicOff className="w-6 h-6" />
                ) : (
                  <Mic className="w-6 h-6" />
                )}
              </button>

              {/* End Call */}
              <button
                onClick={toggleConnection}
                className="w-20 h-20 bg-red-600 hover:bg-red-700 rounded-full flex items-center justify-center transition-colors"
              >
                <PhoneOff className="w-8 h-8" />
              </button>

              {/* Volume */}
              <button className="w-16 h-16 bg-gray-700 hover:bg-gray-600 rounded-full flex items-center justify-center transition-colors">
                {volume > 0 ? (
                  <Volume2 className="w-6 h-6" />
                ) : (
                  <VolumeX className="w-6 h-6" />
                )}
              </button>
            </div>

            {/* Hint Text */}
            <div className="text-xs text-gray-500 mt-4">
              {isListening ? "Speak now..." : "Tap microphone to speak"}
            </div>
          </div>
        )}
      </div>

      {/* Connection Status Indicator */}
      <div
        className={`absolute top-4 right-4 w-3 h-3 rounded-full ${
          isConnected ? "bg-green-500" : "bg-red-500"
        }`}
      ></div>
    </div>
  );
};

export default App;
