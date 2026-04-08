// 프리셋 버튼 선택 테스트 스크립트
import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import { Browser, Page } from "puppeteer";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

const ISCOUT_URL = process.env.ISCOUT_URL || "https://www.iscout.club/en";
const ISCOUT_EMAIL = process.env.ISCOUT_EMAIL || "";
const ISCOUT_PASSWORD = process.env.ISCOUT_PASSWORD || "";

async function testPresetSelection() {
  console.log("🧪 프리셋 버튼 선택 테스트 시작...\n");

  let browser: Browser | null = null;
  let page: Page | null = null;

  try {
    // 브라우저 실행
    const chromeDir = path.join(process.cwd(), "chrome");
    let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || "";

    if (!executablePath && fs.existsSync(chromeDir)) {
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
          "Google Chrome for Testing"
        );
      }
    }

    const userDataDir = path.join(process.cwd(), "chrome-user-data");

    browser = await puppeteer.launch({
      headless: false, // 브라우저 창 표시
      executablePath: executablePath || undefined,
      userDataDir: userDataDir,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    page.setDefaultTimeout(60000);

    // 대시보드로 이동 (이미 로그인되어 있는지 확인)
    console.log("1️⃣ 대시보드로 이동...");
    await page.goto(`${ISCOUT_URL}/dashboard`, { waitUntil: "networkidle2" });
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    console.log(`   현재 URL: ${currentUrl}`);

    if (currentUrl.includes("/login")) {
      console.log("⚠️ 로그인이 필요합니다. 자동 로그인 시도...");
      
      if (!ISCOUT_EMAIL || !ISCOUT_PASSWORD) {
        console.log("❌ .env 파일에 ISCOUT_EMAIL과 ISCOUT_PASSWORD를 설정하세요.");
        return;
      }

      // 로그인 폼 대기
      await page.waitForSelector("#email", { timeout: 10000 });
      await page.type("#email", ISCOUT_EMAIL, { delay: 100 });
      await page.type("#password", ISCOUT_PASSWORD, { delay: 100 });

      // 로그인 버튼 클릭
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const loginButton = buttons.find(
          (btn: any) =>
            btn.textContent?.toLowerCase().includes("log in") ||
            btn.textContent?.toLowerCase().includes("login")
        );
        if (loginButton) {
          (loginButton as any).click();
        }
      });

      // 페이지 전환 대기
      try {
        await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 });
      } catch (e) {
        console.log("   Navigation timeout, checking URL...");
      }
      await page.waitForTimeout(3000);

      const afterLoginUrl = page.url();
      if (afterLoginUrl.includes("/dashboard")) {
        console.log("✅ 로그인 성공!");
      } else {
        console.log("❌ 로그인 실패. URL:", afterLoginUrl);
        await page.screenshot({ path: "test-login-failed.png", fullPage: true });
        return;
      }
    }

    // List 버튼 클릭
    console.log("\n2️⃣ List 버튼 클릭...");
    await page.waitForTimeout(1000);

    const listButtonClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const listButton = buttons.find(
        (btn: any) =>
          btn.textContent?.trim().includes("List") &&
          btn.querySelector("p")?.textContent?.trim() === "List"
      );
      if (listButton) {
        (listButton as any).click();
        return true;
      }
      return false;
    });

    console.log(`   List 버튼 클릭 결과: ${listButtonClicked ? "✅ 성공" : "❌ 실패"}`);
    await page.waitForTimeout(2000);

    // 3. "Presets list" 버튼 클릭하여 드롭다운 열기
    console.log("\n3️⃣ 'Presets list' 버튼 클릭하여 드롭다운 열기...");

    const presetsListClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const presetsButton = buttons.find((btn: any) =>
        btn.textContent?.includes("Presets list")
      );

      if (presetsButton) {
        (presetsButton as any).click();
        return { success: true, text: presetsButton.textContent?.trim() };
      }
      return { success: false, text: null };
    });

    console.log(`   Presets list 버튼 클릭 결과:`, presetsListClicked);
    await page.waitForTimeout(1500); // 드롭다운 애니메이션 대기

    // 스크린샷 저장 (드롭다운이 열린 상태)
    await page.screenshot({ path: "test-1-dropdown-open.png", fullPage: true });
    console.log("   📸 스크린샷 저장: test-1-dropdown-open.png");

    // 4. 드롭다운 메뉴 구조 분석
    console.log("\n4️⃣ 드롭다운 메뉴 구조 분석...");

    // Headless UI 또는 일반 드롭다운 메뉴 찾기
    const dropdownAnalysis = await page.evaluate(() => {
      // Headless UI listbox 옵션들 찾기
      const listboxOptions = Array.from(document.querySelectorAll('[role="option"], [role="listbox"] > *, [id*="headlessui-listbox-option"]'));
      
      // 일반적인 드롭다운 메뉴 항목들
      const menuItems = Array.from(document.querySelectorAll('[role="menuitem"], [role="menu"] > *'));
      
      // ul > li 구조의 드롭다운
      const ulLiItems = Array.from(document.querySelectorAll('ul[class*="dropdown"] li, ul[class*="menu"] li, div[class*="dropdown"] > div'));
      
      // 모든 visible한 li 태그
      const allLi = Array.from(document.querySelectorAll('li')).filter((el: any) => el.offsetParent !== null);
      
      // 클릭 가능해 보이는 모든 요소 중 "EvonyBot" 텍스트를 가진 것
      const allElements = Array.from(document.querySelectorAll('*'));
      const evonyBotElements = allElements.filter((el: any) => {
        const text = el.textContent?.trim() || "";
        const directText = el.childNodes.length === 1 && el.childNodes[0].nodeType === 3 
          ? el.childNodes[0].textContent?.trim() 
          : null;
        return text === "EvonyBot" || directText === "EvonyBot";
      }).map((el: any) => ({
        tag: el.tagName,
        text: el.textContent?.trim(),
        className: el.className,
        id: el.id,
        visible: el.offsetParent !== null,
        rect: el.getBoundingClientRect(),
        hasClickHandler: el.onclick !== null || el.getAttribute('role') === 'option',
      }));

      return {
        listboxOptions: listboxOptions.map((el: any) => ({ tag: el.tagName, text: el.textContent?.trim().substring(0, 30), visible: el.offsetParent !== null })),
        menuItems: menuItems.map((el: any) => ({ tag: el.tagName, text: el.textContent?.trim().substring(0, 30), visible: el.offsetParent !== null })),
        ulLiItems: ulLiItems.map((el: any) => ({ tag: el.tagName, text: el.textContent?.trim().substring(0, 30), visible: el.offsetParent !== null })),
        visibleLiCount: allLi.length,
        evonyBotElements,
      };
    });

    console.log("   Listbox 옵션:", dropdownAnalysis.listboxOptions);
    console.log("   Menu 항목:", dropdownAnalysis.menuItems);
    console.log("   UL/LI 항목:", dropdownAnalysis.ulLiItems);
    console.log("   Visible LI 개수:", dropdownAnalysis.visibleLiCount);
    console.log("   EvonyBot 요소들:", JSON.stringify(dropdownAnalysis.evonyBotElements, null, 2));

    // 5. 드롭다운에서 "EvonyBot" 클릭 시도 (여러 방법)
    console.log("\n5️⃣ 드롭다운에서 'EvonyBot' 클릭 시도...");

    // 방법 1: Puppeteer의 page.click 사용 (좌표 기반)
    const evonyBotElement = dropdownAnalysis.evonyBotElements.find(el => el.visible && el.rect.width > 0);
    
    if (evonyBotElement && evonyBotElement.rect) {
      console.log("   EvonyBot 요소 발견:", evonyBotElement);
      
      // 해당 요소의 중앙 좌표 계산
      const x = evonyBotElement.rect.x + evonyBotElement.rect.width / 2;
      const y = evonyBotElement.rect.y + evonyBotElement.rect.height / 2;
      
      console.log(`   클릭 좌표: (${x}, ${y})`);
      
      // 마우스로 직접 클릭
      await page.mouse.click(x, y);
      console.log("   ✅ 마우스 클릭 완료");
      
      await page.waitForTimeout(1000);
    } else {
      console.log("   ⚠️ EvonyBot 요소를 찾을 수 없거나 보이지 않음");
      
      // 방법 2: evaluate로 직접 클릭
      const clickResult = await page.evaluate(() => {
        // 가장 정확한 EvonyBot 요소 찾기 - 텍스트 노드만 가진 요소
        const allElements = Array.from(document.querySelectorAll('*'));
        
        for (const el of allElements) {
          // 직접 텍스트만 가진 요소 찾기
          if (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) {
            const text = el.childNodes[0].textContent?.trim();
            if (text === "EvonyBot") {
              console.log("Found EvonyBot element:", el.tagName, el.className);
              (el as any).click();
              
              // 부모 요소도 클릭 시도
              if (el.parentElement) {
                (el.parentElement as any).click();
              }
              
              return { success: true, tag: el.tagName, className: (el as any).className };
            }
          }
        }
        
        // 폴백: flex cursor-pointer 클래스를 가진 EvonyBot 요소
        const flexElement = document.querySelector('div.flex.cursor-pointer');
        if (flexElement && flexElement.textContent?.trim() === "EvonyBot") {
          (flexElement as any).click();
          return { success: true, tag: "DIV", className: "flex cursor-pointer (fallback)" };
        }
        
        return { success: false };
      });
      
      console.log("   Evaluate 클릭 결과:", clickResult);
    }

    await page.waitForTimeout(1500);

    // 스크린샷 저장 (클릭 후)
    await page.screenshot({ path: "test-2-after-click.png", fullPage: true });
    console.log("   📸 스크린샷 저장: test-2-after-click.png");

    // 6. 필터가 적용되었는지 확인
    console.log("\n6️⃣ 필터 적용 상태 확인...");
    
    const filterState = await page.evaluate(() => {
      // Arctic Barbarians 섹션이 열려있는지 확인
      const arcticSection = Array.from(document.querySelectorAll('button, div')).find(
        (el: any) => el.textContent?.includes("Arctic Barbarians")
      );
      
      // 선택된 필터 확인
      const selectedFilters = Array.from(document.querySelectorAll('[class*="tag"], [class*="chip"], [class*="badge"]'))
        .map((el: any) => el.textContent?.trim())
        .filter(Boolean);
      
      return {
        arcticSectionFound: !!arcticSection,
        selectedFilters,
      };
    });
    
    console.log("   필터 상태:", filterState);

    // 5. HTML 디버그 정보 저장
    console.log("\n5️⃣ 디버그용 HTML 저장...");
    const html = await page.content();
    fs.writeFileSync("test-debug-page.html", html);
    console.log("   📄 HTML 저장: test-debug-page.html");

    console.log("\n✅ 테스트 완료!");
    console.log("   스크린샷과 HTML 파일을 확인해주세요.");

    // 브라우저를 열어둠 (수동 확인용)
    console.log("\n   브라우저를 30초간 열어둡니다. 수동으로 확인해주세요...");
    await page.waitForTimeout(30000);

  } catch (error) {
    console.error("❌ 테스트 실패:", error);
    if (page) {
      await page.screenshot({ path: "test-error.png", fullPage: true });
      console.log("   📸 에러 스크린샷 저장: test-error.png");
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// 실행
testPresetSelection();
