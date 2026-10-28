#!/usr/bin/env python3
# vad_server.py — persistent HTTP server for Silero VAD
# Loads model once at startup, avoids repeated torch/model loading overhead
# Listens on localhost:9988
# POST /vad  {"audio_path": "/root/vad_XXXXX.mp3"} → JSON result

import sys
import json
import os
import subprocess
import wave
import array
import warnings
from http.server import BaseHTTPRequestHandler, HTTPServer

warnings.filterwarnings('ignore')

SKIP_SECONDS = 5
MIN_SPEECH_MS = 400
SAMPLE_RATE = 16000
PORT = 9988

print("Loading torch + Silero VAD model...", flush=True)
import torch
from silero_vad import load_silero_vad, get_speech_timestamps
VAD_MODEL = load_silero_vad()
print(f"VAD model loaded. Listening on port {PORT}", flush=True)


def mp3_to_wav(mp3_path, wav_path):
    result = subprocess.run(
        ['ffmpeg', '-i', mp3_path, '-ar', str(SAMPLE_RATE), '-ac', '1',
         '-f', 'wav', wav_path, '-y', '-loglevel', 'error'],
        capture_output=True
    )
    return result.returncode == 0


def load_wav_tensor(wav_path):
    with wave.open(wav_path, 'rb') as wf:
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        frames = wf.readframes(wf.getnframes())
    if sampwidth != 2:
        raise ValueError(f"Unsupported sample width: {sampwidth}")
    samples = array.array('h', frames)
    tensor = torch.tensor([s / 32768.0 for s in samples], dtype=torch.float32)
    if n_channels == 2:
        tensor = tensor[::2]
    return tensor


def check_vad(audio_path):
    base = os.path.basename(audio_path).replace('/', '_')
    wav_path = os.path.join('/root', base + '_vad.wav')
    try:
        if not mp3_to_wav(audio_path, wav_path):
            return {"error": "ffmpeg conversion failed", "answered": None}

        wav = load_wav_tensor(wav_path)

        timestamps = get_speech_timestamps(
            wav, VAD_MODEL,
            sampling_rate=SAMPLE_RATE,
            min_speech_duration_ms=300,
            min_silence_duration_ms=200,
            threshold=0.5
        )

        skip_samples = SKIP_SECONDS * SAMPLE_RATE
        speech_after_intro = [t for t in timestamps if t['end'] > skip_samples]
        total_speech_ms = sum(
            (min(t['end'], len(wav)) - max(t['start'], skip_samples)) / SAMPLE_RATE * 1000
            for t in speech_after_intro
        )

        answered = total_speech_ms >= MIN_SPEECH_MS
        return {
            "answered": answered,
            "speech_after_intro_ms": round(total_speech_ms),
            "segments_total": len(timestamps),
            "segments_after_skip": len(speech_after_intro)
        }
    except Exception as e:
        return {"error": str(e), "answered": None}
    finally:
        try:
            if os.path.exists(wav_path):
                os.unlink(wav_path)
        except Exception:
            pass


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # silence access logs

    def do_GET(self):
        if self.path == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok"}).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path != '/vad':
            self.send_response(404)
            self.end_headers()
            return
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length))
            audio_path = body.get('audio_path', '')
            if not audio_path or not os.path.exists(audio_path):
                result = {"error": f"File not found: {audio_path}", "answered": None}
            else:
                result = check_vad(audio_path)
        except Exception as e:
            result = {"error": str(e), "answered": None}

        resp = json.dumps(result).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)


if __name__ == '__main__':
    server = HTTPServer(('127.0.0.1', PORT), Handler)
    print(f"VAD server ready on http://127.0.0.1:{PORT}", flush=True)
    server.serve_forever()
