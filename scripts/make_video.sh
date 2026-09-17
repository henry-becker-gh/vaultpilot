#!/usr/bin/env bash
# Assemble the VaultPilot pitch video from slides + edge-tts narration.
# Output: dist/vaultpilot-pitch.mp4 (1280x720, H.264+AAC, target < 50 MB)
set -e
cd "$(dirname "$0")/.."
mkdir -p dist assets/video

echo "== per-slide segments =="
: > assets/video/list.txt
for i in 1 2 3 4 5 6 7; do
  A=$(ffprobe -v error -show_entries format=duration -of csv=p=0 assets/audio/n$i.mp3)
  T=$(python3 -c "print(f'{$A + 0.8:.3f}')")
  FO=$(python3 -c "print(f'{$A + 0.8 - 0.35:.3f}')")
  ffmpeg -y -loglevel error -loop 1 -i assets/slide$i.png -i assets/audio/n$i.mp3 \
    -filter_complex "[0:v]scale=1280:720,fade=t=in:st=0:d=0.35,fade=t=out:st=${FO}:d=0.3[v]" \
    -map "[v]" -map 1:a -c:v libx264 -preset medium -tune stillimage -crf 23 \
    -c:a aac -b:a 160k -pix_fmt yuv420p -t "$T" "assets/video/seg$i.mp4"
  echo "seg$i: ${T}s"
  echo "file 'seg$i.mp4'" >> assets/video/list.txt
done

echo "== concat =="
ffmpeg -y -loglevel error -f concat -safe 0 -i assets/video/list.txt -c copy dist/vaultpilot-pitch.mp4
echo "== result =="
ffprobe -v error -show_entries format=duration,size -of default=noprint_wrappers=1 dist/vaultpilot-pitch.mp4
ls -la dist/
