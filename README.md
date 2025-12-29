# ⚔️ Evony Discord Bot

Evony 게임의 야만인, 아레스, 피라미드 좌표를 공유하는 디스코드 봇입니다.

## 📋 기능

- ✅ 야만인 좌표 조회
- ✅ 아레스 좌표 조회
- ✅ 피라미드 좌표 조회 (레벨 필터링 지원)
- ✅ iScout.club 자동 웹 크롤링 (Puppeteer)
- ✅ 사용자 좌표 저장 및 거리 기반 정렬
- ✅ DM 알림 시스템 (레벨/거리 필터)
- ✅ 자동 크롤링 스케줄러 (5분 순환)
- ✅ 서버 로그 조회 (페이징/필터링)
- ✅ 명령어 별칭 지원
- ✅ Prisma 데이터베이스 연동
- ✅ 핫 리로드 개발 환경
- ✅ 에러 핸들링

## 🚀 설치

### 1. 의존성 설치

```bash
npm install
```

### 2. 환경 변수 설정

`.env` 파일을 생성하고 필요한 정보를 입력하세요:

```bash
cp env.example .env
```

`.env` 파일을 열고 다음 정보를 입력하세요:

```env
# Discord 봇 토큰
DISCORD_TOKEN=your_discord_bot_token_here

# iScout.club 계정 정보
ISCOUT_URL=https://www.iscout.club/en
ISCOUT_EMAIL=your_email@example.com
ISCOUT_PASSWORD=your_password

# 데이터베이스 (SQLite)
DATABASE_URL="file:./dev.db"

# Puppeteer Chrome 경로 (선택사항, 자동 감지됨)
# PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
```

### 3. Discord 봇 생성 방법

