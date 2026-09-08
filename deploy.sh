#!/bin/bash
# Deploy-Skript: Zieht den aktuellen Stand von GitHub und startet die App neu
set -e

echo "🔄 Pulling latest changes from GitHub..."
git pull origin main

echo "📦 Installing dependencies (if changed)..."
npm install --omit=dev

echo "🔁 Restarting app..."
pm2 restart auslagen-v2

echo "✅ Deploy abgeschlossen!"
pm2 status auslagen-v2
