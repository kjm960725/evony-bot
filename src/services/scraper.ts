// Puppeteer Scraper Service
import { Browser, Page } from "puppeteer";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { Coordinate } from "../types/coordinate";

// Stealth 플러그인 추가 (봇 감지 방지)
// sourceurl evasion은 CdpCDPSession.send를 hooking하는데, page session 종료 시
// stack trace에 노이즈를 만들고 일부 React event handling을 방해할 가능성이 있어 비활성화.
const stealth = StealthPlugin();
stealth.enabledEvasions.delete("sourceurl");
puppeteer.use(stealth);

class ScraperService {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private isLoggedIn: boolean = false;

  /**
   * Page 작업 직렬화 mutex.
   *
   * 배경: 스케줄러는 setInterval로 주기적 스크랩을 실행하지만, 이미 실행 중인 비동기 스크랩
   * promise는 scheduler.stop()으로 중단할 수 없음. 만약 Watch 명령이 스크랩 진행 중에 들어오면
   * 두 코드 경로가 동일한 puppeteer page를 동시에 조작하여 React state가 충돌해 click이 듣지 않음.
   *
   * 모든 public 페이지 작업(scrapeBarbarian/scrapePyramid/scrapeMonsters/applyWatchFilter)은
   * runQueued()로 감싸서 순차적으로만 실행되도록 강제.
   */
  private opQueue: Promise<unknown> = Promise.resolve();
  private opCount: number = 0;
  private currentOpName: string | null = null;

  /**
   * Watch 모드 잠금. true일 때 모든 일반 scrape 메서드(scrapeAll, scrapeBarbarian,
   * scrapePyramid, scrapeMonsters)는 즉시 빈 결과를 반환하여 no-op이 됨.
   * applyWatchFilter는 이 flag를 무시함.
   *
   * 효과: Watch 활성화 시 setWatchLock(true) 호출하면, in-flight scrapeAll의 다음 단계들이
   * 즉시 건너뛰어져서 Watch가 빠르게 페이지를 점유 가능.
   */
  private watchLockActive: boolean = false;

  setWatchLock(active: boolean): void {
    if (this.watchLockActive !== active) {
      this.watchLockActive = active;
      console.log(
        active
          ? "🔐 Scraper Watch lock ENABLED — Pyramid/Barbarian/Monsters scrapes will skip immediately"
          : "🔓 Scraper Watch lock DISABLED",
      );
    }
  }

  /**
   * 각 작업이 시작 시 알맞은 viewport로 재설정.
   *
   * 배경: 스크래핑은 큰 viewport(1920x10000)로 모든 행을 한 번에 렌더링해서 추출하는 게 유리.
   * 그러나 Watch의 click 작업은 큰 viewport에서 OS window 밖에 있는 요소를 클릭하면
   * Chromium이 React-aria/pointer 이벤트를 정상 처리하지 못하는 문제가 있음.
   * → Watch는 일반 viewport(1280x900) 사용, 일반 스크래핑은 큰 viewport 사용.
   */
  private async ensureViewport(
    mode: "scrape" | "watch-interactive",
  ): Promise<void> {
    if (!this.page) return;
    const target =
      mode === "scrape"
        ? { width: 1920, height: 10000 }
        : { width: 1280, height: 900 };
    const current = this.page.viewport();
    if (
      !current ||
      current.width !== target.width ||
      current.height !== target.height
    ) {
      await this.page.setViewport(target);
      console.log(
        `🖥️ Viewport set to ${target.width}x${target.height} (${mode})`,
      );
    }
  }

  isWatchLocked(): boolean {
    return this.watchLockActive;
  }

  /**
   * 진행 중인 puppeteer 페이지 작업을 강제로 중단시킨다.
   * page.goto('about:blank')를 호출하여 모든 pending puppeteer 작업을 reject시킴.
   * Watch가 즉시 페이지를 점유하고 싶을 때 사용.
   *
   * 주의: 이미 page가 닫혀있거나 navigation 중일 수 있음 - 모든 에러를 무시.
   */
  async forceInterruptPage(): Promise<void> {
    if (!this.page) return;
    try {
      if (this.page.isClosed()) {
        console.log("⚡ Page already closed - skipping interrupt");
        return;
      }
    } catch {
      return;
    }
    try {
      console.log("⚡ Force-interrupting current page operation (navigating to about:blank)...");
      await this.page.goto("about:blank", { waitUntil: "load", timeout: 5000 });
      console.log("⚡ Page interrupted");
    } catch (err) {
      console.log("⚡ forceInterruptPage error (likely safe to ignore):", (err as Error).message);
    }
  }

  /** 외부에서 page 작업이 진행 중인지 확인 */
  isBusy(): boolean {
    return this.opCount > 0;
  }

