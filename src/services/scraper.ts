
// Puppeteer Scraper Service
import { Browser, Page } from "puppeteer";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { Coordinate } from "../types/coordinate";

// Stealth 플러그인 추가 (봇 감지 방지)
puppeteer.use(StealthPlugin());

class ScraperService {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private isLoggedIn: boolean = false;

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

      // 데스크톱 뷰포트 고정 (모바일 레이아웃 방지)
      await this.page.setViewport({ width: 1920, height: 1080 });

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

    // 1. 페이지 새로고침
    console.log("   Refreshing page...");
    await this.page.reload({ waitUntil: "networkidle2" });
    await this.page.waitForTimeout(2000);

    // 2. 로그인 여부 확인
    const currentUrl = this.page.url();
    console.log(`   Current URL: ${currentUrl}`);

    if (currentUrl.includes("/login")) {
      // 로그인 페이지로 이동됨 - 세션 만료, 재로그인 필요
      console.log("⚠️  Session expired, logging in again...");
      this.isLoggedIn = false;
      await this.login();
    } else if (!currentUrl.includes("/dashboard")) {
      // 대시보드가 아닌 다른 페이지
      console.log("   Navigating to dashboard...");
      await this.page.goto(`${this.ISCOUT_URL}/dashboard`, {
        waitUntil: "networkidle2",
      });
      await this.page.waitForTimeout(2000);
    } else {
      console.log("✅ Already logged in");
    }

