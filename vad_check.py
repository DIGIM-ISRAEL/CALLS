#!/usr/bin/env python3
# vad_check.py — בדיקת VAD מקומית עם Silero
# Usage: python3 vad_check.py <audio_file_path>
# Output: JSON עם answered: true/false
# Note: משתמש ב-ffmpeg ישירות (ללא torchaudio) כדי לתמוך בשרתי CPU

import sys, json, os, subprocess, wave, array

SKIP_SECONDS = 5
MIN_SPEECH_MS = 400
SAMPLE_RATE = 16000

def mp3_to_wav(mp3_path, wav_path):
    result = subprocess.run(
        ['ffmpeg', '-i', mp3_path, '-ar', str(SAMPLE_RATE), '-ac', '1',
         '-f', 'wav', wav_path, '-y', '-loglevel', 'error'],
        capture_output=True
    )
    return result.returncode == 0

def load_wav_tensor(wav_path):
    import torch
    with wave.open(wav_path, 'rb') as wf:
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        frames = wf.readframes(wf.getnframes())
    if sampwidth != 2:
        raise ValueError(f"Unsupported sample width: {sampwidth}")
    samples = array.array('h', frames)
    tensor = torch.tensor([s / 32768.0 for s in samples], dtype=torch.float32)
    if n_channels == 2:
        tensor = tensor[::2]  # mono: left channel
    return tensor

def check_vad(audio_path):
    # snap ffmpeg cannot access /tmp — use same dir as input or /root
    base = os.path.basename(audio_path).replace('/', '_')
    wav_path = os.path.join('/root', base + '_vad.wav')
    try:
        import torch
        from silero_vad import load_silero_vad, get_speech_timestamps

        if not mp3_to_wav(audio_path, wav_path):
            return {"error": "ffmpeg conversion failed", "answered": None}

        wav = load_wav_tensor(wav_path)

        model = load_silero_vad()
        timestamps = get_speech_timestamps(
            wav, model,
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
    except ImportError as e:
        return {"error": f"Missing dependency: {e}", "answered": None}
    except Exception as e:
        return {"error": str(e), "answered": None}
    finally:
        try:
            if os.path.exists(wav_path):
                os.unlink(wav_path)
        except Exception:
            pass

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python3 vad_check.py <audio_file>"}))
        sys.exit(1)
    path = sys.argv[1]
    if not os.path.exists(path):
        print(json.dumps({"error": f"File not found: {path}"}))
        sys.exit(1)
    result = check_vad(path)
    print(json.dumps(result), flush=True)
    sys.exit(0 if result.get("answered") is not None else 1)