  /** 외부에서 진행 중인 page 작업을 확인하고 idle 될 때까지 대기 (최대 timeoutMs) */
  async waitForIdle(timeoutMs: number = 90_000): Promise<boolean> {
    const start = Date.now();
    let logged = false;
    while (this.opCount > 0 && Date.now() - start < timeoutMs) {
      if (!logged) {
        console.log(
          `   ⏳ Waiting for scraper to be idle (current op: ${this.currentOpName ?? "?"})...`,
        );
        logged = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return this.opCount === 0;
  }

  /**
   * 페이지 작업을 큐에 등록하여 직렬 실행.
   * 이전 작업이 끝난 뒤에야 fn이 실행됨. 에러는 fn 호출자에게 전파.
   */
  private async runQueued<T>(
    name: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.opQueue;
    let releaseSelf: () => void;
    const selfPromise = new Promise<void>((resolve) => {
      releaseSelf = resolve;
    });
    this.opQueue = selfPromise;
    this.opCount++;
    // 이전 작업의 에러는 무시하고 일단 끝나기만 기다림
    await previous.catch(() => {});

    this.currentOpName = name;
    try {
      return await fn();
    } finally {
      this.opCount--;
      if (this.currentOpName === name) this.currentOpName = null;
      releaseSelf!();
    }
  }

  // 환경 변수 getter (dotenv.config() 실행 후에 읽기 위해)
  private get ISCOUT_URL(): string {
    return process.env.ISCOUT_URL || "https://www.iscout.club/en";
  }

  private get ISCOUT_EMAIL(): string {
    return process.env.ISCOUT_EMAIL || "";
  }

  private get ISCOUT_PASSWORD(): string {
    return process.env.ISCOUT_PASSWORD || "";
  }

  // 브라우저 초기화
  async initialize(): Promise<void> {
    if (!this.browser) {
      console.log("🌐 Initializing Puppeteer browser...");
      console.log("   Platform:", process.platform, process.arch);

      try {
        const path = require("path");
        const fs = require("fs");

        // 설치된 Chrome 경로 찾기
        // 1. 환경 변수 우선 확인 (서버 배포용)
        let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || "";

        // 2. Linux ARM64 시스템에서 시스템 Chromium 사용
        if (
          !executablePath &&
          process.platform === "linux" &&
          process.arch === "arm64"
        ) {
          const systemChromePaths = [
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/google-chrome",
          ];
          for (const chromePath of systemChromePaths) {
            if (fs.existsSync(chromePath)) {
              executablePath = chromePath;
              console.log(
                "   Linux ARM64: Using system Chromium:",
                executablePath,
              );
              break;
            }
          }
        }

        // 3. 로컬 chrome 디렉토리 확인 (개발용)
        if (!executablePath) {
          const chromeDir = path.join(process.cwd(), "chrome");

          if (fs.existsSync(chromeDir)) {
            const versions = fs.readdirSync(chromeDir);
            if (versions.length > 0) {
              const latestVersion = versions.sort().reverse()[0];
              executablePath = path.join(
                chromeDir,
                latestVersion,
                "chrome-mac-arm64",
                "Google Chrome for Testing.app",
                "Contents",
                "MacOS",
                "Google Chrome for Testing",
              );
            }
          }
        }

        if (executablePath) {
          console.log("   Using Chrome:", executablePath);
        }

        // M1/M2 Mac 호환 설정
        const userDataDir = path.join(process.cwd(), "chrome-user-data");

        // Headless 모드 결정
        // 환경 변수로 명시적 제어 가능, 기본값은 Linux만 headless
        const isHeadless =
          process.env.PUPPETEER_HEADLESS === "true" ||
          (process.env.PUPPETEER_HEADLESS !== "false" &&
            process.platform === "linux");

        console.log(`   Headless mode: ${isHeadless ? "enabled" : "disabled"}`);

        this.browser = await puppeteer.launch({
          headless: isHeadless ? "new" : false, // 서버: headless, 로컬: 브라우저 창 표시
          executablePath: executablePath || undefined,
          userDataDir: userDataDir, // 세션/쿠키 저장 (캡차 우회용)
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled",
            "--disable-web-security",
            "--disable-features=IsolateOrigins,site-per-process",
          ],
        });
        console.log("✅ Browser initialized successfully");
      } catch (error) {
        console.error("❌ Failed to launch browser:", error);
        throw error;
      }

      // 페이지 생성 및 로그인
      await this.login();
    }
  }

  // iScout 로그인
  private async login(): Promise<void> {
    if (this.isLoggedIn) {
      console.log("✅ Already logged in");
      return;
    }

    if (!this.ISCOUT_EMAIL || !this.ISCOUT_PASSWORD) {
      throw new Error(
        "❌ ISCOUT_EMAIL and ISCOUT_PASSWORD must be set in .env file",
      );
    }

    try {
      console.log("🔐 Checking login status...");

      this.page = await this.browser!.newPage();

      // 초기 viewport는 일반 데스크톱 크기 (login UI에 적합)
      // 각 scrape/Watch 작업 시작 시 ensureViewport()로 적합한 크기로 재조정됨
      await this.page.setViewport({ width: 1280, height: 900 });

      // User agent 설정 (봇 감지 방지)
      await this.page.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      );

      // 타임아웃 설정
      this.page.setDefaultTimeout(60000);

      // 먼저 메인 페이지로 이동하여 이미 로그인되어 있는지 확인
      console.log("   Checking if already logged in...");
      await this.page.goto(`${this.ISCOUT_URL}/dashboard`, {
        waitUntil: "networkidle2",
      });

      const currentUrl = this.page.url();

      // 이미 대시보드에 있으면 로그인 성공
      if (currentUrl.includes("/dashboard")) {
        this.isLoggedIn = true;
        console.log("✅ Already logged in - session restored from saved data");
        return;
      }

      // 로그인 필요 - 로그인 페이지로 이동
      console.log("   Login required - navigating to login page...");
      console.log(`   Email: ${this.ISCOUT_EMAIL}`);
      await this.page.goto(`${this.ISCOUT_URL}/login`, {
        waitUntil: "networkidle2",
      });

      // 캡차 확인
      console.log("   Checking for Cloudflare challenge...");
      await this.page.waitForTimeout(2000);

      // @ts-ignore - Running in browser context
      const hasCaptcha = await this.page.evaluate(() => {
        return (
          document.body.textContent?.includes("Verify you are human") ||
          document.body.textContent?.includes("Cloudflare")
        );
      });

      if (hasCaptcha) {
        console.log("⚠️  Cloudflare challenge detected!");
        console.log(
          "   Please solve the captcha manually in the browser window.",
        );
        console.log("   Waiting up to 60 seconds for you to complete it...");

        // 캡차 해결 대기 (최대 60초)
        let attempts = 0;
        const maxAttempts = 60;

        while (attempts < maxAttempts) {
          await this.page.waitForTimeout(1000);
          attempts++;

          const currentUrl = this.page.url();
          // @ts-ignore - Running in browser context
          const stillHasCaptcha = await this.page.evaluate(() => {
            return (
              document.body.textContent?.includes("Verify you are human") ||
              document.body.textContent?.includes("Cloudflare")
            );
          });

          if (!stillHasCaptcha || currentUrl.includes("/login")) {
            console.log("✅ Captcha resolved!");
            break;
          }

          if (attempts % 10 === 0) {
            console.log(
              `   Still waiting... (${attempts}/${maxAttempts} seconds)`,
            );
          }
        }

        if (attempts >= maxAttempts) {
          throw new Error("Captcha resolution timeout - please try again");
        }
      }

      // 로그인 폼 대기
      console.log("   Waiting for login form...");
      await this.page.waitForSelector("#email", { timeout: 10000 });

      // 이메일 입력
      console.log("   Entering email...");
      await this.page.type("#email", this.ISCOUT_EMAIL, { delay: 100 });

      // 비밀번호 입력
      console.log("   Entering password...");
      await this.page.type("#password", this.ISCOUT_PASSWORD, { delay: 100 });

      // 로그인 버튼 클릭 및 네비게이션 대기
      console.log("   Clicking login button...");

      // @ts-ignore - Running in browser context
      // 폼 제출 또는 로그인 버튼 클릭
      await this.page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const loginButton = buttons.find(
          (btn: any) =>
            btn.textContent?.toLowerCase().includes("log in") ||
            btn.textContent?.toLowerCase().includes("login"),
        );
        if (loginButton) {
          (loginButton as any).click();
        } else {
          // 폴백: 폼 제출
          const form = document.querySelector("form");
          if (form) (form as any).submit();
        }
      });

      // 페이지 전환 대기 (최대 30초)
      console.log("   Waiting for redirect...");
      try {
        await this.page.waitForNavigation({
          waitUntil: "networkidle2",
          timeout: 30000,
        });
      } catch (navError) {
        console.log("   Navigation timeout - checking current URL...");
      }

      // 추가 대기 시간 (로딩 완료 확인)
      await this.page.waitForTimeout(3000);

      // 로그인 성공 확인 (dashboard URL로 리다이렉션 되었는지)
      const finalUrl = this.page.url();
      console.log(`   Current URL: ${finalUrl}`);

