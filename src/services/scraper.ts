// Puppeteer Scraper Service
import { Browser, Page } from 'puppeteer';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Coordinate } from '../types/coordinate';

// Stealth 플러그인 추가 (봇 감지 방지)
puppeteer.use(StealthPlugin());

class ScraperService {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private isLoggedIn: boolean = false;

  // 환경 변수 getter (dotenv.config() 실행 후에 읽기 위해)
  private get ISCOUT_URL(): string {
    return process.env.ISCOUT_URL || 'https://www.iscout.club/en';
  }
  
  private get ISCOUT_EMAIL(): string {
    return process.env.ISCOUT_EMAIL || '';
  }
  
  private get ISCOUT_PASSWORD(): string {
    return process.env.ISCOUT_PASSWORD || '';
  }

  // 브라우저 초기화
  async initialize(): Promise<void> {
    if (!this.browser) {
      console.log('🌐 Initializing Puppeteer browser...');
      console.log('   Platform:', process.platform, process.arch);

      try {
        const path = require('path');
        const fs = require('fs');
        
        // 설치된 Chrome 경로 찾기
        // 1. 환경 변수 우선 확인 (서버 배포용)
        let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '';
        
        // 2. Linux ARM64 시스템에서 시스템 Chromium 사용
        if (!executablePath && process.platform === 'linux' && process.arch === 'arm64') {
          const systemChromePaths = [
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/usr/bin/google-chrome',
          ];
          for (const chromePath of systemChromePaths) {
            if (fs.existsSync(chromePath)) {
              executablePath = chromePath;
              console.log('   Linux ARM64: Using system Chromium:', executablePath);
              break;
            }
          }
        }
        
        // 3. 로컬 chrome 디렉토리 확인 (개발용)
        if (!executablePath) {
          const chromeDir = path.join(process.cwd(), 'chrome');
          
          if (fs.existsSync(chromeDir)) {
            const versions = fs.readdirSync(chromeDir);
            if (versions.length > 0) {
              const latestVersion = versions.sort().reverse()[0];
              executablePath = path.join(
                chromeDir,
                latestVersion,
                'chrome-mac-arm64',
                'Google Chrome for Testing.app',
                'Contents',
                'MacOS',
                'Google Chrome for Testing'
              );
            }
          }
        }
        
        if (executablePath) {
          console.log('   Using Chrome:', executablePath);
        }
        
        // M1/M2 Mac 호환 설정
        const userDataDir = path.join(process.cwd(), 'chrome-user-data');
        
        // Headless 모드 결정
        // 환경 변수로 명시적 제어 가능, 기본값은 Linux만 headless
        const isHeadless = process.env.PUPPETEER_HEADLESS === 'true' || 
                          (process.env.PUPPETEER_HEADLESS !== 'false' && process.platform === 'linux');
        
        console.log(`   Headless mode: ${isHeadless ? 'enabled' : 'disabled'}`);
        
        this.browser = await puppeteer.launch({
          headless: isHeadless ? 'new' : false,  // 서버: headless, 로컬: 브라우저 창 표시
          executablePath: executablePath || undefined,
          userDataDir: userDataDir,  // 세션/쿠키 저장 (캡차 우회용)
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
          ],
        });
        console.log('✅ Browser initialized successfully');
      } catch (error) {
        console.error('❌ Failed to launch browser:', error);
        throw error;
      }

      // 페이지 생성 및 로그인
      await this.login();
    }
  }

  // iScout 로그인
  private async login(): Promise<void> {
    if (this.isLoggedIn) {
      console.log('✅ Already logged in');
      return;
    }

    if (!this.ISCOUT_EMAIL || !this.ISCOUT_PASSWORD) {
      throw new Error('❌ ISCOUT_EMAIL and ISCOUT_PASSWORD must be set in .env file');
    }

    try {
      console.log('🔐 Checking login status...');

      this.page = await this.browser!.newPage();

      // User agent 설정 (봇 감지 방지)
      await this.page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

      // 타임아웃 설정
      this.page.setDefaultTimeout(60000);

      // 먼저 메인 페이지로 이동하여 이미 로그인되어 있는지 확인
      console.log('   Checking if already logged in...');
      await this.page.goto(`${this.ISCOUT_URL}/dashboard`, { waitUntil: 'networkidle2' });

      const currentUrl = this.page.url();
      
      // 이미 대시보드에 있으면 로그인 성공
      if (currentUrl.includes('/dashboard')) {
        this.isLoggedIn = true;
        console.log('✅ Already logged in - session restored from saved data');
        return;
      }

      // 로그인 필요 - 로그인 페이지로 이동
      console.log('   Login required - navigating to login page...');
      console.log(`   Email: ${this.ISCOUT_EMAIL}`);
      await this.page.goto(`${this.ISCOUT_URL}/login`, { waitUntil: 'networkidle2' });

      // 캡차 확인
      console.log('   Checking for Cloudflare challenge...');
      await this.page.waitForTimeout(2000);
      
      // @ts-ignore - Running in browser context
      const hasCaptcha = await this.page.evaluate(() => {
        return document.body.textContent?.includes('Verify you are human') || 
               document.body.textContent?.includes('Cloudflare');
      });

      if (hasCaptcha) {
        console.log('⚠️  Cloudflare challenge detected!');
        console.log('   Please solve the captcha manually in the browser window.');
        console.log('   Waiting up to 60 seconds for you to complete it...');
        
        // 캡차 해결 대기 (최대 60초)
        let attempts = 0;
        const maxAttempts = 60;
        
        while (attempts < maxAttempts) {
          await this.page.waitForTimeout(1000);
          attempts++;
          
          const currentUrl = this.page.url();
          // @ts-ignore - Running in browser context
          const stillHasCaptcha = await this.page.evaluate(() => {
            return document.body.textContent?.includes('Verify you are human') || 
                   document.body.textContent?.includes('Cloudflare');
          });
          
          if (!stillHasCaptcha || currentUrl.includes('/login')) {
            console.log('✅ Captcha resolved!');
            break;
          }
          
          if (attempts % 10 === 0) {
            console.log(`   Still waiting... (${attempts}/${maxAttempts} seconds)`);
          }
        }
        
        if (attempts >= maxAttempts) {
          throw new Error('Captcha resolution timeout - please try again');
        }
      }

      // 로그인 폼 대기
      console.log('   Waiting for login form...');
      await this.page.waitForSelector('#email', { timeout: 10000 });

      // 이메일 입력
      console.log('   Entering email...');
      await this.page.type('#email', this.ISCOUT_EMAIL, { delay: 100 });

      // 비밀번호 입력
      console.log('   Entering password...');
      await this.page.type('#password', this.ISCOUT_PASSWORD, { delay: 100 });

      // 로그인 버튼 클릭 및 네비게이션 대기
      console.log('   Clicking login button...');
      
      // @ts-ignore - Running in browser context
      // 폼 제출 또는 로그인 버튼 클릭
      await this.page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const loginButton = buttons.find((btn: any) => 
          btn.textContent?.toLowerCase().includes('log in') ||
          btn.textContent?.toLowerCase().includes('login')
        );
        if (loginButton) {
          (loginButton as any).click();
        } else {
          // 폴백: 폼 제출
          const form = document.querySelector('form');
          if (form) (form as any).submit();
        }
      });

      // 페이지 전환 대기 (최대 30초)
      console.log('   Waiting for redirect...');
      try {
        await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
      } catch (navError) {
        console.log('   Navigation timeout - checking current URL...');
      }

      // 추가 대기 시간 (로딩 완료 확인)
      await this.page.waitForTimeout(3000);

      // 로그인 성공 확인 (dashboard URL로 리다이렉션 되었는지)
      const finalUrl = this.page.url();
      console.log(`   Current URL: ${finalUrl}`);

      if (finalUrl.includes('/dashboard')) {
        this.isLoggedIn = true;
        console.log('✅ Login successful - redirected to dashboard');
      } else if (finalUrl.includes('/login')) {
        // 여전히 로그인 페이지에 있음 - 오류 메시지 확인
        // @ts-ignore - Running in browser context
        const errorMessage = await this.page.evaluate(() => {
          const errorElement = document.querySelector('.text-red-600, .text-danger, [class*="error"]');
          return errorElement?.textContent?.trim() || 'Unknown error';
        });
        
        await this.page.screenshot({ path: 'login-failed.png', fullPage: true });
        throw new Error(`Login failed: ${errorMessage}`);
      } else {
        // 다른 페이지로 리다이렉션됨 - 로그인 성공으로 간주
        this.isLoggedIn = true;
        console.log('✅ Login successful - redirected to:', finalUrl);
      }

    } catch (error) {
      console.error('❌ Login failed:', error);

      // 에러 발생 시 디버그 정보 저장
      if (this.page) {
        try {
          await this.page.screenshot({ path: 'login-error.png', fullPage: true });
          const html = await this.page.content();
          const fs = require('fs');
          fs.writeFileSync('login-error.html', html);
          console.log('💾 Debug files saved: login-error.png, login-error.html');
        } catch (debugError) {
          console.error('Failed to save debug files:', debugError);
        }
      }

      throw new Error('Failed to login to iScout');
    }
  }

  // 크롤링 전 준비 작업 (매번 실행)
  private async prepareForScraping(): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    console.log('🔄 Preparing for scraping...');
    
    // 1. 페이지 새로고침
    console.log('   Refreshing page...');
    await this.page.reload({ waitUntil: 'networkidle2' });
    await this.page.waitForTimeout(2000);

    // 2. 로그인 여부 확인
    const currentUrl = this.page.url();
    console.log(`   Current URL: ${currentUrl}`);

    if (currentUrl.includes('/login')) {
      // 로그인 페이지로 이동됨 - 세션 만료, 재로그인 필요
      console.log('⚠️  Session expired, logging in again...');
      this.isLoggedIn = false;
      await this.login();
    } else if (!currentUrl.includes('/dashboard')) {
      // 대시보드가 아닌 다른 페이지
      console.log('   Navigating to dashboard...');
      await this.page.goto(`${this.ISCOUT_URL}/dashboard`, { waitUntil: 'networkidle2' });
      await this.page.waitForTimeout(2000);
    } else {
      console.log('✅ Already logged in');
    }

    // 3. List 버튼 클릭
    console.log('   Clicking List button...');
    await this.page.waitForTimeout(1000);
    
    // @ts-ignore - Running in browser context
    const listButtonClicked = await this.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const listButton = buttons.find((btn: any) => 
        btn.textContent?.trim().includes('List') && 
        btn.querySelector('p')?.textContent?.trim() === 'List'
      );
      if (listButton) {
        (listButton as any).click();
        return true;
      }
      return false;
    });

    if (listButtonClicked) {
      console.log('✅ List button clicked');
      await this.page.waitForTimeout(2000); // 화면 전환 대기
    } else {
      console.log('⚠️  List button not found (may already be in list mode)');
    }

    console.log('✅ Ready to scrape');
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
      console.log('🔒 Browser closed');
    }
  }


  // 바바리안 좌표 크롤링
  async scrapeBarbarian(): Promise<Coordinate[]> {
    console.log('🗡️ Scraping Barbarian coordinates...');

    await this.initialize();
    await this.prepareForScraping(); // 매번 새로고침 + 로그인 확인 + List 버튼 클릭

    try {
      // 1. "Arctic Barbarians" 버튼 클릭
      console.log('   Clicking "Arctic Barbarians" button...');
      // @ts-ignore - Running in browser context
      const arcticBarbarianClicked = await this.page!.evaluate(() => {
        // 버튼들 중에서 "Arctic Barbarians" 텍스트가 포함된 것 찾기
        const buttons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"]'));
        const targetButton = buttons.find((btn: any) => 
          btn.textContent?.includes('Arctic Barbarians')
        );
        
        if (targetButton) {
          (targetButton as any).click();
          return true;
        }
        
        // 버튼이 아닌 div나 다른 요소일 수 있음
        const divs = Array.from(document.querySelectorAll('div, span, label'));
        const targetDiv = divs.find((el: any) => 
          el.textContent?.includes('Arctic Barbarians') &&
          el.onclick !== null
        );
        
        if (targetDiv) {
          (targetDiv as any).click();
          return true;
        }
        
        return false;
      });

      if (arcticBarbarianClicked) {
        console.log('   ✅ "Arctic Barbarians" button clicked');
        await this.page!.waitForTimeout(1000);
      } else {
        console.log('   ⚠️ "Arctic Barbarians" button not found, trying alternative selector...');
        // 스크린샷 저장하여 디버깅
        await this.page!.screenshot({ path: 'debug-barbarian-buttons.png', fullPage: true });
      }

      // 2. Barbarian 레벨 5, 6, 7 선택 (키보드 입력 방식)
      console.log('   Step 1: Selecting Lv5 by typing "5"...');
      
      // Arctic Barbarians input 찾아서 클릭
      // @ts-ignore
      await this.page!.evaluate(() => {
        const legends = Array.from(document.querySelectorAll('legend'));
        const barbarianLegend = legends.find((legend: any) => 
          legend.textContent?.trim() === 'Arctic Barbarians'
        );
        const barbarianSection = barbarianLegend?.closest('li');
        const multiselectInput = barbarianSection?.querySelector('.multiselect__input') as HTMLInputElement;
        if (multiselectInput) {
          multiselectInput.focus();
          multiselectInput.click();
        }
      });
      
      await this.page!.waitForTimeout(500);
      
      // "5" 입력
      await this.page!.keyboard.type('5');
      console.log('   Typed "5"');
      await this.page!.waitForTimeout(800);
      
      // Tab 키를 눌러서 Lv5 선택
      await this.page!.keyboard.press('Tab');
      console.log('   Pressed Tab to select Lv5');
      await this.page!.waitForTimeout(500);
      
      // 3. Barbarian 레벨 6 선택
      console.log('   Step 2: Selecting Lv6 by typing "6"...');
      
      // 드롭다운 다시 클릭
      // @ts-ignore
      await this.page!.evaluate(() => {
        const legends = Array.from(document.querySelectorAll('legend'));
        const barbarianLegend = legends.find((legend: any) => 
          legend.textContent?.trim() === 'Arctic Barbarians'
        );
        const barbarianSection = barbarianLegend?.closest('li');
        const multiselectInput = barbarianSection?.querySelector('.multiselect__input') as HTMLInputElement;
        if (multiselectInput) {
          multiselectInput.focus();
          multiselectInput.click();
        }
      });
      
      await this.page!.waitForTimeout(500);
      
      // 입력란의 "5" 삭제 (Backspace)
      await this.page!.keyboard.press('Backspace');
      console.log('   Cleared "5"');
      await this.page!.waitForTimeout(300);
      
      // "6" 입력
      await this.page!.keyboard.type('6');
      console.log('   Typed "6"');
      await this.page!.waitForTimeout(800);
      
      // Tab 키를 눌러서 Lv6 선택
      await this.page!.keyboard.press('Tab');
      console.log('   Pressed Tab to select Lv6');
      await this.page!.waitForTimeout(500);
      
      // 4. Barbarian 레벨 7 선택
      console.log('   Step 3: Selecting Lv7 by typing "7"...');
      
      // 드롭다운 다시 클릭
      // @ts-ignore
      await this.page!.evaluate(() => {
        const legends = Array.from(document.querySelectorAll('legend'));
        const barbarianLegend = legends.find((legend: any) => 
          legend.textContent?.trim() === 'Arctic Barbarians'
        );
        const barbarianSection = barbarianLegend?.closest('li');
        const multiselectInput = barbarianSection?.querySelector('.multiselect__input') as HTMLInputElement;
        if (multiselectInput) {
          multiselectInput.focus();
          multiselectInput.click();
        }
      });
      
      await this.page!.waitForTimeout(500);
      
      // 입력란의 "6" 삭제 (Backspace)
      await this.page!.keyboard.press('Backspace');
      console.log('   Cleared "6"');
      await this.page!.waitForTimeout(300);
      
      // "7" 입력
      await this.page!.keyboard.type('7');
      console.log('   Typed "7"');
      await this.page!.waitForTimeout(800);
      
      // Tab 키를 눌러서 Lv7 선택
      await this.page!.keyboard.press('Tab');
      console.log('   Pressed Tab to select Lv7');
      await this.page!.waitForTimeout(500);
      
      // 선택된 항목 확인
      // @ts-ignore
      const selectedTags = await this.page!.evaluate(() => {
        const legends = Array.from(document.querySelectorAll('legend'));
        const barbarianLegend = legends.find((legend: any) => 
          legend.textContent?.trim() === 'Arctic Barbarians'
        );
        const barbarianSection = barbarianLegend?.closest('li');
        const tags = barbarianSection?.querySelectorAll('.multiselect__tag span');
        return Array.from(tags || []).map((tag: any) => tag.textContent?.trim());
      });
      
      console.log('   Selected barbarian levels:', selectedTags);

      // 5. "Apply" 버튼 클릭
      console.log('   Clicking "Apply" button...');
      // @ts-ignore - Running in browser context
      const applyClicked = await this.page!.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const applyButton = buttons.find((btn: any) => 
          btn.textContent?.toLowerCase().includes('apply')
        );
        
        if (applyButton) {
          (applyButton as any).click();
          return true;
        }
        return false;
      });

      if (applyClicked) {
        console.log('   ✅ "Apply" button clicked');
        console.log('   Waiting 15 seconds for results to load...');
        await this.page!.waitForTimeout(15000);
        
        // 페이지를 아래로 스크롤하여 모든 데이터 로드 (가상 스크롤 대응)
        console.log('   Scrolling page to load all data...');
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
        
        console.log('   Waiting 3 seconds after scroll...');
        await this.page!.waitForTimeout(3000);
      } else {
        console.log('   ⚠️ "Apply" button not found');
        await this.page!.screenshot({ path: 'debug-apply-button.png', fullPage: true });
      }

      // 6. 좌표 데이터 추출
      console.log('   Extracting coordinates from table...');
      // @ts-ignore - Running in browser context
      const coordinates = await this.page!.evaluate(() => {
        const results: any[] = [];
        const debugInfo: any[] = [];
        const levelCounts: { [key: number]: number } = {};
        
        // iScout 테이블 행 찾기
        const rows = document.querySelectorAll('tr');

        rows.forEach((row: any, index: number) => {
          try {
            // 아이템 이름 찾기 (Barbarian이 포함된 텍스트)
            const itemDiv = row.querySelector('div[data-tooltip-id*="clickboard_data"]');
            const itemText = itemDiv?.textContent?.trim() || '';
            
            // 처음 50개 행의 정보 수집 (디버깅용)
            if (index < 50 && itemText) {
              debugInfo.push({ index, itemText: itemText.substring(0, 60) });
            }
            
            // Barbarian이 아니면 스킵
            if (!itemText.includes('Barbarian')) {
              return;
            }
            
            // 레벨 추출하여 카운트
            const levelMatch = itemText.match(/Lv(\d+)/i) || itemText.match(/Level\s*(\d+)/i);
            if (levelMatch) {
              const level = parseInt(levelMatch[1]);
              levelCounts[level] = (levelCounts[level] || 0) + 1;
            }
            
            // 좌표 찾기 - data-tooltip-id 속성으로
            let xMatch = null;
            let yMatch = null;
            
            // data-tooltip-id에 _x 또는 _y가 포함된 요소 찾기
            const allDivs = row.querySelectorAll('div[data-tooltip-id]');
            for (const div of allDivs) {
              const tooltipId = (div as any).getAttribute('data-tooltip-id') || '';
              const divText = (div as any).textContent?.trim() || '';
              
              if (tooltipId.includes('_x') && !xMatch) {
                const test = divText.match(/X:\s*(\d+)/);
                if (test) xMatch = test;
              }
              
              if (tooltipId.includes('_y') && !yMatch) {
                const test = divText.match(/Y:\s*(\d+)/);
                if (test) yMatch = test;
              }
              
              if (xMatch && yMatch) break;
            }
            
            // 좌표를 찾지 못하면 스킵
            if (!xMatch || !yMatch) {
              return;
            }
            
            if (xMatch && yMatch) {
              const x = parseInt(xMatch[1]);
              const y = parseInt(yMatch[1]);
              
              // 레벨 추출 - "Lv4 Barbarian" -> 4 또는 "Barbarian Lv4" -> 4
              const levelMatch = itemText.match(/Lv(\d+)/i) || itemText.match(/Level\s*(\d+)/i);
              const level = levelMatch ? parseInt(levelMatch[1]) : 0;
              
              // 레벨 5, 6, 7만 수집 (다른 레벨은 무시)
              if (level !== 5 && level !== 6 && level !== 7) {
                return;
              }
              
              // 파워 정보 추출
              // 형태: "500M", "1.2B", "Power: 500M" 등
              let power = undefined;
              
              // 테이블의 모든 셀에서 파워 정보 찾기
              const cells = row.querySelectorAll('td, div');
              for (const cell of cells) {
                const cellText = (cell as any).textContent?.trim() || '';
                
                // "500M", "1.2B" 형태 찾기 (M = Million, B = Billion)
                const powerMatch = cellText.match(/([0-9.]+)\s*([MB])/i);
                
                if (powerMatch) {
                  const numValue = parseFloat(powerMatch[1]);
                  const unit = powerMatch[2].toUpperCase();
                  
                  if (!isNaN(numValue) && numValue > 0) {
                    // M = 1,000,000 (백만), B = 1,000,000,000 (십억)
                    if (unit === 'M') {
                      power = Math.round(numValue * 1000000);
                    } else if (unit === 'B') {
                      power = Math.round(numValue * 1000000000);
                    }
                    break;
                  }
                }
              }
              
              // Alliance 정보 추출 (있는 경우)
              const allianceDiv = row.querySelector('[data-tooltip-id*="alliance"]');
              const alliance = allianceDiv?.textContent?.trim() || undefined;
              
              results.push({
                x: x,
                y: y,
                level: level,
                power: power,
                alliance: alliance,
                timestamp: new Date().toISOString(),
              });
            }
          } catch (e) {
            // Skip invalid rows
          }
        });

        return { results, debugInfo, levelCounts, totalRows: rows.length };
      });

      console.log(`✅ Found ${coordinates.results.length} Barbarian coordinates (Lv5, Lv6, Lv7 only)`);
      return coordinates.results;

    } catch (error) {
      console.error('❌ Barbarian scraping failed:', error);
      
      // 에러 발생 시 디버그 정보 저장
      if (this.page) {
        await this.page.screenshot({ path: 'barbarian-error.png', fullPage: true });
        console.log('   💾 Error screenshot saved: barbarian-error.png');
      }
      
      console.log('⚠️ Returning empty array (no mock data)');
      return [];
    }
  }

  // Ares 좌표 크롤링
  async scrapeAres(): Promise<Coordinate[]> {
    console.log('⚡ Scraping Ares coordinates...');

    await this.initialize();
    await this.prepareForScraping(); // 매번 새로고침 + 로그인 확인 + List 버튼 클릭

    try {
      // Ares 페이지로 이동
      // TODO: 실제 URL로 교체
      await this.page!.goto(`${this.ISCOUT_URL}/ares`, { waitUntil: 'networkidle2' });

      await this.page!.waitForTimeout(2000);

      const coordinates = await this.page!.evaluate(() => {
        const results: any[] = [];
        // @ts-ignore - Running in browser context
        const rows = document.querySelectorAll('.coordinate-row, tr.ares, table tr');

        rows.forEach((row: any) => {
          try {
            const xText = row.querySelector('.x, .coord-x, td:nth-child(1)')?.textContent;
            const yText = row.querySelector('.y, .coord-y, td:nth-child(2)')?.textContent;
            const levelText = row.querySelector('.level, td:nth-child(3)')?.textContent;

            if (xText && yText) {
              results.push({
                x: parseInt(xText.replace(/\D/g, '')),
                y: parseInt(yText.replace(/\D/g, '')),
                level: levelText ? parseInt(levelText.replace(/\D/g, '')) : 0,
                timestamp: new Date().toISOString(),
              });
            }
          } catch (e) {
            // Skip invalid rows
          }
        });

        return results;
      });

      console.log(`✅ Found ${coordinates.length} Ares coordinates`);
      return coordinates;

    } catch (error) {
      console.error('❌ Ares scraping failed:', error);
      console.log('⚠️ Returning empty array (no mock data)');
      return [];
    }
  }

  // 피라미드 좌표 크롤링
  async scrapePyramid(): Promise<Coordinate[]> {
    console.log('🔺 Scraping Pyramid coordinates...');

    await this.initialize();
    await this.prepareForScraping(); // 매번 새로고침 + 로그인 확인 + List 버튼 클릭

    try {
      // 1. Relics/Pyramids 버튼 클릭
      console.log('   Clicking "Relics/Pyramids" button...');
      // @ts-ignore - Running in browser context
      const relicsPyramidsClicked = await this.page!.evaluate(() => {
        // 버튼들 중에서 "Relics/Pyramids" 텍스트가 포함된 것 찾기
        const buttons = Array.from(document.querySelectorAll('button'));
        const targetButton = buttons.find((btn: any) => 
          btn.textContent?.includes('Relics/Pyramids') ||
          btn.textContent?.includes('Relics') ||
          btn.textContent?.includes('Pyramids')
        );
        
        if (targetButton) {
          (targetButton as any).click();
          return true;
        }
        
        // 버튼이 아닌 div나 다른 요소일 수 있음
        const divs = Array.from(document.querySelectorAll('div, span, label'));
        const targetDiv = divs.find((el: any) => 
          el.textContent?.includes('Relics/Pyramids') &&
          el.onclick !== null
        );
        
        if (targetDiv) {
          (targetDiv as any).click();
          return true;
        }
        
        return false;
      });

      if (relicsPyramidsClicked) {
        console.log('   ✅ "Relics/Pyramids" button clicked');
        await this.page!.waitForTimeout(1000);
      } else {
        console.log('   ⚠️ "Relics/Pyramids" button not found, trying alternative selector...');
        // 스크린샷 저장하여 디버깅
        await this.page!.screenshot({ path: 'debug-pyramid-buttons.png', fullPage: true });
      }

      // 2. Pyramid 레벨 5 선택 (키보드 입력 방식)
      console.log('   Step 1: Selecting Lv5 by typing "5"...');
      
      // Pyramids input 찾아서 클릭
      // @ts-ignore
      await this.page!.evaluate(() => {
        const legends = Array.from(document.querySelectorAll('legend'));
        const pyramidLegend = legends.find((legend: any) => 
          legend.textContent?.trim() === 'Pyramids'
        );
        const pyramidSection = pyramidLegend?.closest('li');
        const multiselectInput = pyramidSection?.querySelector('.multiselect__input') as HTMLInputElement;
        if (multiselectInput) {
          multiselectInput.focus();
          multiselectInput.click();
        }
      });
      
      await this.page!.waitForTimeout(500);
      
      // "5" 입력
      await this.page!.keyboard.type('5');
      console.log('   Typed "5"');
      await this.page!.waitForTimeout(800);
      
      // Tab 키를 눌러서 Lv5 선택
      await this.page!.keyboard.press('Tab');
      console.log('   Pressed Tab to select Lv5');
      await this.page!.waitForTimeout(500);
      
      // 3. Pyramid 레벨 4 선택 (키보드 입력 방식)
      console.log('   Step 2: Selecting Lv4 by typing "4"...');
      
      // 드롭다운 다시 클릭
      // @ts-ignore
      await this.page!.evaluate(() => {
        const legends = Array.from(document.querySelectorAll('legend'));
        const pyramidLegend = legends.find((legend: any) => 
          legend.textContent?.trim() === 'Pyramids'
        );
        const pyramidSection = pyramidLegend?.closest('li');
        const multiselectInput = pyramidSection?.querySelector('.multiselect__input') as HTMLInputElement;
        if (multiselectInput) {
          multiselectInput.focus();
          multiselectInput.click();
        }
      });
      
      await this.page!.waitForTimeout(500);
      
      // 입력란의 "5" 삭제 (Backspace)
      await this.page!.keyboard.press('Backspace');
      console.log('   Cleared "5"');
      await this.page!.waitForTimeout(300);
      
      // "4" 입력
      await this.page!.keyboard.type('4');
      console.log('   Typed "4"');
      await this.page!.waitForTimeout(800);
      
      // Tab 키를 눌러서 Lv4 선택
      await this.page!.keyboard.press('Tab');
      console.log('   Pressed Tab to select Lv4');
      await this.page!.waitForTimeout(500);
      
      // 선택된 항목 확인
      // @ts-ignore
      const selectedTags = await this.page!.evaluate(() => {
        const legends = Array.from(document.querySelectorAll('legend'));
        const pyramidLegend = legends.find((legend: any) => 
          legend.textContent?.trim() === 'Pyramids'
        );
        const pyramidSection = pyramidLegend?.closest('li');
        const tags = pyramidSection?.querySelectorAll('.multiselect__tag span');
        return Array.from(tags || []).map((tag: any) => tag.textContent?.trim());
      });
      
      console.log('   Selected pyramid levels:', selectedTags);

      // 3. Apply 버튼 클릭
      console.log('   Clicking "Apply" button...');
      // @ts-ignore - Running in browser context
      const applyClicked = await this.page!.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const applyButton = buttons.find((btn: any) => 
          btn.textContent?.toLowerCase().includes('apply')
        );
        
        if (applyButton) {
          (applyButton as any).click();
          return true;
        }
        return false;
      });

      if (applyClicked) {
        console.log('   ✅ "Apply" button clicked');
        console.log('   Waiting 15 seconds for results to load...');
        await this.page!.waitForTimeout(15000);
        
        // 페이지를 아래로 스크롤하여 모든 데이터 로드 (가상 스크롤 대응)
        console.log('   Scrolling page to load all data...');
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
        
        console.log('   Waiting 3 seconds after scroll...');
        await this.page!.waitForTimeout(3000);
      } else {
        console.log('   ⚠️ "Apply" button not found');
        await this.page!.screenshot({ path: 'debug-apply-button.png', fullPage: true });
      }

      // 4. 좌표 데이터 추출
      console.log('   Extracting coordinates from table...');
      // @ts-ignore - Running in browser context
      const coordinates = await this.page!.evaluate(() => {
        const results: any[] = [];
        const debugInfo: any[] = [];
        const levelCounts: { [key: number]: number } = {};
        
        // iScout 테이블 행 찾기
        const rows = document.querySelectorAll('tr');

        rows.forEach((row: any, index: number) => {
          try {
            // 아이템 이름 찾기 (Pyramid가 포함된 텍스트)
            const itemDiv = row.querySelector('div[data-tooltip-id*="clickboard_data"]');
            const itemText = itemDiv?.textContent?.trim() || '';
            
            // 처음 50개 행의 정보 수집 (디버깅용)
            if (index < 50 && itemText) {
              debugInfo.push({ index, itemText: itemText.substring(0, 60) });
            }
            
            // Pyramid가 아니면 스킵
            if (!itemText.includes('Pyramid')) {
              return;
            }
            
            // 레벨 추출하여 카운트
            const levelMatch = itemText.match(/Lv(\d+)/);
            if (levelMatch) {
              const level = parseInt(levelMatch[1]);
              levelCounts[level] = (levelCounts[level] || 0) + 1;
            }
            
            // X 좌표 찾기 - data-tooltip-id에 _x가 포함된 요소
            const xDiv = row.querySelector('[data-tooltip-id$="_x"]');
            const xText = xDiv?.textContent?.trim() || '';
            
            // Y 좌표 찾기 - data-tooltip-id에 _y가 포함된 요소 (첫 번째 것 선택)
            const yDivs = row.querySelectorAll('[data-tooltip-id$="_y"]');
            // 첫 번째 _y 요소가 실제 Y 좌표 (두 번째는 XY 복사 버튼)
            const yText = yDivs[0]?.textContent?.trim() || '';
            
            // "X: 868" -> 868, "Y: 970" -> 970 형태에서 숫자 추출
            const xMatch = xText.match(/X:\s*(\d+)/);
            const yMatch = yText.match(/Y:\s*(\d+)/);
            
            if (xMatch && yMatch) {
              const x = parseInt(xMatch[1]);
              const y = parseInt(yMatch[1]);
              
              // 레벨 추출 - "Lv4 Pyramid Ruins" -> 4
              const levelMatch = itemText.match(/Lv(\d+)/);
              const level = levelMatch ? parseInt(levelMatch[1]) : 0;
              
              // 레벨 4, 5만 수집 (다른 레벨은 무시)
              if (level !== 4 && level !== 5) {
                return;
              }
              
              results.push({
                x: x,
                y: y,
                level: level,
                timestamp: new Date().toISOString(),
              });
            }
          } catch (e) {
            // Skip invalid rows
          }
        });

        return results;
      });

      console.log(`✅ Found ${coordinates.length} Pyramid coordinates (Lv4, Lv5 only)`);
      
      return coordinates;

    } catch (error) {
      console.error('❌ Pyramid scraping failed:', error);
      
      // 에러 발생 시 디버그 정보 저장
      if (this.page) {
        await this.page.screenshot({ path: 'pyramid-error.png', fullPage: true });
        console.log('   💾 Error screenshot saved: pyramid-error.png');
      }
      
      console.log('⚠️ Returning empty array (no mock data)');
      return [];
    }
  }

  // 모든 좌표 크롤링 (순차적으로 실행)
  async scrapeAll(): Promise<{
    barbarian: Coordinate[];
    ares: Coordinate[];
    pyramid: Coordinate[];
  }> {
    await this.initialize();

    try {
      console.log('📊 Starting full scrape...');
      const startTime = Date.now();

      // 순차적으로 크롤링 (동시 실행 시 페이지 navigation 충돌 방지)
      console.log('1️⃣ Scraping Pyramid...');
      const pyramid = await this.scrapePyramid();
      
      console.log('2️⃣ Scraping Barbarian...');
      const barbarian = await this.scrapeBarbarian();
      
      console.log('3️⃣ Scraping Ares...');
      const ares = await this.scrapeAres();

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`✅ Full scrape completed in ${duration}s`);
      console.log(`   - Barbarian: ${barbarian.length}`);
      console.log(`   - Ares: ${ares.length}`);
      console.log(`   - Pyramid: ${pyramid.length}`);

      return { barbarian, ares, pyramid };
    } catch (error) {
      console.error('❌ Scraping failed:', error);
      throw error;
    }
  }
}

// 싱글톤 인스턴스
export const scraper = new ScraperService();

