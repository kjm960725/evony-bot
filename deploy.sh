#!/bin/bash
# Evony Bot 배포 스크립트

set -e  # 에러 발생 시 즉시 중단

echo "🔨 Building..."
npm run build

echo "📦 Creating archive (excluding DB files)..."
tar -czf /tmp/evony-bot.tar.gz \
  --exclude='node_modules' \
  --exclude='chrome' \
  --exclude='chrome-user-data' \
  --exclude='.git' \
  --exclude='*.log' \
  --exclude='.env' \
  --exclude='*.db' \
  --exclude='*.db-journal' \
  --exclude='*.png' \
  --exclude='*.html' \
  .

echo "🚀 Uploading to server..."
scp /tmp/evony-bot.tar.gz evony-bot:~/

echo "📥 Extracting and updating on server..."
ssh evony-bot "cd ~/evony-bot && tar -xzf ~/evony-bot.tar.gz && npx prisma migrate deploy && pm2 restart evony-bot"

echo "✅ Deployment completed!"
echo "📊 Check status: ssh evony-bot 'pm2 logs evony-bot --lines 30 --nostream'"

