// Player Watch 서비스 (특정 플레이어의 버블 다운 실시간 모니터링)
//
// 핵심 원칙: 이벤트 기반(EVENT-DRIVEN). 폴링 없음.
//   iScout가 WebSocket으로 프레임을 push하는 그 순간 CDP(Network.webSocketFrameReceived)가
//   즉시 발화하여 파싱 → 매칭 → Discord 알림이 ms 단위로 처리됨.
//   주기적 polling/refresh가 일절 없으므로 알림 지연은 (네트워크 + Discord API) 수십~수백 ms.
//
// 동작:
// 1) start() 호출 시 동일한 Puppeteer page를 사용해 Players 섹션을 열고
//    Power 범위/Bubble=No 필터를 Apply
// 2) PRIMARY: CDP webSocketFrameReceived 리스너가 모든 iScout WS 프레임을 즉시 캡처
//             → Socket.IO v4 파서 → 페이로드에서 player 객체 추출 → 매칭 → 즉시 알림
//    FALLBACK: 페이지에 MutationObserver 설치 (CDP가 일부 프레임을 놓치는 경우 대비)
// 3) Edge-triggered 알림: "버블 다운" 상태 변화의 시작에서 1회 알림
//    - 처음 발견 → 즉시 알림
//    - 버블 다운 동안 같은 플레이어가 계속 보이면 추가 알림 안 함 (스팸 방지)
//    - 60초간 안 보이다가 다시 보이면 "재버블 다운"으로 간주 → 다시 즉시 알림
// 4) 일반 5분 로테이션 크롤링은 그대로 진행되며, 각 스크랩 종료 직후
//    reapplyAfterScrape()가 호출되어 Watch 필터를 재적용 → 즉시 리스닝 복귀
// 5) stop() 호출 시 CDP detach + observer 해제

import { CDPSession, Page } from "puppeteer";
import { EmbedBuilder } from "discord.js";
import * as fs from "fs";
import * as path from "path";
import { cache } from "./cache";
import { db } from "./db";
import { scraper } from "./scraper";
import { scheduler } from "./scheduler";

interface WatchDetection {
  name: string;
  alliance?: string;
  power?: string;
  level?: string;
  keep?: string;
  server?: string;
  x?: number;
  y?: number;
  /** 감지 출처 (디버깅용) */
  source?: "ws" | "dom";
}

interface SpottedRecord {
  /** 마지막으로 본 시각 (ms) */
  lastSeenAt: number;
  /** 이미 알림을 보냈는지 (현재 spotted 상태에서) */
  notified: boolean;
}

interface WatchStats {
  /** 받은 모든 WS 프레임 수 (iScout 도메인) */
  wsFramesReceived: number;
  /** Socket.IO event 메시지(42)로 파싱 성공한 수 */
  socketIoEvents: number;
  /** 페이로드에서 player-like 객체가 추출된 이벤트 수 */
  eventsWithPlayers: number;
  /** 추출된 모든 player 후보 수 (중복 포함) */
  playersExtracted: number;
  /** 감시 대상 이름과 매칭된 후보 수 */
  matched: number;
  /** 디스코드로 발송된 알림 수 */
  notificationsSent: number;
}

interface WatchState {
  active: boolean;
  channelId: string | null;
  channelSend: ((payload: any) => Promise<unknown>) | null;
  minPower: number;
  maxPower: number;
  /** 비교용: 소문자/trim된 감시 대상 이름 목록 */
  targetNames: string[];
  /** 사용자 표기용 원본 이름 목록 */
  rawNames: string[];
  /**
   * 현재 "발견된" 플레이어 추적.
   *
   * 아이디어: 버블 다운 동안 같은 플레이어가 매 스캔마다 들어와서 알림이 폭주하는 것을 방지.
   * - 처음 보면 알림 + notified=true
   * - 같은 플레이어가 짧은 간격으로 계속 보이면 lastSeenAt만 갱신, 추가 알림 없음
   * - LOST_GAP_MS 동안 보이지 않다가 다시 보이면 "버블 재발생" 으로 보고 다시 알림
   */
  spotted: Map<string, SpottedRecord>;
  startedAt: Date | null;
  stats: WatchStats;
}