    console.log("✅ Ready to scrape");
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
      const text = await button.evaluate(
        (el) => el.textContent?.trim() || "",
      );
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
      const text = await el.evaluate(
        (node) => node.textContent?.trim() || "",
      );
      if (text.includes(textMatch)) {
        await el.evaluate((node) =>
          (node as HTMLElement).scrollIntoView({ block: "center", inline: "nearest" }),
        );
        await this.page!.waitForTimeout(500);
        await el.click();
        return true;
      }
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
   * 가상 스크롤 테이블에서 모든 행 데이터를 추출.
   * 테이블 스크롤 컨테이너를 찾아 점진적으로 스크롤하며
   * DOM에 렌더링된 행을 누적 수집한다 (좌표 기반 중복 제거).
   */
  private async scrollAndExtractRows(
    extractFn: () => { key: string; data: any }[],
  ): Promise<any[]> {
    const collected = new Map<string, any>();

    // 현재 보이는 행 추출
    const extractVisible = async () => {
      const rows = await this.page!.evaluate(extractFn);
      for (const { key, data } of rows) {
        if (!collected.has(key)) collected.set(key, data);
      }
    };

    // 테이블 스크롤 컨테이너 찾기 + 스크롤
    const scrollContainer = await this.page!.evaluate(() => {
      const table = document.querySelector('table');
      if (!table) return null;
      let el: HTMLElement | null = table.parentElement;
      while (el) {
        const style = getComputedStyle(el);
        if (
          (style.overflow === 'auto' || style.overflow === 'scroll' ||
           style.overflowY === 'auto' || style.overflowY === 'scroll') &&
          el.scrollHeight > el.clientHeight
        ) {
          el.setAttribute('data-scraper-scroll', 'true');
          return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
        }
        el = el.parentElement;
      }
      return null;
    });

    if (!scrollContainer) {
      await extractVisible();
      return Array.from(collected.values());
    }

    // 스크롤 컨테이너를 점진적으로 스크롤하며 행 수집
    const step = Math.floor(scrollContainer.clientHeight * 0.8);
    let scrollTop = 0;
    let stableCount = 0;

    for (let i = 0; i < 50; i++) {
      await extractVisible();

      const prevSize = collected.size;
      await this.page!.evaluate((scrollAmount: number) => {
        const container = document.querySelector('[data-scraper-scroll="true"]');
        if (container) container.scrollTop = scrollAmount;
      }, scrollTop);
      await this.page!.waitForTimeout(800);
      scrollTop += step;

      await extractVisible();

      if (collected.size === prevSize) {
        stableCount++;
        if (stableCount >= 3) break;
      } else {
        stableCount = 0;
      }
    }

    // 스크롤 마커 제거
    await this.page!.evaluate(() => {
      const el = document.querySelector('[data-scraper-scroll="true"]');
      if (el) el.removeAttribute('data-scraper-scroll');
    });

    return Array.from(collected.values());
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

      // Rows per page를 최대값(100)으로 변경
      console.log("   Setting rows per page to max...");
      const rowsChanged = await this.page!.evaluate(() => {
        // 방법1: <select> 요소 찾기 (MUI TablePagination 등)
        const selects = Array.from(document.querySelectorAll('select'));
        for (const select of selects) {
          const options = Array.from(select.options);
          const has100 = options.find(o => o.value === '100' || o.text.trim() === '100');
          if (has100) {
            select.value = has100.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return { method: 'select', value: has100.value };
          }
          // 최대값 옵션 선택
          const maxOpt = options.reduce((max, o) => {
            const n = parseInt(o.value);
            return !isNaN(n) && n > parseInt(max.value) ? o : max;
          }, options[0]);
          if (maxOpt && parseInt(maxOpt.value) > 25) {
            select.value = maxOpt.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return { method: 'select-max', value: maxOpt.value };
          }
        }
        // 방법2: aria-label이나 class로 찾기
        const paginationSelect = document.querySelector('[class*="rowsPerPage"] select, [class*="pageSize"] select, [aria-label*="rows per page"]');
        if (paginationSelect && paginationSelect instanceof HTMLSelectElement) {
          const opts = Array.from(paginationSelect.options);
          const max = opts[opts.length - 1];
          if (max) {
            paginationSelect.value = max.value;
            paginationSelect.dispatchEvent(new Event('change', { bubbles: true }));
            return { method: 'pagination-select', value: max.value };
          }
        }
        return null;
      });

      if (rowsChanged) {
        console.log(`   ✅ Rows per page changed: ${JSON.stringify(rowsChanged)}`);
        console.log("   Waiting 5 seconds for table reload...");
        await this.page!.waitForTimeout(5000);
      } else {
        console.log("   ⚠️ Rows per page selector not found");
        // 디버그: 페이지의 select 요소 정보 출력
        const debugSelects = await this.page!.evaluate(() => {
          const selects = Array.from(document.querySelectorAll('select'));
          return selects.map(s => ({
            id: s.id, className: s.className,
            options: Array.from(s.options).map(o => ({ val: o.value, text: o.text.trim() })),
          }));
        });
        if (debugSelects.length > 0) {
          console.log(`   📋 Found ${debugSelects.length} select(s):`, JSON.stringify(debugSelects));
        }
      }

      console.log("   Scrolling page to load all data...");
      let scrollPass = 0;
      let prevHeight = 0;
      while (scrollPass < 20) {
        scrollPass++;
        await this.page!.evaluate(async () => {
          await new Promise<void>((resolve) => {
            let totalHeight = 0;
            const distance = 500;
            const timer = setInterval(() => {
              const scrollHeight = document.body.scrollHeight;
              window.scrollBy(0, distance);
              totalHeight += distance;
              if (totalHeight >= scrollHeight) {
                clearInterval(timer);
                resolve();
              }
            }, 200);
          });
        });
        await this.page!.waitForTimeout(2000);
        const currentHeight = await this.page!.evaluate(() => document.body.scrollHeight);
        if (currentHeight === prevHeight) break;
        prevHeight = currentHeight;
      }
      console.log(`   Scroll complete (${scrollPass} pass${scrollPass > 1 ? 'es' : ''})`);
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
    console.log("🗡️ Scraping Barbarian coordinates...");

    await this.initialize();
    await this.prepareForScraping(); // 매번 새로고침 + 로그인 확인 + List 버튼 클릭

    try {
      // 1-2. EvonyBot 프리셋 선택 (네이티브 클릭)
      await this.selectEvonyBotPreset();

      // 3. "Arctic Barbarians" 버튼 클릭 (네이티브 클릭)
      console.log('   Clicking "Arctic Barbarians" button...');
      const arcticBarbarianClicked =
        (await this.clickButtonNative((text) =>
          text.includes("Arctic Barbarians"),
        )) ||
        (await this.clickElementByText(
          "div, span, label",
          "Arctic Barbarians",
        ));

      if (arcticBarbarianClicked) {
        console.log('   ✅ "Arctic Barbarians" button clicked');
        await this.page!.waitForTimeout(1000);
      } else {
        console.log('   ⚠️ "Arctic Barbarians" button not found');
        await this.page!.screenshot({
          path: "debug-barbarian-buttons.png",
          fullPage: true,
        });
      }

      // 4. Apply 클릭 및 결과 대기
      await this.clickApplyAndWait();

      // 5. 좌표 데이터 추출
      console.log("   Extracting coordinates from table...");
      const allRows = await this.scrollAndExtractRows(() => {
        const results: { key: string; data: any }[] = [];
        const rows = document.querySelectorAll("tr");
        rows.forEach((row: any) => {
          try {
            const itemDiv = row.querySelector('div[data-tooltip-id*="clickboard_data"]');
            const itemText = itemDiv?.textContent?.trim() || "";
            if (!itemText.includes("Barbarian")) return;

            let xMatch = null;
            let yMatch = null;
            const allDivs = row.querySelectorAll("div[data-tooltip-id]");
            for (const div of allDivs) {
              const tooltipId = (div as any).getAttribute("data-tooltip-id") || "";
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
            const levelMatch = itemText.match(/Lv(\d+)/i) || itemText.match(/Level\s*(\d+)/i);
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
                  power = unit === "M" ? Math.round(numValue * 1000000) : Math.round(numValue * 1000000000);
                  break;
                }
              }
            }

            const allianceDiv = row.querySelector('[data-tooltip-id*="alliance"]');
            const alliance = allianceDiv?.textContent?.trim() || undefined;

            results.push({
              key: `barb_${x}_${y}`,
              data: { x, y, level, power, alliance, timestamp: new Date().toISOString() },
            });
          } catch (e) {}
        });
        return results;
      });