1. [Discord Developer Portal](https://discord.com/developers/applications)로 이동
2. "New Application" 클릭
3. 애플리케이션 이름 입력 후 생성
4. 왼쪽 메뉴에서 "Bot" 선택
5. "Reset Token"을 클릭하여 토큰 생성
6. 생성된 토큰을 `.env` 파일의 `DISCORD_TOKEN`에 입력

### 4. 봇 권한 설정

1. Developer Portal의 "Bot" 메뉴에서:

   - **Privileged Gateway Intents** 섹션에서 다음을 활성화:
     - ✅ SERVER MEMBERS INTENT
     - ✅ MESSAGE CONTENT INTENT

2. "OAuth2" → "URL Generator" 메뉴에서:

   - **SCOPES**: `bot` 선택
   - **BOT PERMISSIONS**:
     - ✅ Send Messages
     - ✅ Send Messages in Threads
     - ✅ Embed Links
     - ✅ Read Message History
     - ✅ Use Slash Commands

3. 생성된 URL로 서버에 봇 초대

### 5. 데이터베이스 초기화

Prisma를 사용하여 데이터베이스를 초기화하세요:

```bash
# Prisma 클라이언트 생성
npx prisma generate

# 데이터베이스 스키마 적용
npx prisma db push
```

## 💻 실행 방법

### 개발 모드 (TypeScript 직접 실행)

```bash
npm run dev
```

### 🐛 디버그 모드 (VS Code)

**F5**를 눌러서:

- ✅ TypeScript Watch 모드 자동 시작
- ✅ 디버거 자동 연결
- ✅ 중단점 설정
- ✅ 코드 변경 시 자동 재컴파일

또는 VS Code에서:

1. 왼쪽 사이드바의 "Run and Debug" 클릭 (Ctrl+Shift+D / Cmd+Shift+D)
2. "🔥 Discord Bot (Hot Reload)" 선택
3. 플레이 버튼 클릭 또는 **F5** 키 누르기

### 프로덕션 모드

```bash
# 빌드
npm run build

# 실행
npm start
```

### 기타 스크립트

```bash
# TypeScript watch 모드 (자동 재컴파일)
npm run watch

# 개발 모드 + 자동 재시작 (핫 리로드)
npm run dev:watch
```

## 🔄 자동 크롤링 시스템

봇이 순환하며 자동으로 좌표를 크롤링합니다:

```
0분   → 🔺 피라미드
5분   → 🗡️ 야만인
10분  → ⚡ 아레스
15분  → 🔺 피라미드 (반복)
```

- **각 타입마다 15분마다 업데이트**
- **서버 부하 감소** (분산 크롤링)
- `!status`로 현재 스케줄 확인
- 봇 시작 시 모든 타입 초기 크롤링

## 🎯 주요 기능 상세

### 📍 거리 기반 정렬

`!setpos` 명령어로 내 좌표를 저장하면:

- 피라미드 검색 시 가까운 순서대로 정렬
- 정렬 우선순위: **레벨 높은 순** → **거리 가까운 순**
- 각 좌표마다 거리 표시 (📏 아이콘)

```bash
!setpos 500 600    # 내 좌표 저장
!pyramid          # 거리순 정렬된 결과 확인
!pyramid 5        # 레벨 5만, 거리순 정렬
```

### 🔔 스마트 알림 시스템

원하는 타입/레벨의 새 좌표가 발견되면 DM으로 알림:

**기능**:

- 레벨 필터링 (예: 레벨 5 이상만)
- 중복 알림 방지 (±10 범위 내 24시간)
- 실제로 새로운 좌표만 알림
- 거리 정보 포함 (좌표 저장 시)

**사용 예시**:

```bash
!alert pyramid 5           # 레벨 5+ 피라미드 알림
!alert barbarian          # 모든 야만인 알림
!alerts                   # 내 알림 확인
```

## 📝 사용 가능한 명령어

### 📍 좌표 명령어

| 명령어            | 별칭           | 설명                                |
| ----------------- | -------------- | ----------------------------------- |
| `!barbarian`      | `!bb`, `!barb` | 야만인 좌표 표시                    |
| `!ares`           | `!ar`          | 아레스 좌표 표시                    |
| `!pyramid [레벨]` | `!py`, `!pyr`  | 피라미드 좌표 표시 (레벨 필터 가능) |

### 📍 위치 명령어

| 명령어            | 별칭                | 설명                  |
| ----------------- | ------------------- | --------------------- |
| `!setpos <X> <Y>` | `!pos`, `!position` | 내 좌표 저장          |
| `!mypos`          | `!getpos`           | 내 저장된 좌표 조회   |
| `!positions`      | -                   | 모든 사용자 좌표 조회 |

### 🔔 알림 명령어

| 명령어                 | 설명                               |
| ---------------------- | ---------------------------------- |
| `!alert <타입> [레벨]` | 알림 설정 (예: `!alert pyramid 5`) |
| `!alerts`              | 내 알림 설정 조회                  |
| `!alert off [타입]`    | 알림 삭제                          |

### ⚙️ 시스템 명령어

| 명령어         | 설명                         |
| -------------- | ---------------------------- |
| `!help`        | 모든 명령어 표시             |
| `!about`       | 봇 작동 원리 설명            |
| `!status`      | 캐시 상태 및 스케줄 확인     |
| `!logs [필터]` | 서버 로그 조회 (페이징 지원) |

### 사용 예시

```bash
# 좌표 조회
!barbarian
!bb
!ares
!pyramid 5  # 레벨 5 피라미드만

# 위치 설정
!setpos 500 600
!mypos
!positions

# 알림 설정
!alert pyramid 5      # 레벨 5 이상 피라미드 알림
!alert barbarian      # 모든 야만인 알림
!alerts               # 내 알림 확인
!alert off pyramid    # 피라미드 알림 삭제
!alert off            # 모든 알림 삭제

# 시스템
!status
!logs
!logs error  # 에러 로그만
```

## 📁 프로젝트 구조

```
evony-bot/
├── src/
│   ├── index.ts              # 메인 엔트리 포인트 (Discord 봇 초기화)
│   ├── commands/
│   │   └── index.ts          # Discord 명령어 핸들러
│   ├── services/
│   │   ├── cache.ts          # 크롤링 데이터 캐싱
│   │   ├── db.ts             # Prisma 데이터베이스 서비스
│   │   ├── notification.ts   # DM 알림 발송
│   │   ├── scheduler.ts      # 자동 크롤링 스케줄러
│   │   └── scraper.ts        # Puppeteer 웹 스크래핑
│   ├── types/
│   │   └── coordinate.ts     # Coordinate 타입 정의
│   └── utils/
│       ├── coordinateTypes.ts # 좌표 타입 헬퍼 함수
│       ├── distance.ts        # 거리 계산 유틸리티
│       └── format.ts          # 포맷팅 유틸리티 (파워 등)
├── prisma/
│   ├── schema.prisma         # Prisma 스키마
│   └── migrations/           # 데이터베이스 마이그레이션
├── .env                      # 환경 변수 (git에 포함되지 않음)
├── env.example               # 환경 변수 예시
├── ecosystem.config.js       # PM2 설정
├── package.json
├── tsconfig.json
└── README.md
```

## 🌐 iScout.club 크롤링 시스템

봇은 [iScout.club](https://www.iscout.club) 웹사이트에서 자동으로 좌표 데이터를 수집합니다.

### 크롤링 방식

- **Puppeteer + Stealth 플러그인**: 봇 감지 우회
- **자동 로그인**: 세션 저장으로 재로그인 최소화
- **Cloudflare 대응**: 자동 캡차 처리

### 데이터 흐름

```
iScout.club (웹사이트)
    ↓ Puppeteer 크롤링
Scraper Service (src/services/scraper.ts)
    ↓ 데이터 정제
Cache Service (src/services/cache.ts)
    ↓ 명령어 요청 시
Discord 명령어 응답
```

### 크롤링 설정

`.env` 파일에 iScout.club 계정 정보를 설정하세요:

```env
ISCOUT_URL=https://www.iscout.club/en
ISCOUT_EMAIL=your_email@example.com
ISCOUT_PASSWORD=your_password
```

### 지원 기능

- ✅ **야만인**: 레벨, 파워, 얼라이언스 정보 포함
- ✅ **피라미드**: 레벨 4, 5 자동 필터링
- ✅ **아레스**: 기본 좌표 정보
- ✅ **자동 재시도**: 크롤링 실패 시 다음 사이클에서 재시도

## 🛠️ 기술 스택

- **런타임**: Node.js + TypeScript
- **Discord**: Discord.js v14
- **웹 스크래핑**: Puppeteer + Stealth 플러그인
- **데이터베이스**: Prisma + SQLite
- **프로세스 관리**: PM2 (프로덕션)
- **개발 도구**: ts-node, ts-node-dev

## 💾 데이터베이스 스키마

봇은 Prisma와 SQLite를 사용하여 다음 데이터를 저장합니다:

### User (사용자)

- Discord ID
- 사용자명
- X, Y 좌표
- 생성/업데이트 시간

### UserAlert (알림 설정)

- Discord ID
- 알림 타입 (pyramid/barbarian/ares)
- 최소 레벨
- 최대 거리
- 활성화 여부

### SentAlert (알림 기록)

- Discord ID
- 타입, 레벨, 파워
- X, Y 좌표
- 전송 시간

**중복 알림 방지**: 24시간 이내에 동일한 좌표 근처(±10)로 중복 알림을 발송하지 않습니다.

## 🔧 TypeScript 설정

프로젝트는 TypeScript로 작성되었으며, `tsconfig.json` 파일에서 설정을 변경할 수 있습니다.

### VS Code 디버깅 팁

1. **중단점 설정**: 줄 번호 왼쪽을 클릭하여 빨간 점 추가
2. **F5**: 디버깅 시작
3. **F10**: 단계 넘기기
4. **F11**: 단계 들어가기
5. **Shift+F11**: 단계 나가기
6. **F9**: 중단점 토글
7. **Shift+F5**: 디버깅 중지

### 디버그 모드

- **🔥 Discord Bot (Hot Reload)**: 코드 변경 시 자동 재시작 (기본값)
- **🤖 Discord Bot Debug**: 중단점 디버깅
- **🚀 Discord Bot (Built Files)**: 프로덕션과 유사한 실행

### TypeScript Watch 모드

디버깅을 시작하면 TypeScript watch 모드가 자동으로 실행됩니다. 저장 시 코드가 자동으로 재컴파일됩니다.

## 🚀 서버 배포 (evony-bot SSH)

### 빠른 배포 명령어

```bash
# 빌드 & 배포 (로컬에서 실행)
cd "/Users/devjm/Documents/Persnal Project/Evony Bot" && \
npm run build && \
tar -czf /tmp/evony-bot.tar.gz --exclude='node_modules' --exclude='chrome' --exclude='chrome-user-data' --exclude='.git' --exclude='*.log' --exclude='.env' . && \
scp /tmp/evony-bot.tar.gz evony-bot:~/ && \
ssh evony-bot "cd ~/evony-bot && tar -xzf ~/evony-bot.tar.gz && pm2 restart evony-bot"
```

### 최초 서버 설정

```bash
# 1. SSH 접속
ssh evony-bot

# 2. 프로젝트 디렉토리 생성
mkdir -p ~/evony-bot && cd ~/evony-bot

# 3. 파일 압축 해제
tar -xzf ~/evony-bot.tar.gz

# 4. 의존성 설치
npm install

# 5. Prisma 설정
npx prisma generate
npx prisma db push

# 6. 환경 변수 설정 (.env 생성)
cat >> .env << EOF
DISCORD_TOKEN=your_token_here
ISCOUT_URL=https://www.iscout.club/en
ISCOUT_EMAIL=your_email
ISCOUT_PASSWORD=your_password
DATABASE_URL="file:./dev.db"
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
EOF

# 7. PM2로 시작
pm2 start ecosystem.config.js
pm2 save
```

### PM2 명령어

```bash
# 로그 확인
pm2 logs evony-bot --lines 50

# 재시작
pm2 restart evony-bot

# 상태 확인
pm2 status

# 완전 재시작 (환경변수 새로 로드)
pm2 stop evony-bot && pm2 delete evony-bot && pm2 start ecosystem.config.js
```

### 중요 사항

- ⚠️ **`.env` 파일은 배포에서 제외됨** - 서버에서 직접 관리
- ⚠️ **PUPPETEER_EXECUTABLE_PATH** - ARM64 서버에서는 `/usr/bin/chromium` 사용
- ⚠️ **Prisma 마이그레이션** - 스키마 변경 시 서버에서도 `npx prisma db push` 실행 필요

## 📚 참고 자료

- [Discord.js 공식 문서](https://discord.js.org/)
- [Discord.js 가이드](https://discordjs.guide/)
- [Discord Developer Portal](https://discord.com/developers/applications)
- [Prisma 문서](https://www.prisma.io/docs)
- [Puppeteer 문서](https://pptr.dev/)
- [iScout.club](https://www.iscout.club) - 좌표 데이터 소스

## ⚠️ 주의 사항

- `.env` 파일을 절대 GitHub에 업로드하지 마세요!
- 봇 토큰이 노출되면 즉시 Discord Developer Portal에서 재생성하세요.
- 메시지를 읽으려면 MESSAGE CONTENT INTENT가 활성화되어 있어야 합니다.
- iScout.club 계정 정보도 안전하게 보관하세요.
- Cloudflare 캡차는 최초 1회 수동으로 해결해야 할 수 있습니다.

## 🔧 트러블슈팅

### Chrome/Chromium 관련 오류

**문제**: Puppeteer가 Chrome을 찾지 못함

**해결**:

```bash
# macOS (Homebrew)
brew install chromium

# Ubuntu/Debian
sudo apt-get install chromium-browser

# 또는 환경 변수 설정
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
```

### 로그인 실패

**문제**: iScout.club 로그인 실패

**해결**:

1. `.env` 파일의 이메일/비밀번호 확인
2. `chrome-user-data` 폴더 삭제 후 재시작
3. 로컬 환경에서 headless=false로 실행하여 수동 로그인

### 데이터베이스 오류

**문제**: Prisma 관련 오류

**해결**:

```bash
# Prisma 클라이언트 재생성
npx prisma generate

# 데이터베이스 리셋
rm -f prisma/dev.db
npx prisma db push
```

### 로그 확인

```bash
# 실시간 로그 확인
pm2 logs evony-bot --lines 100

# 또는 Discord에서
!logs
!logs error
```

## 📄 라이선스

ISC