      if (finalUrl.includes("/dashboard")) {
        this.isLoggedIn = true;
        console.log("✅ Login successful - redirected to dashboard");
      } else if (finalUrl.includes("/login")) {
        // 여전히 로그인 페이지에 있음 - 오류 메시지 확인
        // @ts-ignore - Running in browser context
        const errorMessage = await this.page.evaluate(() => {
          const errorElement = document.querySelector(
            '.text-red-600, .text-danger, [class*="error"]',
          );
          return errorElement?.textContent?.trim() || "Unknown error";
        });

        await this.page.screenshot({
          path: "login-failed.png",
          fullPage: true,
        });
        throw new Error(`Login failed: ${errorMessage}`);
      } else {
        // 다른 페이지로 리다이렉션됨 - 로그인 성공으로 간주
        this.isLoggedIn = true;
        console.log("✅ Login successful - redirected to:", finalUrl);
      }
    } catch (error) {
      console.error("❌ Login failed:", error);

      // 에러 발생 시 디버그 정보 저장
      if (this.page) {
        try {
          await this.page.screenshot({
            path: "login-error.png",
            fullPage: true,
          });
          const html = await this.page.content();
          const fs = require("fs");
          fs.writeFileSync("login-error.html", html);
          console.log(
            "💾 Debug files saved: login-error.png, login-error.html",
          );
        } catch (debugError) {
          console.error("Failed to save debug files:", debugError);
        }
      }

      throw new Error("Failed to login to iScout");
    }
  }

  // 크롤링 전 준비 작업 (매번 실행)
  private async prepareForScraping(): Promise<void> {
    if (!this.page) {
      throw new Error("Page not initialized");
    }

    console.log("🔄 Preparing for scraping...");

    // URL 먼저 체크 → 상황에 맞는 단일 navigation만 수행 (불필요한 reload 제거)
    const currentUrl = this.page.url();
    console.log(`   Current URL: ${currentUrl}`);

    if (currentUrl.includes("/login")) {
      // 로그인 페이지 → 재로그인
      console.log("   ⚠️ Session expired - logging in again...");
      this.isLoggedIn = false;
      await this.login();
    } else if (
      currentUrl === "about:blank" ||
      currentUrl === "" ||
      !currentUrl.includes("iscout.club")
    ) {
      // about:blank 또는 외부 페이지 → 바로 dashboard로 (reload 안 함, 1번의 nav)
      console.log("   Page is blank/external - navigating directly to dashboard...");
      await this.page.goto(`${this.ISCOUT_URL}/dashboard`, {
        waitUntil: "networkidle2",
      });
      await this.page.waitForTimeout(2000);
    } else if (currentUrl.includes("/dashboard")) {
      // 이미 dashboard → reload 1번
      console.log("   Already on dashboard - refreshing page...");
      await this.page.reload({ waitUntil: "networkidle2" });
      await this.page.waitForTimeout(2000);
    } else {
      // 그 외 iscout 페이지 → dashboard로
      console.log("   Navigating to dashboard...");
      await this.page.goto(`${this.ISCOUT_URL}/dashboard`, {
        waitUntil: "networkidle2",
      });
      await this.page.waitForTimeout(2000);
    }

    console.log("✅ Ready to scrape");
  }

  // Watch 모드에서 사용: 외부 서비스가 동일 page에 옵저버 등을 설치할 수 있도록 노출
  async getPage(): Promise<Page | null> {
    return this.page;
  }

  // Watch 모드에서 사용: 페이지가 살아있고 로그인 상태인지 확인
  isReady(): boolean {
    return this.isLoggedIn && this.page !== null;
  }

  /**
   * Page가 죽었는지 빠르게 확인 (puppeteer page.isClosed() 또는 간단한 evaluate 시도).
   */
  async isPageAlive(): Promise<boolean> {
    if (!this.page) return false;
    try {
      if (this.page.isClosed()) return false;
      // 간단한 evaluate로 검증
      await this.page.evaluate(() => 1);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Page가 죽었으면 browser를 통째로 재시작하고 새 page로 로그인.
   * Watch가 cascade 실패 후 복구하기 위해 사용.
   */
  async recoverIfDead(): Promise<boolean> {
    if (await this.isPageAlive()) return true;
    console.log("⚠️ Page is dead - recovering by reinitializing browser...");
    try {
      if (this.page) {
        try {
          await this.page.close();
        } catch {}
        this.page = null;
      }
      if (this.browser) {
        try {
          await this.browser.close();
        } catch {}
        this.browser = null;
      }
      this.isLoggedIn = false;
      await this.initialize();
      console.log("✅ Browser recovered");
      return true;
    } catch (e) {
      console.error("❌ Failed to recover browser:", e);
      return false;
    }
  }

  // 브라우저 종료
  async close(): Promise<void> {
    if (this.page) {
      await this.page.close();
      this.page = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.isLoggedIn = false;
      console.log("🔒 Browser closed");
    }
  }

  // Puppeteer 네이티브 클릭으로 버튼 찾아 클릭 (합성 이벤트 대신 실제 마우스 이벤트 발생)
  private async clickButtonNative(
    matchFn: (text: string) => boolean,
  ): Promise<boolean> {
    const buttons = await this.page!.$$("button");
    for (const button of buttons) {
      const text = await button.evaluate((el) => el.textContent?.trim() || "");
      if (matchFn(text)) {
        await button.evaluate((el) =>
          el.scrollIntoView({ block: "center", inline: "nearest" }),
        );
        await this.page!.waitForTimeout(500);
        await button.click();
        return true;
      }
    }
    return false;
  }

  // 일반 요소를 텍스트로 찾아 네이티브 클릭
  private async clickElementByText(
    selector: string,
    textMatch: string,
  ): Promise<boolean> {
    const elements = await this.page!.$$(selector);
    for (const el of elements) {
      const text = await el.evaluate((node) => node.textContent?.trim() || "");
      if (text.includes(textMatch)) {
        await el.evaluate((node) =>
          (node as HTMLElement).scrollIntoView({
            block: "center",
            inline: "nearest",
          }),
        );
        await this.page!.waitForTimeout(500);
        await el.click();
        return true;
      }
    }
    return false;
  }

  /**
   * 아코디언 섹션 헤더(div)를 텍스트로 찾아 마우스 클릭.
   *
   * iScout UI의 필터 섹션(Monsters, Resources, Relics/Pyramids, Arctic Barbarians 등)은
   * <button>이 아닌 <div> 아코디언 헤더로 구현됨.
   * clickButtonNative / clickElementByText는 부모 컨테이너를 잘못 클릭할 수 있으므로
   * 가장 작은(leaf에 가까운) 매칭 요소를 찾아 스크롤 후 mouse.click으로 정확히 클릭.
   */
  private async clickSectionHeader(headerText: string): Promise<boolean> {
    // 1) 해당 텍스트를 포함하는 가장 작은 요소를 스크롤 into view
    const scrolled = await this.page!.evaluate((text: string) => {
      const allEls = Array.from(document.querySelectorAll("div, span, p"));
      let best: { el: Element; area: number } | null = null;

      for (const el of allEls) {
        const content = (el.textContent || "").trim();
        if (!content.includes(text)) continue;

        const rect = (el as HTMLElement).getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        const area = rect.width * rect.height;
        if (!best || area < best.area) {
          best = { el, area };
        }
      }

      if (best) {
        (best.el as HTMLElement).scrollIntoView({
          block: "center",
          inline: "nearest",
        });
        return true;
      }
      return false;
    }, headerText);

    if (!scrolled) return false;
    await this.page!.waitForTimeout(500);

    // 2) 스크롤 후 다시 좌표를 구해 마우스 클릭
    const pos = await this.page!.evaluate((text: string) => {
      const allEls = Array.from(document.querySelectorAll("div, span, p"));
      let best: { x: number; y: number; area: number } | null = null;

      for (const el of allEls) {
        const content = (el.textContent || "").trim();
        if (!content.includes(text)) continue;

        const rect = (el as HTMLElement).getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        const area = rect.width * rect.height;
        if (!best || area < best.area) {
          best = {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            area,
          };
        }
      }
      return best;
    }, headerText);

    if (pos) {
      await this.page!.mouse.click(pos.x, pos.y);
      return true;
    }
    return false;
  }

  /**
   * Presets list → EvonyBot 선택.
   *
   * 근본 원인: menuitem은 [텍스트 div] + [X 삭제 버튼] 구조.
   * menuitem 중앙을 클릭하면 X 버튼 영역에 해당하여 프리셋이 로드되지 않음.
   * menuitem 내부의 텍스트 div를 직접 찾아 클릭해야 프리셋이 적용됨.
   */
  private async selectEvonyBotPreset(): Promise<boolean> {
    console.log('   Clicking "Presets list" button...');
    const presetsListClicked = await this.clickButtonNative((text) =>
      text.includes("Presets list"),
    );

    if (presetsListClicked) {
      console.log('   ✅ "Presets list" button clicked');
      await this.page!.waitForTimeout(2000);
    } else {
      console.log('   ⚠️ "Presets list" button not found');
      await this.page!.screenshot({
        path: "debug-presets-button.png",
        fullPage: true,
      });
      return false;
    }

    console.log('   Selecting "EvonyBot" preset from dropdown...');
    try {
      await this.page!.waitForSelector('[role="menuitem"]', { timeout: 8000 });
    } catch {
      console.log("   ⚠️ Dropdown menu did not appear");
      await this.page!.screenshot({
        path: "debug-preset-dropdown.png",
        fullPage: true,
      });
      return false;
    }

    // menuitem을 뷰포트로 스크롤 후 딜레이
    const menuitem = await this.page!.$('[role="menuitem"]');
    if (menuitem) {
      await menuitem.evaluate((el) =>
        el.scrollIntoView({ block: "center", inline: "nearest" }),
      );
      await this.page!.waitForTimeout(500);
    }

    // menuitem 내부의 "텍스트 전용 div/span"을 찾아 클릭 (X 삭제 버튼 회피)
    const clicked = await this.page!.evaluate(() => {
      const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
      for (const item of items) {
        const full = (item.textContent || "").trim();
        if (!/EvonyBot|Evony Bot|evonybot/i.test(full)) continue;

        const children = Array.from(item.querySelectorAll("div, span, p"));
        for (const child of children) {
          const t = (child.textContent || "").trim();
          if (t === "EvonyBot" || t === "Evony Bot" || t === "evonybot") {
            const r = (child as HTMLElement).getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
        }
      }
      return null;
    });

    if (clicked) {
      await this.page!.mouse.click(clicked.x, clicked.y);
      console.log('   ✅ "EvonyBot" preset text clicked');
      await this.page!.waitForTimeout(2500);
      return true;
    }

    console.log('   ⚠️ "EvonyBot" preset text element not found');
    await this.page!.screenshot({
      path: "debug-preset-dropdown.png",
      fullPage: true,
    });
    return false;
  }

  /**
   * 테이블의 "List : N" 버튼을 클릭하여 페이지당 행 수를 100으로 변경.
   * iScout UI: 버튼 텍스트 "List : 25" → 클릭 → 드롭다운 25/50/100 → "100" 클릭.
   */
  private async setRowsPerPage100(): Promise<void> {
    console.log("   Setting rows per page to 100...");

    // "List : N" 버튼 찾아서 JS click
    const btnInfo = await this.page!.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const btn = buttons.find((b) =>
        /List\s*:\s*\d+/.test(b.textContent?.trim() || ""),
      );
      if (!btn) return null;
      const text = btn.textContent?.trim() || "";
      if (text.includes("100")) return { text, alreadyMax: true };
      btn.click();
      return { text, alreadyMax: false };
    });

    if (!btnInfo) {
      console.log("   ⚠️ 'List : N' button not found");
      return;
    }

    if (btnInfo.alreadyMax) {
      console.log("   ✅ Already set to 100");
      return;
    }

    console.log(`   Current: "${btnInfo.text}", changing to 100...`);
    await this.page!.waitForTimeout(5000);

    // 드롭다운에서 "100" JS click (leaf 노드 중 텍스트가 정확히 "100"인 것)
    const selected = await this.page!.evaluate(() => {
      const allEls = Array.from(document.querySelectorAll("*"));
      for (const el of allEls) {
        const text = (el.textContent || "").trim();
        if (text === "100" && el.children.length === 0) {
          (el as HTMLElement).click();
          return { tag: el.tagName, cls: el.className };
        }
      }
      return null;
    });

    if (selected) {
      console.log(
        `   ✅ Selected 100 rows per page (${selected.tag}.${selected.cls})`,
      );
      console.log("   Waiting 10 seconds for table reload...");
      await this.page!.waitForTimeout(10000);
    } else {
      console.log("   ⚠️ '100' option not found in dropdown");
      // 디버그: 버튼 다시 클릭하고 DOM 트리 출력
      await this.page!.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const btn = buttons.find((b) =>
          /List\s*:\s*\d+/.test(b.textContent?.trim() || ""),
        );
        btn?.click();
      });
      await this.page!.waitForTimeout(1000);
      const debug = await this.page!.evaluate(() => {
        const allEls = Array.from(document.querySelectorAll("*"));
        return allEls
          .filter((el) => {
            const t = (el.textContent || "").trim();
            return (
              (t === "25" || t === "50" || t === "100") &&
              el.children.length === 0
            );
          })
          .map((el) => ({
            tag: el.tagName,
            cls: (el.className || "").substring(0, 80),
            text: (el.textContent || "").trim(),
            visible: (el as HTMLElement).offsetParent !== null,
          }));
      });
      console.log("   📋 Dropdown candidates:", JSON.stringify(debug));
    }
  }

  // Apply 버튼 클릭 및 결과 대기
  private async clickApplyAndWait(): Promise<boolean> {
    console.log('   Clicking "Apply" button...');
    const applyClicked = await this.clickButtonNative((text) =>
      text.toLowerCase().includes("apply"),
    );

    if (applyClicked) {
      console.log('   ✅ "Apply" button clicked');
      console.log("   Waiting 15 seconds for results to load...");
      await this.page!.waitForTimeout(15000);

      // 페이지당 행 수를 100으로 변경 (커스텀 드롭다운 대응)
      await this.setRowsPerPage100();

      const rowCount = await this.page!.evaluate(
        () => document.querySelectorAll("tr").length,
      );
      console.log(`   📋 Table rows in DOM: ${rowCount}`);
      return true;
    } else {
      console.log('   ⚠️ "Apply" button not found');
      await this.page!.screenshot({
        path: "debug-apply-button.png",
        fullPage: true,
      });
      return false;
    }
  }

  // 바바리안 좌표 크롤링
  async scrapeBarbarian(): Promise<Coordinate[]> {
    if (this.watchLockActive) {
      console.log("⏭️ scrapeBarbarian skipped (Watch lock active)");
      return [];
    }
    return this.runQueued("scrapeBarbarian", () => this._scrapeBarbarianImpl());
  }

  private async _scrapeBarbarianImpl(): Promise<Coordinate[]> {
    console.log("🗡️ Scraping Barbarian coordinates...");

    await this.initialize();
    await this.recoverIfDead();
    await this.ensureViewport("scrape");
    await this.prepareForScraping(); // 매번 새로고침 + 로그인 확인 + List 버튼 클릭

    try {
      // 1-2. EvonyBot 프리셋 선택 (네이티브 클릭)
      await this.selectEvonyBotPreset();

      // 3. "Arctic Barbarians" 섹션 헤더 클릭 (아코디언 <div> 헤더)
      console.log('   Clicking "Arctic Barbarians" section header...');
      const arcticBarbarianClicked =
        await this.clickSectionHeader("Arctic Barbarians");

      if (arcticBarbarianClicked) {
        console.log('   ✅ "Arctic Barbarians" section header clicked');
        await this.page!.waitForTimeout(1000);
      } else {
        console.log('   ⚠️ "Arctic Barbarians" section header not found');
        await this.page!.screenshot({
          path: "debug-barbarian-buttons.png",
          fullPage: true,
        });
      }

      // 4. Apply 클릭 및 결과 대기
      await this.clickApplyAndWait();

      // 5. 좌표 데이터 추출 (뷰포트 10000px로 모든 행이 DOM에 렌더링됨)
      console.log("   Extracting coordinates from table...");
      const coordinates = await this.page!.evaluate(() => {
        const results: any[] = [];
        const rows = document.querySelectorAll("tr");
        rows.forEach((row: any) => {
          try {
            const itemDiv = row.querySelector(
              'div[data-tooltip-id*="clickboard_data"]',
            );
            const itemText = itemDiv?.textContent?.trim() || "";
            if (!itemText.includes("Barbarian")) return;

            let xMatch = null;
            let yMatch = null;
            const allDivs = row.querySelectorAll("div[data-tooltip-id]");
            for (const div of allDivs) {
              const tooltipId =
                (div as any).getAttribute("data-tooltip-id") || "";
              const divText = (div as any).textContent?.trim() || "";
              if (tooltipId.includes("_x") && !xMatch) {
                const test = divText.match(/X:\s*(\d+)/);
                if (test) xMatch = test;
              }
              if (tooltipId.includes("_y") && !yMatch) {
                const test = divText.match(/Y:\s*(\d+)/);
                if (test) yMatch = test;
              }
              if (xMatch && yMatch) break;
            }
            if (!xMatch || !yMatch) return;

            const x = parseInt(xMatch[1]);
            const y = parseInt(yMatch[1]);
            const levelMatch =
              itemText.match(/Lv(\d+)/i) || itemText.match(/Level\s*(\d+)/i);
            const level = levelMatch ? parseInt(levelMatch[1]) : 0;
            if (level !== 5 && level !== 6 && level !== 7) return;

            let power = undefined;
            const cells = row.querySelectorAll("td, div");
            for (const cell of cells) {
              const cellText = (cell as any).textContent?.trim() || "";
              const powerMatch = cellText.match(/([0-9.]+)\s*([MB])/i);
              if (powerMatch) {
                const numValue = parseFloat(powerMatch[1]);
                const unit = powerMatch[2].toUpperCase();
                if (!isNaN(numValue) && numValue > 0) {
                  power =
                    unit === "M"
                      ? Math.round(numValue * 1000000)
                      : Math.round(numValue * 1000000000);
                  break;
                }
              }
            }

            const allianceDiv = row.querySelector(
              '[data-tooltip-id*="alliance"]',
            );
            const alliance = allianceDiv?.textContent?.trim() || undefined;

            results.push({
              x,
              y,
              level,
              power,
              alliance,
              timestamp: new Date().toISOString(),
            });
          } catch (e) {}
        });
        return results;
      });

      console.log(
        `✅ Found ${coordinates.length} Barbarian coordinates (Lv5, Lv6, Lv7 only)`,
      );
      return coordinates;
    } catch (error) {
      console.error("❌ Barbarian scraping failed:", error);

      // 에러 발생 시 디버그 정보 저장
      if (this.page) {
        await this.page.screenshot({
          path: "barbarian-error.png",
          fullPage: true,
        });
        console.log("   💾 Error screenshot saved: barbarian-error.png");
      }

      console.log("⚠️ Returning empty array (no mock data)");
      return [];
    }
  }

  // Monsters 크롤링 (Ares + Witch + Goblin 통합)
  // 프리셋에 Golden Goblin, Mysterious Witch, Ares Statue가 함께 설정됨
  async scrapeMonsters(): Promise<{
    ares: Coordinate[];
    witch: Coordinate[];
    goblin: Coordinate[];
  }> {
    if (this.watchLockActive) {
      console.log("⏭️ scrapeMonsters skipped (Watch lock active)");
      return { ares: [], witch: [], goblin: [] };
    }
    return this.runQueued("scrapeMonsters", () => this._scrapeMonstersImpl());
  }

  private async _scrapeMonstersImpl(): Promise<{
    ares: Coordinate[];
    witch: Coordinate[];
    goblin: Coordinate[];
  }> {
    console.log("👾 Scraping Monsters (Ares + Witch + Goblin)...");

    await this.initialize();
    await this.recoverIfDead();
    await this.ensureViewport("scrape");
    await this.prepareForScraping();

    try {
      await this.selectEvonyBotPreset();
      await this.clickApplyAndWait();

      console.log("   Extracting monster coordinates from table...");
      const result = await this.page!.evaluate(() => {
        const ares: any[] = [];
        const witch: any[] = [];
        const goblin: any[] = [];
        const rows = document.querySelectorAll("tr");
        rows.forEach((row: any) => {
          try {
            const itemDiv = row.querySelector(
              'div[data-tooltip-id*="clickboard_data"]',
            );
            const itemText = itemDiv?.textContent?.trim() || "";
            if (!itemText) return;

            let targetArray: any[] | null = null;
            if (itemText.includes("Ares") || itemText.includes("ares")) {
              targetArray = ares;
            } else if (itemText.includes("Witch")) {
              targetArray = witch;
            } else if (itemText.includes("Goblin")) {
              targetArray = goblin;
            }
            if (!targetArray) return;

            let xMatch = null;
            let yMatch = null;
            const allDivs = row.querySelectorAll("div[data-tooltip-id]");
            for (const div of allDivs) {
              const tooltipId =
                (div as any).getAttribute("data-tooltip-id") || "";
              const divText = (div as any).textContent?.trim() || "";
              if (tooltipId.includes("_x") && !xMatch) {
                const test = divText.match(/X:\s*(\d+)/);
                if (test) xMatch = test;
              }
              if (tooltipId.includes("_y") && !yMatch) {
                const test = divText.match(/Y:\s*(\d+)/);
                if (test) yMatch = test;
              }
              if (xMatch && yMatch) break;
            }

            if (xMatch && yMatch) {
              const x = parseInt(xMatch[1]);
              const y = parseInt(yMatch[1]);
              const levelMatch =
                itemText.match(/Lv(\d+)/i) || itemText.match(/Level\s*(\d+)/i);
              const level = levelMatch ? parseInt(levelMatch[1]) : 0;
              targetArray.push({
                x,
                y,
                level,
                timestamp: new Date().toISOString(),
              });
            }
          } catch (e) {}
        });
        return { ares, witch, goblin };
      });

      console.log(
        `✅ Monsters scrape done — Ares: ${result.ares.length}, Witch: ${result.witch.length}, Goblin: ${result.goblin.length}`,
      );
      return result;
    } catch (error) {
      console.error("❌ Monsters scraping failed:", error);

      if (this.page) {
        await this.page.screenshot({
          path: "monsters-error.png",
          fullPage: true,
        });
        console.log("   💾 Error screenshot saved: monsters-error.png");
      }

      return { ares: [], witch: [], goblin: [] };
    }
  }

  // 피라미드 좌표 크롤링
  async scrapePyramid(): Promise<Coordinate[]> {
    if (this.watchLockActive) {
      console.log("⏭️ scrapePyramid skipped (Watch lock active)");
      return [];
    }
    return this.runQueued("scrapePyramid", () => this._scrapePyramidImpl());
  }

  private async _scrapePyramidImpl(): Promise<Coordinate[]> {
    console.log("🔺 Scraping Pyramid coordinates...");

    await this.initialize();
    await this.recoverIfDead();
    await this.ensureViewport("scrape");
    await this.prepareForScraping(); // 매번 새로고침 + 로그인 확인 + List 버튼 클릭

    try {
      // 1-2. EvonyBot 프리셋 선택 (네이티브 클릭)
      await this.selectEvonyBotPreset();

      // 3. "Relics/Pyramids" 섹션 헤더 클릭 (아코디언 <div> 헤더)
      console.log('   Clicking "Relics/Pyramids" section header...');
      const relicsPyramidsClicked = await this.clickSectionHeader(
        "Relics/Pyramids",
      );

      if (relicsPyramidsClicked) {
        console.log('   ✅ "Relics/Pyramids" section header clicked');
        await this.page!.waitForTimeout(1000);
      } else {
        console.log('   ⚠️ "Relics/Pyramids" section header not found');
        await this.page!.screenshot({
          path: "debug-pyramid-buttons.png",
          fullPage: true,
        });
      }

      // 4. Apply 클릭 및 결과 대기
      await this.clickApplyAndWait();

      // 5. 좌표 데이터 추출 (뷰포트 10000px로 모든 행이 DOM에 렌더링됨)
      console.log("   Extracting coordinates from table...");
      const debugInfo = await this.page!.evaluate(() => {
        const rows = document.querySelectorAll("tr");
        const firstRowTexts: string[] = [];
        for (let i = 0; i < Math.min(rows.length, 3); i++) {
          firstRowTexts.push(
            (rows[i].textContent || "").trim().substring(0, 120),
          );
        }
        return {
          trCount: rows.length,
          firstRows: firstRowTexts,
          pageUrl: window.location.href,
        };
      });
      console.log(`   📋 Debug: ${debugInfo.trCount} <tr> elements found`);
      console.log(`   📋 Debug: URL = ${debugInfo.pageUrl}`);
      if (debugInfo.firstRows.length > 0) {
        console.log(
          `   📋 Debug: First row text = "${debugInfo.firstRows[0]}"`,
        );
      }

      const coordinates = await this.page!.evaluate(() => {
        const results: any[] = [];
        const rows = document.querySelectorAll("tr");
        rows.forEach((row: any) => {
          try {
            const itemDiv = row.querySelector(
              'div[data-tooltip-id*="clickboard_data"]',
            );
            const itemText = itemDiv?.textContent?.trim() || "";
            if (!itemText.includes("Pyramid")) return;

            let xMatch = null;
            let yMatch = null;
            const allDivs = row.querySelectorAll("div[data-tooltip-id]");
            for (const div of allDivs) {
              const tooltipId =
                (div as any).getAttribute("data-tooltip-id") || "";
              const divText = (div as any).textContent?.trim() || "";
              if (tooltipId.includes("_x") && !xMatch) {
                const test = divText.match(/X:\s*(\d+)/);
                if (test) xMatch = test;
              }
              if (tooltipId.includes("_y") && !yMatch) {
                const test = divText.match(/Y:\s*(\d+)/);
                if (test) yMatch = test;
              }
              if (xMatch && yMatch) break;
            }
            if (!xMatch || !yMatch) return;

            const x = parseInt(xMatch[1]);
            const y = parseInt(yMatch[1]);
            const levelMatch = itemText.match(/Lv(\d+)/);
            const level = levelMatch ? parseInt(levelMatch[1]) : 0;
            if (level !== 4 && level !== 5) return;

            results.push({ x, y, level, timestamp: new Date().toISOString() });
          } catch (e) {}
        });
        return results;
      });

      console.log(
        `✅ Found ${coordinates.length} Pyramid coordinates (Lv4, Lv5 only)`,
      );
      return coordinates;
    } catch (error) {
      console.error("❌ Pyramid scraping failed:", error);

      // 에러 발생 시 디버그 정보 저장
      if (this.page) {
        await this.page.screenshot({
          path: "pyramid-error.png",
          fullPage: true,
        });
        console.log("   💾 Error screenshot saved: pyramid-error.png");
      }

      console.log("⚠️ Returning empty array (no mock data)");
      return [];
    }
  }

  /**
   * Watch 모드 전용 Players 아코디언 열기 - multi-strategy 버전.
   *
   * 이전 시도들의 교훈:
   *  - 가장 작은 SPAN(area=764)만 클릭: 핸들러에 닿지 않음
   *  - 가장 큰 ancestor(area=42048)만 클릭: 진짜 핸들러는 중간 wrapper에 있을 수 있어 실패
   *  - JS click()과 mouse.click 모두 실패하기도 함 (pointerdown 핸들러 가능성)
   *
   * 새 접근:
   *  1) inner SPAN → ancestor 체인을 모두 후보로 마킹 (textContent === "Players" 유지되는 동안)
   *  2) 각 후보에 대해 작은 것부터 큰 것까지 ElementHandle.click()를 순차 시도 (CDP 기반 진짜 입력)
   *  3) 모두 실패하면 pointerdown/mousedown/mouseup/click 합성 이벤트 시퀀스 dispatch
   *  4) 그래도 실패하면 focus + Enter / Space 키보드 활성화
   *  5) 각 시도 후 input[name="power"]가 visible 되면 즉시 성공
   */
  private async openPlayersSection(): Promise<boolean> {
    if (await this.isPlayersSectionOpen()) {
      console.log("   ℹ️ Players section appears to be already open");
      return true;
    }

    const setup = await this.page!.evaluate(() => {
      const all = Array.from(document.querySelectorAll("*")) as HTMLElement[];
      let inner: HTMLElement | null = null;
      let innerArea = Infinity;
      for (const el of all) {
        const text = (el.textContent || "").trim();
        if (text !== "Players") continue;
        if (el.offsetParent === null) continue;
        const cs = window.getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const area = r.width * r.height;
        if (area < innerArea) {
          inner = el;
          innerArea = area;
        }
      }
      if (!inner) return { found: false, count: 0, info: [] as any[] };

      const chain: HTMLElement[] = [inner];
      let cur: HTMLElement | null = inner.parentElement;
      while (cur && chain.length < 10) {
        const t = (cur.textContent || "").trim();
        if (t !== "Players") break;
        chain.push(cur);
        cur = cur.parentElement;
      }

      chain.forEach((el, i) => el.setAttribute("data-pw-cand", String(i)));
      return {
        found: true,
        count: chain.length,
        info: chain.map((el) => {
          const r = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            cls: (el.className || "").toString().substring(0, 60),
            area: Math.round(r.width * r.height),
          };
        }),
      };
    });

    if (!setup.found) {
      console.log("   ⚠️ Players element not found in DOM");
      return false;
    }

    const chainStr = setup.info
      .map((c: any) => `<${c.tag}.${c.cls || "_"}|${c.area}>`)
      .join(" → ");
    console.log(`   📋 Click chain (inner→outer): ${chainStr}`);

    // Strategy A: ElementHandle.click() (CDP 기반 trusted input)
    for (let i = 0; i < setup.count; i++) {
      const handle = await this.page!.$(`[data-pw-cand="${i}"]`);
      if (!handle) continue;
      try {
        await handle.evaluate((el: any) =>
          el.scrollIntoView({ block: "center", inline: "nearest" }),
        );
        await this.page!.waitForTimeout(150);
        await handle.click({ delay: 30 });
      } catch (e) {
        console.log(
          `     candidate #${i} (${setup.info[i].tag}) handle.click error: ${(e as Error).message}`,
        );
        await handle.dispose().catch(() => {});
        continue;
      }
      await handle.dispose().catch(() => {});

      if (await this.waitForPlayersInputs(1500)) {
        console.log(
          `   ✅ Players opened: candidate #${i} <${setup.info[i].tag}> area=${setup.info[i].area} (handle.click)`,
        );
        await this.cleanupWatchCandidates();
        return true;
      }
    }

    // Strategy B: 합성 pointer/mouse 이벤트 시퀀스 (inner SPAN 대상)
    console.log(
      "   ↻ ElementHandle.click() failed for all; trying synthetic pointer events on inner...",
    );
    const dispatched = await this.page!.evaluate(() => {
      const inner = document.querySelector(
        '[data-pw-cand="0"]',
      ) as HTMLElement | null;
      if (!inner) return false;
      inner.scrollIntoView({ block: "center" });
      const r = inner.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const init: any = {
        view: window,
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: 1,
      };
      try {
        inner.dispatchEvent(
          new PointerEvent("pointerdown", {
            ...init,
            pointerType: "mouse",
            pointerId: 1,
            isPrimary: true,
          }),
        );
      } catch {}
      inner.dispatchEvent(new MouseEvent("mousedown", init));
      try {
        inner.dispatchEvent(
          new PointerEvent("pointerup", {
            ...init,
            pointerType: "mouse",
            pointerId: 1,
            isPrimary: true,
          }),
        );
      } catch {}
      inner.dispatchEvent(new MouseEvent("mouseup", init));
      inner.dispatchEvent(new MouseEvent("click", init));
      return true;
    });

    if (dispatched && (await this.waitForPlayersInputs(1500))) {
      console.log("   ✅ Players opened via synthetic pointer/mouse events");
      await this.cleanupWatchCandidates();
      return true;
    }

    // Strategy C: 키보드 Enter/Space (focus 후)
    console.log("   ↻ Synthetic events failed; trying keyboard Enter/Space...");
    for (let i = 0; i < setup.count; i++) {
      // Enter
      let handle = await this.page!.$(`[data-pw-cand="${i}"]`);
      if (handle) {
        try {
          await handle.focus();
          await this.page!.keyboard.press("Enter");
        } catch {}
        await handle.dispose().catch(() => {});
        if (await this.waitForPlayersInputs(800)) {
          console.log(`   ✅ Players opened by Enter on candidate #${i}`);
          await this.cleanupWatchCandidates();
          return true;
        }
      }
      // Space
      handle = await this.page!.$(`[data-pw-cand="${i}"]`);
      if (handle) {
        try {
          await handle.focus();
          await this.page!.keyboard.press("Space");
        } catch {}
        await handle.dispose().catch(() => {});
        if (await this.waitForPlayersInputs(800)) {
          console.log(`   ✅ Players opened by Space on candidate #${i}`);
          await this.cleanupWatchCandidates();
          return true;
        }
      }
    }

    await this.cleanupWatchCandidates();

    // Strategy D: "Find available filters" 콤보박스를 통한 우회
    // 아코디언 헤더 click이 모두 실패해도, 페이지 우상단의 검색 콤보박스로 Players 활성화 가능
    console.log("   ↻ All header click strategies failed; trying 'Find available filters' combobox fallback...");
    if (await this.openPlayersViaFindFiltersCombobox()) {
      return true;
    }

    console.log("   ⚠️ All strategies (handle.click + synthetic + keyboard + combobox) failed");
    // Screenshot은 try/catch — 실패한 page 상태에서 호출 시 session close cascade 방지
    try {
      await this.page!.screenshot({
        path: "debug-watch-open-failed.png",
        fullPage: true,
      });
    } catch (e) {
      console.log(
        `   (could not save debug screenshot: ${(e as Error).message})`,
      );
    }
    return false;
  }

  /**
   * 마지막 폴백: 페이지 우상단의 "Find available filters" 콤보박스를 사용해 Players 활성화.
   * 1) combobox click (열기)
   * 2) "Players" 옵션 click
   * 3) 인풋 visible 대기
   */
  private async openPlayersViaFindFiltersCombobox(): Promise<boolean> {
    try {
      // 1) combobox 자체를 클릭해서 dropdown 열기
      const opened = await this.page!.evaluate(() => {
        // input[placeholder="Find available filters"] 또는 [aria-label*="Find available"] 후보
        const inputs = Array.from(
          document.querySelectorAll(
            'input[placeholder*="Find available filters"], [role="combobox"]',
          ),
        ) as HTMLElement[];
        for (const el of inputs) {
          const placeholder = (el as HTMLInputElement).placeholder || "";
          const ariaLabel = el.getAttribute("aria-label") || "";
          if (
            placeholder.includes("Find available filters") ||
            ariaLabel.includes("Find available filters") ||
            placeholder.toLowerCase().includes("find") ||
            ariaLabel.toLowerCase().includes("find")
          ) {
            if ((el as HTMLElement).offsetParent === null) continue;
            (el as HTMLElement).scrollIntoView({ block: "center" });
            (el as HTMLElement).focus();
            (el as HTMLElement).click();
            return true;
          }
        }
        return false;
      });

      if (!opened) {
        console.log("   ⚠️ 'Find available filters' combobox not found");
        return false;
      }
      console.log("   ✅ 'Find available filters' combobox clicked");
      await this.page!.waitForTimeout(800);

      // 2) "Players" 옵션이 dropdown에 보이는지 확인 후 클릭
      const selected = await this.page!.evaluate(() => {
        // 다양한 dropdown 마크업 대응
        const opts = Array.from(
          document.querySelectorAll(
            '[role="option"], [role="menuitem"], li, button, div',
          ),
        ) as HTMLElement[];
        // 보이는 요소 중 textContent가 정확히 "Players"인 것
        const visibleMatches = opts.filter((el) => {
          const t = (el.textContent || "").trim();
          if (t !== "Players") return false;
          if (el.offsetParent === null) return false;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          // 작은 dropdown 옵션 사이즈 (10000 이하 area)
          return r.width * r.height < 10000;
        });
        if (visibleMatches.length === 0) return false;
        // 가장 작은 (innermost) 옵션 클릭
        visibleMatches.sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return ra.width * ra.height - rb.width * rb.height;
        });
        visibleMatches[0].click();
        return true;
      });

      if (!selected) {
        console.log("   ⚠️ 'Players' option not found in combobox dropdown");
        return false;
      }
      console.log("   ✅ 'Players' option selected from combobox");

      // 3) 인풋이 visible 될 때까지 대기
      if (await this.waitForPlayersInputs(4000)) {
        console.log("   ✅ Players opened via combobox fallback");
        return true;
      }
      console.log("   ⚠️ Combobox option clicked but Players inputs did not appear");
      return false;
    } catch (err) {
      console.log("   ⚠️ Combobox fallback error:", (err as Error).message);
      return false;
    }
  }

  private async isPlayersSectionOpen(): Promise<boolean> {
    return this.page!.evaluate(() =>
      Array.from(document.querySelectorAll('input[name="power"]')).some(
        (el) => (el as HTMLElement).offsetParent !== null,
      ),
    );
  }

  private async waitForPlayersInputs(timeoutMs: number): Promise<boolean> {
    try {
      await this.page!.waitForFunction(
        () =>
          Array.from(document.querySelectorAll('input[name="power"]')).some(
            (el) => (el as HTMLElement).offsetParent !== null,
          ),
        { timeout: timeoutMs },
      );
      return true;
    } catch {
      return false;
    }
  }

  private async cleanupWatchCandidates(): Promise<void> {
    await this.page!.evaluate(() => {
      document
        .querySelectorAll("[data-pw-cand]")
        .forEach((el) => el.removeAttribute("data-pw-cand"));
    }).catch(() => {});
  }

  /**
   * Watch 모드용: Players 섹션 열기 + Power 범위 설정 + Bubble=No 보장 + Apply.
   *
   * 호출 후에는 page가 Players 결과 화면에 머무르며, iScout 백엔드가 자동 스캔하여
   * WebSocket으로 새 결과를 push하면 DOM이 갱신됨.
   * 외부에서 MutationObserver를 설치하여 실시간 알림에 활용.
   */
  async applyWatchFilter(minPower: number, maxPower: number): Promise<void> {
    return this.runQueued("applyWatchFilter", () =>
      this._applyWatchFilterImpl(minPower, maxPower),
    );
  }

  private async _applyWatchFilterImpl(
    minPower: number,
    maxPower: number,
  ): Promise<void> {
    await this.initialize();
    // 이전 Watch/scrape 시도에서 page session이 죽었을 수 있음 - 복구
    await this.recoverIfDead();
    // Watch는 click 안정성을 위해 일반 viewport 사용 (1920x10000은 OS window 밖 click 실패 원인)
    await this.ensureViewport("watch-interactive");
    await this.prepareForScraping();

    // React 하이드레이션 + 결과 테이블 초기 로드 + WebSocket 핸드셰이크 안정화 대기
    console.log("   Waiting 3s for React hydration after page reload...");
    await this.page!.waitForTimeout(3000);

    console.log(
      `🎯 Applying Watch filter: power=[${minPower}, ${maxPower}], bubble=No`,
    );

    try {
      // 1) Players 아코디언 헤더 클릭 (정확 텍스트 매칭 + 가시성 체크 + 인풋 등장 대기)
      // openPlayersSection 자체가 throw하더라도(예: page session 죽음) WS 캡처는 살아있으므로
      // catch해서 false로 처리하고 WS-only 모드로 진행
      console.log('   Opening "Players" section...');
      let playersOpened = false;
      try {
        playersOpened = await this.openPlayersSection();
      } catch (clickErr) {
        console.log(
          `   ⚠️ openPlayersSection threw (likely page session issue): ${(clickErr as Error).message}`,
        );
        playersOpened = false;
      }
      if (!playersOpened) {
        // Players UI 클릭 실패 - 그러나 dashboard_preset의 groups가 이미 ["players"]면
        // 서버는 페이지 로드 직후 자동으로 player WS 데이터를 push하므로
        // UI 클릭/Apply 없이도 Watch 모니터링이 작동함. 경고만 남기고 진행.
        try {
          await this.page!.screenshot({
            path: "debug-watch-players-header.png",
            fullPage: true,
          });
        } catch {
          // page session이 죽었으면 screenshot 실패 - 무시
        }
        console.log(
          '   ⚠️ Failed to open "Players" section UI - continuing in WS-only mode',
        );
        console.log(
          "   📡 If dashboard_preset already has 'players' group, WS frames will still arrive",
        );
        console.log(
          "   💡 To force a fresh filter, manually open dashboard in iScout and click Apply once",
        );
        return; // applyWatchFilter 종료, Watch는 계속 진행 (WS capture 작동 중)
      }

      // 2) Power 입력 2개 채우기 (React 입력 강제 디스패치)
      // Players 섹션 고유 식별자인 "Protection (bubble)" 라벨이 들어있는 컨테이너의
      // 자손 input[name=power] 만 타겟 (Arctic Barbarians 등이 함께 열려있어도 안전)
      const powerSet = await this.page!.evaluate(
        ({ min, max }: { min: number; max: number }) => {
          const setReactValue = (el: HTMLInputElement, val: string) => {
            const setter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype,
              "value",
            )?.set;
            setter?.call(el, val);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          };

          const allInputs = Array.from(
            document.querySelectorAll('input[name="power"]'),
          ) as HTMLInputElement[];

          // 1순위: "Protection (bubble)" 텍스트를 포함하는 가장 가까운 조상을 공유하는 input
          const playersInputs = allInputs.filter((input) => {
            if ((input as HTMLElement).offsetParent === null) return false;
            let p: HTMLElement | null = input.parentElement;
            for (let depth = 0; depth < 15 && p; depth++) {
              if ((p.textContent || "").includes("Protection (bubble)")) {
                return true;
              }
              p = p.parentElement;
            }
            return false;
          });

          // 2순위: 위 매칭이 실패하면 visible한 것 모두 (단일 섹션만 열려있을 가능성)
          const target =
            playersInputs.length >= 2
              ? playersInputs
              : allInputs.filter(
                  (i) => (i as HTMLElement).offsetParent !== null,
                );

          if (target.length < 2) {
            const total = allInputs.length;
            const visible = allInputs.filter(
              (i) => (i as HTMLElement).offsetParent !== null,
            ).length;
            return {
              ok: false,
              count: target.length,
              totalInDom: total,
              visibleInDom: visible,
              playersScoped: playersInputs.length,
            };
          }

          setReactValue(target[0], String(min));
          setReactValue(target[1], String(max));
          return {
            ok: true,
            count: target.length,
            totalInDom: allInputs.length,
            visibleInDom: allInputs.filter(
              (i) => (i as HTMLElement).offsetParent !== null,
            ).length,
            playersScoped: playersInputs.length,
          };
        },
        { min: minPower, max: maxPower },
      );

      console.log(
        `   📋 power inputs — total=${powerSet.totalInDom}, visible=${powerSet.visibleInDom}, players-scoped=${powerSet.playersScoped}`,
      );

      if (!powerSet.ok) {
        await this.page!.screenshot({
          path: "debug-watch-power-inputs.png",
          fullPage: true,
        });
        throw new Error(
          `Failed to set power inputs (visible count=${powerSet.count})`,
        );
      }

      console.log(`   ✅ Power inputs set: ${minPower} ~ ${maxPower}`);
      await this.page!.waitForTimeout(500);

      // 3) Bubble = "No" 보장 (기본값으로 들어와있지만 누락 시 selector 열어 선택)
      const bubbleStatus = await this.page!.evaluate(() => {
        const all = Array.from(document.querySelectorAll("div, label, span"));
        // "Protection (bubble)" 라벨 텍스트만 가진 가장 작은 노드 찾기
        const labelEl = all.find((el) => {
          const t = (el.textContent || "").trim();
          return (
            t === "Protection (bubble)" ||
            t.startsWith("Protection (bubble)")
          );
        });
        if (!labelEl) return { hasLabel: false, hasNo: false };

        // 라벨 형제(같은 컨테이너)에서 "No" 태그 버튼 찾기
        const container = labelEl.parentElement?.parentElement || labelEl.parentElement;
        if (!container) return { hasLabel: true, hasNo: false };

        const noTag = Array.from(container.querySelectorAll("button, span, div"))
          .find(
            (el) =>
              (el.textContent || "").trim() === "No" &&
              (el as HTMLElement).offsetParent !== null,
          );
        return { hasLabel: true, hasNo: !!noTag };
      });

      if (bubbleStatus.hasLabel && !bubbleStatus.hasNo) {
        console.log('   ⚠️ Bubble filter is empty, attempting to set "No"...');
        // bubble 콤보박스 열기 + "No" 옵션 클릭
        await this.page!.evaluate(() => {
          const all = Array.from(
            document.querySelectorAll("div, label, span"),
          );
          const labelEl = all.find((el) => {
            const t = (el.textContent || "").trim();
            return (
              t === "Protection (bubble)" ||
              t.startsWith("Protection (bubble)")
            );
          });
          const container =
            labelEl?.parentElement?.parentElement ||
            labelEl?.parentElement;
          // 콤보박스 영역 클릭
          const combo = container?.querySelector(
            '[role="combobox"]',
          ) as HTMLElement | null;
          combo?.click();
        });
        await this.page!.waitForTimeout(800);
        await this.page!.evaluate(() => {
          const opts = Array.from(document.querySelectorAll("*")) as HTMLElement[];
          const noOpt = opts.find(
            (el) =>
              (el.textContent || "").trim() === "No" &&
              el.children.length === 0 &&
              el.offsetParent !== null,
          );
          noOpt?.click();
        });
        await this.page!.waitForTimeout(500);
      } else {
        console.log("   ✅ Bubble filter already set to No");
      }

      // 4) Apply 클릭 (Watch 모드는 List:100 강제 변경 불필요 - 결과 표 폴링이 아닌 옵저버 기반)
      console.log('   Clicking "Apply" button...');

      // Apply 버튼이 활성화될 때까지 잠시 대기 (입력 dispatch 후 React state 반영)
      try {
        await this.page!.waitForFunction(
          () => {
            const buttons = Array.from(document.querySelectorAll("button"));
            const apply = buttons.find(
              (b) => (b.textContent || "").trim().toLowerCase() === "apply",
            );
            return !!apply && !(apply as HTMLButtonElement).disabled;
          },
          { timeout: 5000 },
        );
      } catch {
        console.log("   ⚠️ Apply button still disabled after waiting");
      }

      // Apply 버튼 직접 클릭 (disabled 무시한 합성 click 회피 위해 native click)
      const applyResult = await this.page!.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const apply = buttons.find(
          (b) => (b.textContent || "").trim().toLowerCase() === "apply",
        ) as HTMLButtonElement | undefined;
        if (!apply) return { clicked: false, reason: "not-found" };
        if (apply.disabled) return { clicked: false, reason: "disabled" };
        apply.scrollIntoView({ block: "center", inline: "nearest" });
        apply.click();
        return { clicked: true };
      });

      if (!applyResult.clicked) {
        await this.page!.screenshot({
          path: "debug-watch-apply.png",
          fullPage: true,
        });
        throw new Error(
          `Failed to click Apply button (reason: ${applyResult.reason})`,
        );
      }
      console.log('   ✅ "Apply" clicked - waiting 6s for initial results...');
      await this.page!.waitForTimeout(6000);

      // 결과 행 수 로그
      const initialCount = await this.page!.evaluate(
        () => document.querySelectorAll("tr").length,
      );
      console.log(`   📋 Initial table rows: ${initialCount}`);

      console.log("✅ Watch filter applied - page is now monitoring");
    } catch (error) {
      console.error("❌ Failed to apply Watch filter:", error);
      throw error;
    }
  }

  // 모든 좌표 크롤링 (순차적으로 실행)
  // 전체 작업을 단일 큐 슬롯으로 잡아 Watch 등 외부 작업과 직렬화. 내부에서는 _Impl 직접 호출
  // (이미 큐를 잡고 있으므로 다시 큐 잡으면 데드락)
  async scrapeAll(): Promise<{
    barbarian: Coordinate[];
    ares: Coordinate[];
    witch: Coordinate[];
    goblin: Coordinate[];
    pyramid: Coordinate[];
  }> {
    if (this.watchLockActive) {
      console.log("⏭️ scrapeAll skipped entirely (Watch lock active)");
      return { barbarian: [], ares: [], witch: [], goblin: [], pyramid: [] };
    }
    return this.runQueued("scrapeAll", async () => {
      await this.initialize();

      try {
        console.log("📊 Starting full scrape...");
        const startTime = Date.now();

        // 각 단계마다 Watch lock을 체크 - 중간에 Watch가 들어오면 즉시 중단
        if (this.watchLockActive) {
          console.log("⏭️ scrapeAll aborted before Pyramid (Watch lock activated mid-flight)");
          return { barbarian: [], ares: [], witch: [], goblin: [], pyramid: [] };
        }
        console.log("1️⃣ Scraping Pyramid...");
        const pyramid = await this._scrapePyramidImpl();

        if (this.watchLockActive) {
          console.log("⏭️ scrapeAll aborted before Barbarian (Watch lock activated mid-flight)");
          return { barbarian: [], ares: [], witch: [], goblin: [], pyramid };
        }
        console.log("2️⃣ Scraping Barbarian...");
        const barbarian = await this._scrapeBarbarianImpl();

        if (this.watchLockActive) {
          console.log("⏭️ scrapeAll aborted before Monsters (Watch lock activated mid-flight)");
          return { barbarian, ares: [], witch: [], goblin: [], pyramid };
        }
        console.log("3️⃣ Scraping Monsters (Ares + Witch + Goblin)...");
        const { ares, witch, goblin } = await this._scrapeMonstersImpl();

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`✅ Full scrape completed in ${duration}s`);
        console.log(`   - Barbarian: ${barbarian.length}`);
        console.log(`   - Ares: ${ares.length}`);
        console.log(`   - Witch: ${witch.length}`);
        console.log(`   - Goblin: ${goblin.length}`);
        console.log(`   - Pyramid: ${pyramid.length}`);

        return { barbarian, ares, witch, goblin, pyramid };
      } catch (error) {
        console.error("❌ Scraping failed:", error);
        throw error;
      }
    });
  }
}

// 싱글톤 인스턴스
export const scraper = new ScraperService();
