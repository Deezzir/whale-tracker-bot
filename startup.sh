#!/bin/bash
set -e

export DISPLAY=:0

echo "Starting Xvfb..."
Xvfb :0 -screen 0 1920x1080x24 &
sleep 1

echo "Starting fluxbox..."
fluxbox &

echo "Starting x11vnc..."
x11vnc -display :0 -forever -nopw -localhost -shared -rfbport 5900 &

echo "Starting noVNC..."
websockify --web=/usr/share/novnc --wrap-mode=ignore 8080 localhost:5900 &

echo "Starting Node app..."
npm run start