      console.log(`✅ Found ${allRows.length} Barbarian coordinates (Lv5, Lv6, Lv7 only)`);
      return allRows;
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
    console.log("👾 Scraping Monsters (Ares + Witch + Goblin)...");

    await this.initialize();
    await this.prepareForScraping();

    try {
      await this.selectEvonyBotPreset();
      await this.clickApplyAndWait();

      console.log("   Extracting monster coordinates from table...");
      const allRows = await this.scrollAndExtractRows(() => {
        const results: { key: string; data: any }[] = [];
        const rows = document.querySelectorAll("tr");
        rows.forEach((row: any) => {
          try {
            const itemDiv = row.querySelector('div[data-tooltip-id*="clickboard_data"]');
            const itemText = itemDiv?.textContent?.trim() || "";
            if (!itemText) return;

            let type: string | null = null;
            if (itemText.includes("Ares") || itemText.includes("ares")) {
              type = "ares";
            } else if (itemText.includes("Witch")) {
              type = "witch";
            } else if (itemText.includes("Goblin")) {
              type = "goblin";
            }
            if (!type) return;

            let xMatch = null;
            let yMatch = null;
            const allDivs = row.querySelectorAll("div[data-tooltip-id]");
            for (const div of allDivs) {
              const tooltipId = (div as any).getAttribute("data-tooltip-id") || "";
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
              const levelMatch = itemText.match(/Lv(\d+)/i) || itemText.match(/Level\s*(\d+)/i);
              const level = levelMatch ? parseInt(levelMatch[1]) : 0;
              results.push({
                key: `${type}_${x}_${y}`,
                data: { x, y, level, type, timestamp: new Date().toISOString() },
              });
            }
          } catch (e) {}
        });
        return results;
      });

      const result = {
        ares: allRows.filter((r: any) => r.type === "ares").map(({ type, ...rest }: any) => rest),
        witch: allRows.filter((r: any) => r.type === "witch").map(({ type, ...rest }: any) => rest),
        goblin: allRows.filter((r: any) => r.type === "goblin").map(({ type, ...rest }: any) => rest),
      };

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
    console.log("🔺 Scraping Pyramid coordinates...");

    await this.initialize();
    await this.prepareForScraping(); // 매번 새로고침 + 로그인 확인 + List 버튼 클릭

    try {
      // 1-2. EvonyBot 프리셋 선택 (네이티브 클릭)
      await this.selectEvonyBotPreset();

      // 3. "Relics/Pyramids" 버튼 클릭 (네이티브 클릭)
      console.log('   Clicking "Relics/Pyramids" button...');
      const relicsPyramidsClicked =
        (await this.clickButtonNative(
          (text) =>
            text.includes("Relics/Pyramids") ||
            text.includes("Relics") ||
            text.includes("Pyramids"),
        )) ||
        (await this.clickElementByText(
          "div, span, label",
          "Relics/Pyramids",
        ));

      if (relicsPyramidsClicked) {
        console.log('   ✅ "Relics/Pyramids" button clicked');
        await this.page!.waitForTimeout(1000);
      } else {
        console.log('   ⚠️ "Relics/Pyramids" button not found');
        await this.page!.screenshot({
          path: "debug-pyramid-buttons.png",
          fullPage: true,
        });
      }

      // 4. Apply 클릭 및 결과 대기
      await this.clickApplyAndWait();

      // 5. 좌표 데이터 추출
      console.log("   Extracting coordinates from table...");
      const allRows = await this.scrollAndExtractRows(() => {
        const results: { key: string; data: any }[] = [];
        const rows = document.querySelectorAll("tr");
        rows.forEach((row: any) => {
          try {
            const itemDiv = row.querySelector('div[data-tooltip-id*="clickboard_data"]');
            const itemText = itemDiv?.textContent?.trim() || "";
            if (!itemText.includes("Pyramid")) return;

            const xDiv = row.querySelector('[data-tooltip-id$="_x"]');
            const xText = xDiv?.textContent?.trim() || "";
            const yDivs = row.querySelectorAll('[data-tooltip-id$="_y"]');
            const yText = yDivs[0]?.textContent?.trim() || "";

            const xMatch = xText.match(/X:\s*(\d+)/);
            const yMatch = yText.match(/Y:\s*(\d+)/);
            if (!xMatch || !yMatch) return;

            const x = parseInt(xMatch[1]);
            const y = parseInt(yMatch[1]);
            const levelMatch = itemText.match(/Lv(\d+)/);
            const level = levelMatch ? parseInt(levelMatch[1]) : 0;
            if (level !== 4 && level !== 5) return;

            results.push({
              key: `pyr_${x}_${y}`,
              data: { x, y, level, timestamp: new Date().toISOString() },
            });
          } catch (e) {}
        });
        return results;
      });

      console.log(`✅ Found ${allRows.length} Pyramid coordinates (Lv4, Lv5 only)`);
      return allRows;
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

  // 모든 좌표 크롤링 (순차적으로 실행)
  async scrapeAll(): Promise<{
    barbarian: Coordinate[];
    ares: Coordinate[];
    witch: Coordinate[];
    goblin: Coordinate[];
    pyramid: Coordinate[];
  }> {
    await this.initialize();

    try {
      console.log("📊 Starting full scrape...");
      const startTime = Date.now();

      console.log("1️⃣ Scraping Pyramid...");
      const pyramid = await this.scrapePyramid();

      console.log("2️⃣ Scraping Barbarian...");
      const barbarian = await this.scrapeBarbarian();

      console.log("3️⃣ Scraping Monsters (Ares + Witch + Goblin)...");
      const { ares, witch, goblin } = await this.scrapeMonsters();

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
  }
}

// 싱글톤 인스턴스
export const scraper = new ScraperService();