class PlayerWatchService {
  private state: WatchState = this.initialState();
  private bridgeInstalled = false;
  private cdpClient: CDPSession | null = null;
  /** WebSocket requestId -> URL 매핑 (로깅 + 필터링용) */
  private wsUrls: Map<string, string> = new Map();
  /**
   * "발견 상태"에서 lastSeen 이후 이 시간 동안 안 보이면 spotted=false로 리셋.
   * 다음 번 다시 보이면 새 버블 다운으로 간주하고 알림을 다시 보냄.
   */
  private readonly LOST_GAP_MS = 60 * 1000;
  /** 매칭이 안 된 미지의 WS 이벤트 진단 로그 샘플링 비율 (1%) */
  private readonly UNKNOWN_EVENT_LOG_RATE = 0.01;
  /** spotted 상태 가비지 컬렉션 인터벌 핸들 */
  private gcTimer: NodeJS.Timeout | null = null;
  /** Watch 활성 상태를 주기적으로 알리는 heartbeat 인터벌 */
  private heartbeatTimer: NodeJS.Timeout | null = null;
  /**
   * 10분마다 page를 reload하여 iScout 세션이 만료되지 않도록 유지하는 백업 타이머.
   * 현재는 스케줄러의 5분 로테이션이 page reload 효과를 주므로 비활성 상태.
   */
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly REFRESH_INTERVAL_MS = 10 * 60 * 1000;
  /** refresh 동작이 진행 중인지 (heartbeat 등이 충돌하지 않도록) */
  private isRefreshing: boolean = false;
  /**
   * 처음 N개 frame은 무조건 상세 로그(디버깅용).
   * Watch 시작 직후 어떤 데이터가 들어오는지 확인할 수 있도록.
   */
  private framesToLogVerbose: number = 0;
  private readonly INITIAL_VERBOSE_FRAME_COUNT = 30;
  /** WS 프레임 풀 덤프 파일 경로 (디버깅용 - parser 검증) */
  private wsDumpFile: string | null = null;
  private wsFramesDumped: number = 0;
  private readonly MAX_WS_DUMP_FRAMES = 100;

  private initialState(): WatchState {
    return {
      active: false,
      channelId: null,
      channelSend: null,
      minPower: 0,
      maxPower: 0,
      targetNames: [],
      rawNames: [],
      spotted: new Map(),
      startedAt: null,
      stats: this.zeroStats(),
    };
  }

  private zeroStats(): WatchStats {
    return {
      wsFramesReceived: 0,
      socketIoEvents: 0,
      eventsWithPlayers: 0,
      playersExtracted: 0,
      matched: 0,
      notificationsSent: 0,
    };
  }

  isActive(): boolean {
    return this.state.active;
  }

  getStatus() {
    return {
      active: this.state.active,
      channelId: this.state.channelId,
      minPower: this.state.minPower,
      maxPower: this.state.maxPower,
      targetNames: this.state.rawNames,
      startedAt: this.state.startedAt,
      stats: { ...this.state.stats },
    };
  }

  /** Player Watch 시작 */
  async start(opts: {
    channelId: string;
    channelSend: (payload: any) => Promise<unknown>;
    minPower: number;
    maxPower: number;
    names: string[];
  }): Promise<void> {
    const cleanedNames = opts.names
      .map((n) => n.trim())
      .filter((n) => n.length > 0);

    if (cleanedNames.length === 0) {
      throw new Error("At least one player name is required");
    }

    console.log(
      "ℹ️ Scheduler keeps running rotation; Watch will re-listen after each scrape (queued via scraper mutex)",
    );
    if (cache.getMetadata().isUpdating) {
      cache.setUpdating(false);
    }

    this.state = {
      active: true,
      channelId: opts.channelId,
      channelSend: opts.channelSend,
      minPower: opts.minPower,
      maxPower: opts.maxPower,
      targetNames: cleanedNames.map((n) => n.toLowerCase()),
      rawNames: cleanedNames,
      spotted: new Map(),
      startedAt: new Date(),
      stats: this.zeroStats(),
    };

    this.framesToLogVerbose = this.INITIAL_VERBOSE_FRAME_COUNT;

    try {
      const logsDir = path.join(process.cwd(), "logs");
      if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
      this.wsDumpFile = path.join(
        logsDir,
        `pw-ws-frames-${Date.now()}.log`,
      );
      fs.writeFileSync(
        this.wsDumpFile,
        `# Player Watch WebSocket frame dump\n# Started: ${new Date().toISOString()}\n# Targets: ${cleanedNames.join(", ")}\n# Power: ${opts.minPower}M ~ ${opts.maxPower}M\n# Format: [timestamp] (size) <full payload>\n\n`,
      );
      this.wsFramesDumped = 0;
      console.log(`💾 WS frame dump file: ${this.wsDumpFile}`);
    } catch (e) {
      console.warn("⚠️ Failed to initialize WS dump file:", (e as Error).message);
      this.wsDumpFile = null;
    }

    this.gcTimer = setInterval(() => this.gcSpotted(), 15 * 1000);
    this.heartbeatTimer = setInterval(() => this.logHeartbeat(), 60 * 1000);

    // 10분 page refresh 타이머는 비활성: 스케줄러가 5분마다 page를 reload하고
    // 끝나면 reapplyAfterScrape()로 Watch를 재적용하므로 중복 새로고침 불필요.

    try {
      await scraper.initialize();

      const page = await scraper.getPage();
      if (!page) {
        throw new Error("Puppeteer page is not available");
      }

      // CDP WebSocket 캡처는 applyWatchFilter 이전에 설치해
      // 첫 Apply 응답 프레임도 놓치지 않도록 함
      await this.installCdpCapture(page);

      await scraper.applyWatchFilter(opts.minPower, opts.maxPower);

      await this.installDomObserver(page);

      try {
        await db.savePlayerWatchConfig({
          minPower: opts.minPower,
          maxPower: opts.maxPower,
          names: cleanedNames,
          channelId: opts.channelId,
        });
        console.log("💾 Watch config saved to DB (resume with !watchresume)");
      } catch (dbErr) {
        console.error("⚠️ Failed to save Watch config to DB:", dbErr);
      }

      console.log(
        `🫧 Player Watch ACTIVE — targets=[${cleanedNames.join(", ")}], power=[${opts.minPower}M ~ ${opts.maxPower}M]`,
      );
      console.log(
        "📡 EVENT-DRIVEN: Each WebSocket frame is processed in real-time (no polling).",
      );
      console.log(
        "🔁 Scheduler stays ON — Pyramid/Barbarian/Monsters will continue 5-min rotation; Watch will re-apply after each scrape.",
      );

      try {
        scheduler.start();
      } catch (e) {
        console.error("   ⚠️ Failed to (re)start scheduler:", e);
      }
    } catch (error) {
      console.error("❌ Player Watch start failed, rolling back...", error);
      if (this.gcTimer) {
        clearInterval(this.gcTimer);
        this.gcTimer = null;
      }
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      if (this.refreshTimer) {
        clearInterval(this.refreshTimer);
        this.refreshTimer = null;
      }
      await this.detachCdp().catch(() => {});
      this.state = this.initialState();
      throw error;
    }
  }

