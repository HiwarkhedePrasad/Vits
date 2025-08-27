import asyncio
import websockets
import json
import threading
import queue
import time
import base64
import subprocess
import numpy as np
import sounddevice as sd
from TTS.api import TTS
import wave
import io
from concurrent.futures import ThreadPoolExecutor
import logging

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Compatible TTS models (don't require PyTorch 2.1+)
COMPATIBLE_MODELS = {
    "1": {
        "name": "English Tacotron2 (Fast and reliable)",
        "model": "tts_models/en/ljspeech/tacotron2-DDC",
        "language": "en",
        "has_speakers": False
    },
    "2": {
        "name": "English FastPitch (Good quality)",
        "model": "tts_models/en/ljspeech/fast_pitch",
        "language": "en",
        "has_speakers": False
    },
    "3": {
        "name": "Multi-speaker Tacotron2 (Multiple voices)",
        "model": "tts_models/en/vctk/tacotron2-DDC",
        "language": "en",
        "has_speakers": True
    },
    "4": {
        "name": "Try XTTS v2 (Requires PyTorch 2.1+)",
        "model": "tts_models/multilingual/multi-dataset/xtts_v2",
        "language": "en",
        "has_speakers": True
    }
}

class WebSocketAudioPlayer:
    """Handles threaded audio generation and streaming to WebSocket clients"""
    # FIX 1: Accept the event loop in the constructor
    def __init__(self, tts_engine, websocket, loop, speaker=None, language="en"):
        self.tts_engine = tts_engine
        self.speaker = speaker
        self.language = language
        self.websocket = websocket
        self.loop = loop  # Store the event loop

        # Queues for communication between threads
        self.text_queue = queue.Queue()

        # Threading control
        self.generator_thread = None
        self.stop_event = threading.Event()
        self.is_generating = threading.Event()

        # Thread pool for async operations
        self.executor = ThreadPoolExecutor(max_workers=2)

        # Start the threads
        self.start_threads()

    def start_threads(self):
        """Start the audio generation thread"""
        self.stop_event.clear()

        # Thread for generating audio from text
        self.generator_thread = threading.Thread(target=self._audio_generator_worker, daemon=True)
        self.generator_thread.start()

    def _audio_generator_worker(self):
        """Worker thread that generates audio from text and sends to WebSocket"""
        while not self.stop_event.is_set():
            try:
                # Get text from queue (with timeout to check stop_event)
                text_data = self.text_queue.get(timeout=0.1)

                if text_data is None:  # Poison pill to stop thread
                    break

                text = text_data['text']
                chunk_id = text_data.get('chunk_id', 0)

                logger.info(f"Generating audio for chunk {chunk_id}: {text[:50]}...")

                # Set generating flag
                self.is_generating.set()

                try:
                    # Generate audio
                    if self.speaker:
                        audio = self.tts_engine.tts(text=text, speaker=self.speaker, language=self.language)
                    else:
                        audio = self.tts_engine.tts(text=text)

                    # Ensure audio is numpy array
                    if not isinstance(audio, np.ndarray):
                        audio = np.array(audio)

                    # Get sample rate
                    sample_rate = getattr(self.tts_engine.synthesizer, 'output_sample_rate', 22050)

                    # Convert to WAV format for web streaming
                    audio_bytes = self._numpy_to_wav_bytes(audio, sample_rate)

                    # Encode as base64 for JSON transmission
                    audio_base64 = base64.b64encode(audio_bytes).decode('utf-8')

                    # FIX 3: Use the stored event loop from the main thread
                    asyncio.run_coroutine_threadsafe(
                        self._send_audio_chunk(audio_base64, chunk_id, text),
                        self.loop
                    )

                except Exception as e:
                    logger.error(f"Audio generation error for chunk {chunk_id}: {e}")
                    # FIX 3: Use the stored event loop from the main thread
                    asyncio.run_coroutine_threadsafe(
                        self._send_error(f"Audio generation failed: {str(e)}"),
                        self.loop
                    )
                finally:
                    # Clear generating flag
                    self.is_generating.clear()

            except queue.Empty:
                continue
            except Exception as e:
                logger.error(f"Audio generator worker error: {e}")
                continue

    def _numpy_to_wav_bytes(self, audio, sample_rate):
        """Convert numpy array to WAV bytes"""
        # Normalize audio to int16
        if audio.dtype != np.int16:
            audio = (audio * 32767).astype(np.int16)

        # Create WAV file in memory
        buffer = io.BytesIO()
        with wave.open(buffer, 'wb') as wav_file:
            wav_file.setnchannels(1)  # Mono
            wav_file.setsampwidth(2)  # 16-bit
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(audio.tobytes())

        return buffer.getvalue()

    async def _send_audio_chunk(self, audio_base64, chunk_id, text):
        """Send audio chunk to WebSocket client"""
        try:
            message = {
                'type': 'audio_chunk',
                'audio': audio_base64,
                'chunk_id': chunk_id,
                'text': text,
                'sample_rate': getattr(self.tts_engine.synthesizer, 'output_sample_rate', 22050)
            }
            await self.websocket.send(json.dumps(message))
            logger.info(f"Sent audio chunk {chunk_id}")
        except Exception as e:
            logger.error(f"Failed to send audio chunk: {e}")

    async def _send_error(self, error_message):
        """Send error message to WebSocket client"""
        try:
            message = {
                'type': 'error',
                'message': error_message
            }
            await self.websocket.send(json.dumps(message))
        except Exception as e:
            logger.error(f"Failed to send error message: {e}")

    def add_text(self, text, chunk_id=0):
        """Add text to be converted to speech"""
        if not self.stop_event.is_set():
            self.text_queue.put({'text': text, 'chunk_id': chunk_id})

    def clear_queue(self):
        """Clear all pending audio"""
        while not self.text_queue.empty():
            try:
                self.text_queue.get_nowait()
            except queue.Empty:
                break

    def stop(self):
        """Stop all threads and cleanup"""
        logger.info("Stopping WebSocket audio player...")
        self.stop_event.set()

        # Clear queue
        self.clear_queue()

        # Send poison pill to stop thread
        self.text_queue.put(None)

        # Wait for thread to finish
        if self.generator_thread and self.generator_thread.is_alive():
            self.generator_thread.join(timeout=2)

        # Shutdown executor
        self.executor.shutdown(wait=True)

        logger.info("WebSocket audio player stopped")

class WebSocketTextToAudioAssistant:
    def __init__(self, model_choice="1"):
        self.tts = None
        self.speaker = None
        self.language = None
        self.model_choice = model_choice
        self.connected_clients = set()

        # Initialize TTS
        self._initialize_tts()

    def _initialize_tts(self):
        """Initialize TTS model"""
        model_info = COMPATIBLE_MODELS.get(self.model_choice, COMPATIBLE_MODELS["1"])

        logger.info(f"Loading {model_info['name']}...")
        try:
            self.tts = TTS(model_info["model"])
            self.language = model_info["language"]
            logger.info("TTS Model loaded successfully!")

            # Select default speaker if available
            if hasattr(self.tts, 'speakers') and self.tts.speakers:
                self.speaker = self.tts.speakers[0]
                logger.info(f"Selected default speaker: {self.speaker}")
            else:
                self.speaker = None
                logger.info("Using default voice (no speaker selection available)")

        except Exception as e:
            logger.error(f"Error loading TTS model: {e}")
            # Fallback to basic model
            try:
                logger.info("Falling back to basic English model...")
                self.tts = TTS("tts_models/en/ljspeech/tacotron2-DDC")
                self.language = "en"
                self.speaker = None
                logger.info("Fallback model loaded successfully!")
            except Exception as fallback_error:
                logger.error(f"Fallback also failed: {fallback_error}")
                raise

    def get_ollama_response(self, prompt, model="llama3.2"):
        """Get AI response from Ollama."""
        try:
            process = subprocess.Popen(
                ["ollama", "run", model],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )
            stdout, stderr = process.communicate(prompt)
            if stderr and "error" in stderr.lower():
                logger.warning(f"Ollama warning: {stderr}")
            return stdout.strip() if stdout.strip() else "I couldn't generate a response."
        except FileNotFoundError:
            return "Ollama is not installed or not in PATH. Please install Ollama first."
        except Exception as e:
            return f"Error connecting to AI: {str(e)}"

    async def stream_ollama_response(self, prompt, websocket, model="llama3.2"):
        """Get streaming response from Ollama and send to WebSocket"""
        logger.info("AI is thinking and responding...")

        # FIX 2: Get the running event loop and pass it to the audio player
        loop = asyncio.get_running_loop()
        audio_player = WebSocketAudioPlayer(self.tts, websocket, loop, self.speaker, self.language)

        try:
            # Make the AI more conversational
            enhanced_prompt = f"""You are a helpful, conversational AI assistant. Answer the user's question thoroughly but also try to be engaging and ask a follow-up question when appropriate to keep the conversation going. Be natural and friendly.

User: {prompt}"""

            # Notify client that AI is processing
            await websocket.send(json.dumps({
                'type': 'ai_thinking',
                'message': 'AI is processing your request...'
            }))

            process = subprocess.Popen(
                ["ollama", "run", model],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1
            )

            # Send enhanced prompt
            process.stdin.write(enhanced_prompt + "\n")
            process.stdin.flush()
            process.stdin.close()

            full_response = ""
            current_chunk = ""
            chunk_id = 0

            while True:
                line = process.stdout.readline()
                if not line:
                    break

                line = line.strip()
                if not line:
                    continue

                full_response += line + " "
                current_chunk += line + " "

                # Send text chunk and generate audio when we have a complete sentence
                if any(punct in current_chunk for punct in ['. ', '! ', '? ', '\n']):
                    chunk_text = current_chunk.strip()

                    # Send text response chunk
                    await websocket.send(json.dumps({
                        'type': 'text_chunk',
                        'text': chunk_text,
                        'chunk_id': chunk_id
                    }))

                    logger.info(f"AI chunk {chunk_id}: {chunk_text}")

                    # Add to audio generation queue
                    audio_player.add_text(chunk_text, chunk_id)

                    current_chunk = ""
                    chunk_id += 1

            # Handle any remaining text
            if current_chunk.strip():
                chunk_text = current_chunk.strip()

                # Send final text chunk
                await websocket.send(json.dumps({
                    'type': 'text_chunk',
                    'text': chunk_text,
                    'chunk_id': chunk_id
                }))

                logger.info(f"AI final chunk {chunk_id}: {chunk_text}")
                audio_player.add_text(chunk_text, chunk_id)

            # Send completion message
            await websocket.send(json.dumps({
                'type': 'response_complete',
                'full_text': full_response.strip()
            }))

            # Wait a bit for audio generation to complete
            await asyncio.sleep(1)

            return full_response.strip()

        except Exception as e:
            error_msg = f"Error with streaming: {str(e)}"
            logger.error(error_msg)

            await websocket.send(json.dumps({
                'type': 'error',
                'message': error_msg
            }))
            return error_msg
        finally:
            # Clean up audio player
            audio_player.stop()

    async def handle_client(self, websocket):
        """Handle WebSocket client connection"""
        client_id = id(websocket)
        self.connected_clients.add(websocket)
        logger.info(f"Client {client_id} connected. Total clients: {len(self.connected_clients)}")

        try:
            # Send welcome message with TTS info
            welcome_message = {
                'type': 'connected',
                'message': 'Connected to TTS Assistant',
                'tts_info': {
                    'model': self.model_choice,
                    'language': self.language,
                    'speaker': self.speaker,
                    'available_speakers': getattr(self.tts, 'speakers', []) if hasattr(self.tts, 'speakers') else []
                }
            }
            await websocket.send(json.dumps(welcome_message))

            # Handle messages from client
            async for message in websocket:
                try:
                    data = json.loads(message)
                    await self.process_message(data, websocket)
                except json.JSONDecodeError as e:
                    logger.error(f"Invalid JSON from client {client_id}: {e}")
                    await websocket.send(json.dumps({
                        'type': 'error',
                        'message': 'Invalid JSON format'
                    }))
                except Exception as e:
                    logger.error(f"Error processing message from client {client_id}: {e}")
                    await websocket.send(json.dumps({
                        'type': 'error',
                        'message': f'Server error: {str(e)}'
                    }))

        except websockets.exceptions.ConnectionClosed:
            logger.info(f"Client {client_id} disconnected")
        except Exception as e:
            logger.error(f"Error handling client {client_id}: {e}")
        finally:
            self.connected_clients.discard(websocket)
            logger.info(f"Client {client_id} removed. Total clients: {len(self.connected_clients)}")

    async def process_message(self, data, websocket):
        """Process incoming message from WebSocket client"""
        message_type = data.get('type', '')

        if message_type == 'user_message':
            user_text = data.get('text', '').strip()
            if user_text:
                logger.info(f"User message: {user_text}")

                # Send acknowledgment
                await websocket.send(json.dumps({
                    'type': 'message_received',
                    'original_text': user_text
                }))

                # Get AI response and stream it
                await self.stream_ollama_response(user_text, websocket)

        elif message_type == 'change_speaker':
            speaker_name = data.get('speaker', '')
            if hasattr(self.tts, 'speakers') and speaker_name in self.tts.speakers:
                self.speaker = speaker_name
                await websocket.send(json.dumps({
                    'type': 'speaker_changed',
                    'speaker': self.speaker
                }))
                logger.info(f"Speaker changed to: {self.speaker}")
            else:
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': f'Speaker "{speaker_name}" not available'
                }))

        elif message_type == 'get_speakers':
            speakers = getattr(self.tts, 'speakers', []) if hasattr(self.tts, 'speakers') else []
            await websocket.send(json.dumps({
                'type': 'speakers_list',
                'speakers': speakers,
                'current_speaker': self.speaker
            }))

        elif message_type == 'ping':
            await websocket.send(json.dumps({
                'type': 'pong',
                'timestamp': data.get('timestamp', '')
            }))

        else:
            await websocket.send(json.dumps({
                'type': 'error',
                'message': f'Unknown message type: {message_type}'
            }))

    async def start_server(self, host="localhost", port=8765):
        """Start the WebSocket server"""
        logger.info(f"Starting WebSocket TTS Assistant server on {host}:{port}")
        logger.info(f"TTS Model: {COMPATIBLE_MODELS[self.model_choice]['name']}")
        logger.info(f"Speaker: {self.speaker or 'Default'}")

        # Check if port is already in use
        try:
            import socket
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                if s.connect_ex((host, port)) == 0:
                     logger.error(f"Port {port} is already in use")
                     return
        except Exception as e:
            logger.warning(f"Could not check port status: {e}")


        try:
            async with websockets.serve(self.handle_client, host, port):
                logger.info("WebSocket server started successfully!")
                logger.info(f"Connect your frontend to: ws://{host}:{port}")
                await asyncio.Future()  # Run forever

        except Exception as e:
            logger.error(f"Failed to start server: {e}")
            raise

def main():
    """Main function to start the WebSocket server"""
    print("WebSocket Text-to-Audio AI Assistant")
    print("=" * 50)

    # Let user select TTS model
    print("Available TTS models:")
    for key, model_info in COMPATIBLE_MODELS.items():
        print(f"{key}. {model_info['name']}")

    choice = input("\nSelect model (1-4, Enter for default 1): ").strip() or "1"

    try:
        # Create assistant instance
        assistant = WebSocketTextToAudioAssistant(model_choice=choice)

        # Start server
        host = input("Host (Enter for localhost): ").strip() or "localhost"
        port_str = input("Port (Enter for 8765): ").strip() or "8765"

        try:
            port = int(port_str)
        except ValueError:
            print("Invalid port number, using default 8765.")
            port = 8765

        print(f"\nStarting server...")
        print(f"Frontend should connect to: ws://{host}:{port}")
        print("Press Ctrl+C to stop the server")
        print("=" * 50)

        # Run the server
        asyncio.run(assistant.start_server(host, port))

    except KeyboardInterrupt:
        print("\nServer stopped by user")
    except Exception as e:
        print(f"Fatal error: {e}")
        print("Please check your dependencies and try again.")

if __name__ == "__main__":
    main()