  /**
   * 60초마다 Watch가 살아있음을 로그로 알림 (생존 + 누적 통계).
   *
   * 주의: 이건 단지 "Watch가 죽지 않았다"는 신호용 heartbeat이지, 알림 폴링이 아님.
   * 실제 알림은 WS 프레임이 도착하는 즉시 (event-driven) 발송됨.
   */
  private logHeartbeat(): void {
    if (!this.state.active) return;
    const upSec = this.state.startedAt
      ? Math.floor((Date.now() - this.state.startedAt.getTime()) / 1000)
      : 0;
    const s = this.state.stats;
    const targets = this.state.rawNames.join(", ");
    console.log(
      `💓 [${this.nowTs()}] Watch alive (heartbeat — NOT a poll): up=${upSec}s | targets=[${targets}] | ws_frames=${s.wsFramesReceived} | sio_events=${s.socketIoEvents} | events_with_players=${s.eventsWithPlayers} | players_extracted=${s.playersExtracted} | matched=${s.matched} | notifications=${s.notificationsSent} | currently_spotted=${this.state.spotted.size}`,
    );
  }

  /**
   * 10분마다 page 새로고침 — iScout 세션 만료 방지 (현재는 미사용 백업 경로).
   *
   * 동작:
   *  1. page.reload()로 페이지 새로고침
   *  2. 새 WS 연결 자동 수립 (CDP 리스너가 자동 감지하여 새 frame 캡처 시작)
   *  3. DOM observer 재설치 (window 재생성으로 인해 기존 observer는 사라짐)
   */
  private async refreshPage(): Promise<void> {
    if (!this.state.active) return;
    if (this.isRefreshing) {
      console.log(`🔄 [${this.nowTs()}] Watch refresh skipped — already in progress`);
      return;
    }
    this.isRefreshing = true;

    const startedAt = Date.now();
    try {
      const page = await scraper.getPage();
      if (!page) {
        console.warn(`⚠️ [${this.nowTs()}] Watch refresh: no page available`);
        return;
      }
      if (page.isClosed()) {
        console.warn(`⚠️ [${this.nowTs()}] Watch refresh: page is closed`);
        return;
      }

      console.log(
        `🔄 [${this.nowTs()}] Watch 10-min refresh: reloading page to keep iScout session alive...`,
      );

      await page.reload({ waitUntil: "networkidle2", timeout: 60_000 });

      await page.waitForTimeout(3_000);

      try {
        await this.installDomObserver(page);
      } catch (e) {
        console.warn(
          `⚠️ [${this.nowTs()}] Failed to reinstall DOM observer after refresh:`,
          (e as Error).message,
        );
      }

      this.framesToLogVerbose = Math.min(
        this.INITIAL_VERBOSE_FRAME_COUNT,
        10,
      );

      const took = Date.now() - startedAt;
      console.log(
        `✅ [${this.nowTs()}] Watch refresh completed in ${took}ms — WS reconnected, observer reinstalled`,
      );
    } catch (err) {
      console.error(
        `❌ [${this.nowTs()}] Watch refresh failed:`,
        (err as Error).message,
      );
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * 스케줄된 일반 크롤링(Pyramid/Barbarian/Monsters)이 끝난 직후 호출되어
   * Watch 필터를 다시 적용하고 Players 화면 + WS 리스닝 상태로 즉시 복귀시킨다.
   *
   * - 스크랩 동안 page는 EvonyBot 프리셋으로 이동했고 iScout WS는 끊겼다 다시 붙는다
   * - 스크랩 종료 시점에 이 메서드가 큐 (scraper.runQueued) 다음 슬롯으로 들어가
   *   page reload + Players 섹션 열기 + Apply를 수행한다
   * - CDP 캡처는 page Target에 attach 돼 있어 새 WS도 자동 캡처
   * - DOM observer는 page reload로 사라지므로 재설치
   *
   * 동시성: scraper.applyWatchFilter가 내부적으로 runQueued를 사용하므로 별도 락 불필요.
   * isRefreshing 플래그로 중복 호출만 방지.
   */
  async reapplyAfterScrape(): Promise<void> {
    if (!this.state.active) return;
    if (this.isRefreshing) {
      console.log(
        `🔁 [${this.nowTs()}] Watch reapply skipped — already in progress`,
      );
      return;
    }
    this.isRefreshing = true;
    const startedAt = Date.now();
    try {
      console.log(
        `🔁 [${this.nowTs()}] Re-applying Watch filter after scheduled scrape...`,
      );
      await scraper.applyWatchFilter(this.state.minPower, this.state.maxPower);

      const page = await scraper.getPage();
      if (page && !page.isClosed()) {
        try {
          await this.installDomObserver(page);
        } catch (e) {
          console.warn(
            `⚠️ [${this.nowTs()}] Failed to reinstall DOM observer after reapply:`,
            (e as Error).message,
          );
        }
      }

      this.framesToLogVerbose = Math.min(
        10,
        this.INITIAL_VERBOSE_FRAME_COUNT,
      );

      const took = Date.now() - startedAt;
      console.log(
        `✅ [${this.nowTs()}] Watch re-listening (reapply took ${took}ms)`,
      );
    } catch (err) {
      console.error(
        `❌ [${this.nowTs()}] Watch reapply after scrape failed:`,
        (err as Error).message,
      );
    } finally {
      this.isRefreshing = false;
    }
  }

  /** spotted 상태 가비지 컬렉션 — LOST_GAP_MS 이상 미관찰된 플레이어 제거 */
  private gcSpotted(): void {
    if (!this.state.active) return;
    const now = Date.now();
    let removed = 0;
    for (const [name, rec] of this.state.spotted.entries()) {
      if (now - rec.lastSeenAt > this.LOST_GAP_MS) {
        this.state.spotted.delete(name);
        removed++;
      }
    }
    if (removed > 0) {
      console.log(`🧹 Watch spotted GC: removed ${removed} stale entries`);
    }
  }

  /**
   * 저장된 Watch 설정 조회 (resume 가능 여부 확인용).
   * channelSend는 호출자가 따로 설정해야 하므로 channelId만 함께 반환.
   */
  async getSavedConfig(): Promise<{
    minPower: number;
    maxPower: number;
    names: string[];
    channelId: string;
    updatedAt: Date;
  } | null> {
    return await db.getPlayerWatchConfig();
  }

  /**
   * 저장된 Watch 설정 삭제 (사용자가 명시적으로 정리하고 싶을 때).
   */
  async clearSavedConfig(): Promise<boolean> {
    return await db.clearPlayerWatchConfig();
  }

  /**
   * DB에 저장된 마지막 Watch 설정으로 모니터링 재개.
   * channelSend는 호출자가 제공해야 함 (Discord channel.send 함수 바인딩).
   * 저장된 설정이 없으면 false 반환.
   */
  async resume(opts: {
    /** channelId가 일치하지 않더라도 강제로 진행할지 */
    overrideChannelId?: string;
    channelSend: (payload: any) => Promise<unknown>;
  }): Promise<{
    started: boolean;
    reason?: string;
    config?: {
      minPower: number;
      maxPower: number;
      names: string[];
      channelId: string;
    };
  }> {
    if (this.state.active) {
      return { started: false, reason: "Player Watch is already active" };
    }
    const cfg = await db.getPlayerWatchConfig();
    if (!cfg) {
      return { started: false, reason: "No saved Watch config found" };
    }

    const targetChannelId = opts.overrideChannelId ?? cfg.channelId;
    console.log(
      `▶️ Resuming Player Watch from saved config: targets=[${cfg.names.join(", ")}], power=[${cfg.minPower}M ~ ${cfg.maxPower}M], channel=${targetChannelId}`,
    );

    await this.start({
      channelId: targetChannelId,
      channelSend: opts.channelSend,
      minPower: cfg.minPower,
      maxPower: cfg.maxPower,
      names: cfg.names,
    });

    return {
      started: true,
      config: {
        minPower: cfg.minPower,
        maxPower: cfg.maxPower,
        names: cfg.names,
        channelId: cfg.channelId,
      },
    };
  }

  /** Player Watch 종료 */
  async stop(): Promise<void> {
    if (!this.state.active) {
      console.log("ℹ️ Player Watch is not active");
      return;
    }

    console.log("🛑 Stopping Player Watch...");
    this.state.active = false;

    this.logHeartbeat();

    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    const page = await scraper.getPage();
    if (page) {
      await page
        .evaluate(() => {
          const w = window as any;
          if (w.__pwObserver) {
            try {
              w.__pwObserver.disconnect();
            } catch {}
            w.__pwObserver = null;
          }
          if (w.__pwSeenTimer) {
            clearInterval(w.__pwSeenTimer);
            w.__pwSeenTimer = null;
          }
          w.__pwSeen = null;
        })
        .catch((e) => {
          console.warn("   Failed to disconnect DOM observer:", e);
        });
    }

    await this.detachCdp().catch((e) => {
      console.warn("   Failed to detach CDP session:", e);
    });

    this.state = this.initialState();

    // 스케줄러는 Watch 동안 계속 돌고 있었으므로 별도 재시작 불필요.
    // 안전망으로 멈춰있다면 다시 시작.
    try {
      scheduler.start();
    } catch (e) {
      console.error("   ⚠️ Failed to ensure scheduler is running:", e);
    }
    console.log(
      "✅ Player Watch stopped — scheduler continues normal 5-min rotation",
    );
  }

  // ------------------------------------------------------------------
  // CDP-based WebSocket frame capture (PRIMARY)
  // ------------------------------------------------------------------

  private async installCdpCapture(page: Page): Promise<void> {
    if (this.cdpClient) {
      await this.detachCdp().catch(() => {});
    }

    try {
      const client = await page.target().createCDPSession();
      await client.send("Network.enable");

      this.wsUrls = new Map();

      client.on("Network.webSocketCreated", (params: any) => {
        const url = params.url || "";
        this.wsUrls.set(params.requestId, url);
        console.log(`🔌 WS created (id=${params.requestId}): ${url}`);
      });

      client.on("Network.webSocketClosed", (params: any) => {
        const url = this.wsUrls.get(params.requestId) ?? params.requestId;
        console.log(`🔌 WS closed: ${url}`);
        this.wsUrls.delete(params.requestId);
      });

      client.on("Network.webSocketFrameError", (params: any) => {
        console.warn("⚠️ WS frame error:", params.errorMessage);
      });

      client.on("Network.webSocketFrameReceived", (params: any) => {
        const url = this.wsUrls.get(params.requestId) || "";
        if (url && !/iscout/i.test(url)) return;
        const payload: string = params.response?.payloadData ?? "";
        if (!payload) return;
        const frameReceivedAt = Date.now();
        if (this.state.active) this.state.stats.wsFramesReceived++;
        try {
          this.handleWebSocketFrame(payload, frameReceivedAt);
        } catch (e) {
          // 파서 예외는 무시
        }
      });

      // Client → Server 프레임도 캡처 (디버깅용)
      client.on("Network.webSocketFrameSent", (params: any) => {
        const url = this.wsUrls.get(params.requestId) || "";
        if (url && !/iscout/i.test(url)) return;
        const payload: string = params.response?.payloadData ?? "";
        if (!payload) return;
        if (payload.length <= 2) return;
        if (this.wsDumpFile && this.wsFramesDumped < this.MAX_WS_DUMP_FRAMES) {
          this.wsFramesDumped++;
          try {
            fs.appendFileSync(
              this.wsDumpFile,
              `[${this.nowTs()}] [SENT] (${payload.length}b)\n${payload}\n\n`,
            );
          } catch {}
        }
      });

      this.cdpClient = client;
      console.log("🔌 CDP WebSocket capture installed");
    } catch (err) {
      console.error("❌ Failed to install CDP WebSocket capture:", err);
    }
  }

  private async detachCdp(): Promise<void> {
    if (!this.cdpClient) return;
    try {
      await this.cdpClient.detach();
      console.log("🔌 CDP session detached");
    } finally {
      this.cdpClient = null;
      this.wsUrls.clear();
    }
  }

  /**
   * Socket.IO v4 프로토콜 프레임 파서.
   *
   * 텍스트 프레임 포맷:
   *   "0..."   - OPEN (handshake)
   *   "2"      - PING
   *   "3"      - PONG
   *   "40..."  - Socket.IO CONNECT
   *   "41..."  - Socket.IO DISCONNECT
   *   "42[event,data]"           - EVENT (default namespace)
   *   "42/ns,[event,data]"       - EVENT (namespaced)
   *   "43..."  - ACK
   *
   * 우리는 "42" (EVENT)만 파싱.
   */
  private parseSocketIoMessage(
    payload: string,
  ): { event: string; data: any } | null {
    if (typeof payload !== "string" || payload.length < 3) return null;
    if (!payload.startsWith("42")) return null;

    let rest = payload.substring(2);
    if (rest.startsWith("/")) {
      const commaIdx = rest.indexOf(",");
      if (commaIdx === -1) return null;
      rest = rest.substring(commaIdx + 1);
    }
    rest = rest.replace(/^\d+/, "");

    if (!rest.startsWith("[")) return null;

    try {
      const arr = JSON.parse(rest);
      if (!Array.isArray(arr) || arr.length < 1) return null;
      const event = String(arr[0]);
      const data = arr.length > 1 ? arr[1] : undefined;
      return { event, data };
    } catch {
      return null;
    }
  }

  /**
   * payload 객체를 재귀 탐색하여 "플레이어처럼 보이는" 객체를 모두 추출.
   *
   * 식별 휴리스틱: name(string) + 좌표(x,y) 가 있는 객체.
   */
  private extractPlayersFromAny(
    value: any,
    out: WatchDetection[],
    depth: number = 0,
  ): void {
    if (depth > 10) return;
    if (value === null || value === undefined) return;
    if (typeof value !== "object") return;

    if (Array.isArray(value)) {
      for (const item of value) this.extractPlayersFromAny(item, out, depth + 1);
      return;
    }

    const v: any = value;

    // ----------------------------------------------------------------
    // Strategy A: iScout filter_subscribe 형식
    // ----------------------------------------------------------------
    if (
      typeof v.x === "number" &&
      typeof v.y === "number" &&
      v.serverId !== undefined &&
      v.item &&
      typeof v.item === "object"
    ) {
      const item = v.item;
      let name: string | undefined;
      let alliance: string | undefined;
      let power: string | undefined;
      let level: string | undefined;
      let keep: string | undefined;

      if (typeof item.raw_text === "string") {
        const rt = item.raw_text;
        const nameMatch = rt.match(/^([^\[\n]+?)(?:\s*\[([A-Za-z0-9_]+)\])?\s*(?:K\d+|Lv\d+|$|\s)/);
        if (nameMatch) {
          name = nameMatch[1].trim();
          if (nameMatch[2]) alliance = nameMatch[2].trim();
        }
        const keepMatch = rt.match(/K(\d+)/);
        if (keepMatch) keep = `K${keepMatch[1]}`;
        const levelMatch = rt.match(/Lv(\d+)/);
        if (levelMatch) level = `Lv${levelMatch[1]}`;
        const powerMatch = rt.match(/([\d.]+)\s*([BMK])/);
        if (powerMatch) power = `${powerMatch[1]}${powerMatch[2]}`;
      }

      if (!name && typeof item.name === "string") name = item.name;
      if (!name && typeof item.player_name === "string") name = item.player_name;
      if (!alliance && typeof item.alliance === "string") alliance = item.alliance;
      if (!alliance && typeof item.alliance_tag === "string") alliance = item.alliance_tag;
      if (!power && (typeof item.power === "number" || typeof item.power === "string")) {
        power = this.formatPowerCompact(item.power);
      }
      if (!level && item.level !== undefined) level = `Lv${item.level}`;
      if (!keep && item.keep !== undefined) keep = `K${item.keep}`;

      if (name && name.length > 0 && name.length < 50) {
        out.push({
          name: name.trim(),
          alliance,
          power,
          level,
          keep,
          server: String(v.serverId),
          x: v.x,
          y: v.y,
          source: "ws",
        });
        return;
      }
    }

    // ----------------------------------------------------------------
    // Strategy B: 직접 player 객체
    // ----------------------------------------------------------------
    const nameRaw =
      v.name ?? v.player_name ?? v.player ?? v.username ?? v.nick ?? null;
    const xRaw = v.x ?? v.coord_x ?? v.coordX ?? v.coordx ?? null;
    const yRaw = v.y ?? v.coord_y ?? v.coordY ?? v.coordy ?? null;

    const looksLikePlayer =
      typeof nameRaw === "string" &&
      nameRaw.trim().length > 0 &&
      nameRaw.trim().length < 50 &&
      (typeof xRaw === "number" || (typeof xRaw === "string" && xRaw !== "")) &&
      (typeof yRaw === "number" || (typeof yRaw === "string" && yRaw !== ""));

    if (looksLikePlayer) {
      const x = typeof xRaw === "number" ? xRaw : parseInt(String(xRaw), 10);
      const y = typeof yRaw === "number" ? yRaw : parseInt(String(yRaw), 10);

      const allianceRaw =
        v.alliance ??
        v.alliance_tag ??
        v.allianceTag ??
        v.alliance_name ??
        v.allianceName ??
        v.guild ??
        undefined;

      const powerRaw = v.power ?? v.player_power ?? undefined;
      const levelRaw = v.level ?? v.player_level ?? undefined;
      const keepRaw = v.keep ?? v.castle_lvl ?? v.kingdom ?? undefined;
      const serverRaw = v.server ?? v.server_id ?? v.serverId ?? undefined;

      out.push({
        name: String(nameRaw).trim(),
        alliance:
          allianceRaw !== undefined && allianceRaw !== null
            ? String(allianceRaw)
            : undefined,
        power: powerRaw !== undefined ? this.formatPowerCompact(powerRaw) : undefined,
        level: levelRaw !== undefined ? `Lv${levelRaw}` : undefined,
        keep: keepRaw !== undefined ? `K${keepRaw}` : undefined,
        server: serverRaw !== undefined ? String(serverRaw) : undefined,
        x: Number.isFinite(x) ? x : undefined,
        y: Number.isFinite(y) ? y : undefined,
        source: "ws",
      });
      return;
    }

    for (const k of Object.keys(v)) {
      this.extractPlayersFromAny(v[k], out, depth + 1);
    }
  }

  /** 숫자 power(예: 6_400_000_000)를 "6.40B" 같은 짧은 표기로 */
  private formatPowerCompact(p: any): string {
    const n = typeof p === "number" ? p : parseFloat(String(p));
    if (!Number.isFinite(n)) return String(p);
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
    return String(n);
  }

  /** ms 정밀도 타임스탬프 (HH:MM:SS.mmm) */
  private nowTs(): string {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    const ms = String(d.getMilliseconds()).padStart(3, "0");
    return `${hh}:${mm}:${ss}.${ms}`;
  }

  private handleWebSocketFrame(payload: string, receivedAt: number): void {
    if (!this.state.active) return;

    if (this.framesToLogVerbose > 0) {
      this.framesToLogVerbose--;
      const preview = payload.length > 240 ? payload.slice(0, 240) + "..." : payload;
      console.log(
        `🪵 [${this.nowTs()}] [WS raw ${this.INITIAL_VERBOSE_FRAME_COUNT - this.framesToLogVerbose}/${this.INITIAL_VERBOSE_FRAME_COUNT}] (${payload.length}b) ${preview}`,
      );
    }

    if (this.wsDumpFile && this.wsFramesDumped < this.MAX_WS_DUMP_FRAMES) {
      this.wsFramesDumped++;
      try {
        fs.appendFileSync(
          this.wsDumpFile,
          `[${this.nowTs()}] (${payload.length}b)\n${payload}\n\n`,
        );
        if (this.wsFramesDumped === this.MAX_WS_DUMP_FRAMES) {
          console.log(`💾 WS dump file reached ${this.MAX_WS_DUMP_FRAMES} frames - no more dumps`);
        }
      } catch {}
    }

    const parsed = this.parseSocketIoMessage(payload);
    if (!parsed) return;

    this.state.stats.socketIoEvents++;

    const players: WatchDetection[] = [];
    this.extractPlayersFromAny(parsed.data, players);

    if (players.length === 0) {
      if (Math.random() < this.UNKNOWN_EVENT_LOG_RATE) {
        const preview = JSON.stringify(parsed.data ?? null).slice(0, 160);
        console.log(
          `📦 [${this.nowTs()}] WS event "${parsed.event}" — no player-like objects [sample] ${preview}`,
        );
      }
      return;
    }

    this.state.stats.eventsWithPlayers++;
    this.state.stats.playersExtracted += players.length;

    const sampleNames = players
      .slice(0, 5)
      .map((p) => {
        const isTarget = this.state.targetNames.some(
          (t) =>
            p.name.toLowerCase() === t ||
            p.name.toLowerCase().includes(t) ||
            t.includes(p.name.toLowerCase()),
        );
        return isTarget ? `**${p.name}**` : p.name;
      })
      .join(", ");
    console.log(
      `🛰️ [${this.nowTs()}] WS frame: event="${parsed.event}" players=${players.length} → ${sampleNames}${players.length > 5 ? ", ..." : ""}`,
    );

    for (const p of players) {
      this.handleDetection(p, receivedAt).catch((e) =>
        console.error("Watch detection (ws) error:", e),
      );
    }
  }

  // ------------------------------------------------------------------
  // DOM MutationObserver (FALLBACK)
  // ------------------------------------------------------------------

  private async installDomObserver(page: Page): Promise<void> {
    if (!this.bridgeInstalled) {
      await page.exposeFunction(
        "__pwNotify",
        (detection: WatchDetection) => {
          this.handleDetection(
            { ...detection, source: "dom" },
            Date.now(),
          ).catch((err) =>
            console.error("❌ Watch detection (dom) handler error:", err),
          );
        },
      );
      this.bridgeInstalled = true;
    }

    await page.evaluate(() => {
      const w = window as any;
      if (w.__pwObserver) {
        try {
          w.__pwObserver.disconnect();
        } catch {}
      }
      const seen = new Set<string>();
      w.__pwSeen = seen;
      if (w.__pwSeenTimer) clearInterval(w.__pwSeenTimer);
      w.__pwSeenTimer = setInterval(() => {
        seen.clear();
      }, 30 * 1000);

      const extractRow = (row: Element): any | null => {
        try {
          const text = (row.textContent || "").trim();
          if (!text || text.length < 5) return null;

          if (!/X:\s*\d+/.test(text) || !/Y:\s*\d+/.test(text)) return null;
          if (!/S:\s*\d+/.test(text)) return null;

          let name = "";
          let alliance: string | undefined;
          const cells = Array.from(row.querySelectorAll("td, div")).slice(0, 50);
          for (const cell of cells) {
            const t = (cell.textContent || "").trim();
            if (t.length === 0 || t.length > 80) continue;
            const m = t.match(/^(.+?)\s*\[([A-Za-z0-9_]{1,10})\]\s*$/);
            if (m) {
              name = m[1].trim();
              alliance = m[2].trim();
              break;
            }
          }
          if (!name) {
            for (const cell of cells) {
              const t = (cell.textContent || "").trim();
              if (
                t.length > 0 &&
                t.length < 40 &&
                !t.includes("X:") &&
                !t.includes("Y:") &&
                !t.includes("S:") &&
                !/Lv\d+/.test(t) &&
                !/^K\d+/.test(t) &&
                cell.children.length <= 3
              ) {
                name = t;
                break;
              }
            }
          }
          if (!name) return null;

          let x: number | undefined;
          let y: number | undefined;
          const tooltipDivs = row.querySelectorAll("div[data-tooltip-id]");
          for (const div of Array.from(tooltipDivs)) {
            const tid = (div as any).getAttribute("data-tooltip-id") || "";
            const t = (div.textContent || "").trim();
            if (tid.includes("_x") && x === undefined) {
              const m = t.match(/X:\s*(\d+)/);
              if (m) x = parseInt(m[1]);
            }
            if (tid.includes("_y") && y === undefined) {
              const m = t.match(/Y:\s*(\d+)/);
              if (m) y = parseInt(m[1]);
            }
          }
          if (x === undefined) {
            const m = text.match(/X:\s*(\d+)/);
            if (m) x = parseInt(m[1]);
          }
          if (y === undefined) {
            const m = text.match(/Y:\s*(\d+)/);
            if (m) y = parseInt(m[1]);
          }

          let server: string | undefined;
          const sm = text.match(/S:\s*(\d+)/);
          if (sm) server = sm[1];

          let level: string | undefined;
          let keep: string | undefined;
          let power: string | undefined;
          const detail = text.match(/(K\d+)\s+(Lv\d+)\s+([\d.]+\s*[BMK])/);
          if (detail) {
            keep = detail[1];
            level = detail[2];
            power = detail[3].replace(/\s+/g, "");
          }

          return { name, alliance, power, level, keep, server, x, y };
        } catch {
          return null;
        }
      };

      const scan = () => {
        const rows = document.querySelectorAll("tr");
        rows.forEach((row) => {
          const data = extractRow(row);
          if (!data || !data.name) return;
          const key = `${data.name}|${data.x ?? "?"}|${data.y ?? "?"}|${data.server ?? "?"}`;
          if (seen.has(key)) return;
          seen.add(key);
          try {
            (window as any).__pwNotify(data);
          } catch (e) {}
        });
      };

      scan();

      const observer = new MutationObserver(() => {
        scan();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      w.__pwObserver = observer;
    });

    console.log("👀 Watch DOM observer installed (fallback)");
  }

  // ------------------------------------------------------------------
  // Detection -> Discord notification
  // ------------------------------------------------------------------

  private async handleDetection(
    detection: WatchDetection,
    receivedAt: number,
  ): Promise<void> {
    if (!this.state.active) return;
    if (!detection?.name) return;

    const nameLower = detection.name.toLowerCase();
    const matchedTarget = this.state.targetNames.find(
      (t) => nameLower === t || nameLower.includes(t) || t.includes(nameLower),
    );
    if (!matchedTarget) return;

    this.state.stats.matched++;

    const now = Date.now();
    const key = detection.name;
    const existing = this.state.spotted.get(key);

    if (existing && existing.notified && now - existing.lastSeenAt < this.LOST_GAP_MS) {
      existing.lastSeenAt = now;
      console.log(
        `🫧 [${this.nowTs()}] MATCH (suppressed): ${detection.name} - already spotted ${Math.floor((now - existing.lastSeenAt) / 1000)}s ago, skipping notification`,
      );
      return;
    }

    this.state.spotted.set(key, { lastSeenAt: now, notified: true });
    this.state.stats.notificationsSent++;
    console.log(
      `🫧 [${this.nowTs()}] MATCH: ${detection.name} (rule="${matchedTarget}", source=${detection.source}) → sending notification...`,
    );

    const send = this.state.channelSend;
    if (!send) return;

    const fields: { name: string; value: string; inline: boolean }[] = [];
    if (detection.alliance) {
      fields.push({
        name: "Alliance",
        value: `[${detection.alliance}]`,
        inline: true,
      });
    }
    if (detection.power) {
      fields.push({ name: "Power", value: detection.power, inline: true });
    }
    if (detection.keep) {
      fields.push({ name: "Keep", value: detection.keep, inline: true });
    }
    if (detection.level) {
      fields.push({ name: "Level", value: detection.level, inline: true });
    }
    if (detection.server) {
      fields.push({
        name: "Server",
        value: `S${detection.server}`,
        inline: true,
      });
    }
    if (detection.x !== undefined && detection.y !== undefined) {
      fields.push({
        name: "Coords",
        value: `X: \`${detection.x}\` Y: \`${detection.y}\``,
        inline: true,
      });
    }

    const embed = new EmbedBuilder()
      .setTitle(`🫧 Bubble Down: ${detection.name}`)
      .setDescription("Watched player's bubble has dropped.")
      .setColor(0x3498db)
      .addFields(fields)
      .setFooter({
        text: `Matched: ${matchedTarget} • via ${detection.source ?? "unknown"}`,
      })
      .setTimestamp();

    try {
      await send({ embeds: [embed] });
      const totalLatency = Date.now() - receivedAt;
      console.log(
        `🔔 [${this.nowTs()}] Notification SENT: ${detection.name} @ (${detection.x ?? "?"}, ${detection.y ?? "?"}) — total latency from WS frame: ${totalLatency}ms`,
      );
    } catch (err) {
      console.error("❌ Failed to send Watch notification:", err);
    }
  }
}

export const playerWatchService = new PlayerWatchService();
