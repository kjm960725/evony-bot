// Auto-update Scheduler - 5분마다 순환 크롤링
import { cache } from './cache';
import { scraper } from './scraper';
import { CoordinateType, getTypeEmoji } from '../utils/coordinateTypes';

class SchedulerService {
  private intervalId: NodeJS.Timeout | null = null;
  private readonly UPDATE_INTERVAL = 5 * 60 * 1000; // 5분 (밀리초)
  
  // 크롤링 순서: 피라미드 → 바바리안 → 몬스터(Ares+Witch+Goblin) → 피라미드...
  private readonly CRAWL_SEQUENCE: CoordinateType[] = ['pyramid', 'barbarian', 'monsters'];
  private currentIndex: number = 0;
  private nextUpdateTime: Date = new Date();

  start(): void {
    if (this.intervalId) {
      console.log('⚠️ Scheduler is already running');
      return;
    }

    console.log('🕐 Starting auto-update scheduler (5 min rotating interval)');
    console.log('📋 Crawl sequence: Pyramid → Barbarian → Monsters(Ares+Witch+Goblin) → Pyramid...');
    
    console.log('🚀 Initial crawl - fetching all coordinates...');
    this.updateAll();

    this.intervalId = setInterval(() => {
      this.updateNext();
    }, this.UPDATE_INTERVAL);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('🛑 Scheduler stopped');
    }
  }

  async forceUpdate(): Promise<void> {
    console.log('🔄 Force update requested - crawling all types');
    await this.updateAll();
  }

  /**
   * Player Watch 활성 시, 스케줄된 스크랩 종료 직후 Watch 필터를 재적용하여
   * Players 화면 + WS 리스닝 상태로 즉시 복귀시킨다.
   *
   * 순환 import 회피를 위해 dynamic import 사용 (player.ts → scheduler.ts 의존이 이미 있음).
   */
  private async reapplyWatchIfActive(): Promise<void> {
    try {
      const { playerWatchService } = await import('./player');
      if (!playerWatchService.isActive()) return;
      console.log('🔁 Scheduled scrape done — re-applying Watch filter to resume listening');
      await playerWatchService.reapplyAfterScrape();
    } catch (e) {
      console.error('⚠️ Failed to reapply Watch after scrape:', (e as Error).message);
    }
  }

  private async updateNext(): Promise<void> {
    if (cache.getMetadata().isUpdating) {
      console.log('⏭️ Update already in progress, skipping...');
      return;
    }

    const type = this.CRAWL_SEQUENCE[this.currentIndex];
    
    try {
      cache.setUpdating(true);
      console.log(`\n📡 Starting scheduled crawl [${this.currentIndex + 1}/3]...`);
      console.log(`🎯 Target: ${getTypeEmoji(type)} ${type.toUpperCase()}`);

      if (type === 'monsters') {
        await this.updateMonsters();
      } else {
        const cacheType = type as 'barbarian' | 'pyramid';
        const coordinates = await this.scrapeByType(type);
        cache.set(cacheType, coordinates);
      }
      
      this.nextUpdateTime = new Date(Date.now() + this.UPDATE_INTERVAL);
      
      console.log(`✅ ${type.toUpperCase()} crawl completed`);
      console.log(`   - Next crawl: ${this.getNextType()} in 5 minutes`);
      console.log(`   - Next update time: ${this.nextUpdateTime.toLocaleTimeString()}`);

      cache.setUpdating(false);
      this.currentIndex = (this.currentIndex + 1) % this.CRAWL_SEQUENCE.length;

    } catch (error) {
      console.error(`❌ ${type.toUpperCase()} crawl failed:`, error);
      cache.setUpdating(false);
    } finally {
      // 성공/실패와 무관하게 Watch 활성 시 즉시 리스닝 복귀
      await this.reapplyWatchIfActive();
    }
  }

  // Monsters 크롤링 → ares/witch/goblin 3종 캐시 저장
  private async updateMonsters(): Promise<void> {
    const { ares, witch, goblin } = await scraper.scrapeMonsters();

    cache.set('ares', ares);
    cache.set('witch', witch);
    cache.set('goblin', goblin);

    console.log(`   - Ares: ${ares.length}, Witch: ${witch.length}, Goblin: ${goblin.length}`);
  }

  private async updateAll(): Promise<void> {
    if (cache.getMetadata().isUpdating) {
      console.log('⏭️ Update already in progress, skipping...');
      return;
    }

    try {
      cache.setUpdating(true);
      console.log('📡 Starting full crawl (all types)...');

      const data = await scraper.scrapeAll();
      cache.setAll(data);

      this.nextUpdateTime = new Date(Date.now() + this.UPDATE_INTERVAL);

      console.log(`✅ Full crawl completed`);
      console.log(`   - Barbarian: ${data.barbarian.length}`);
      console.log(`   - Ares: ${data.ares.length}`);
      console.log(`   - Witch: ${data.witch.length}`);
      console.log(`   - Goblin: ${data.goblin.length}`);
      console.log(`   - Pyramid: ${data.pyramid.length}`);
      console.log(`   - Next scheduled crawl: ${this.getNextType()} at ${this.nextUpdateTime.toLocaleTimeString()}`);

    } catch (error) {
      console.error('❌ Full crawl failed:', error);
      cache.setUpdating(false);
    } finally {
      // 성공/실패와 무관하게 Watch 활성 시 즉시 리스닝 복귀
      await this.reapplyWatchIfActive();
    }
  }

  private async scrapeByType(type: CoordinateType) {
    switch (type) {
      case 'barbarian':
        return await scraper.scrapeBarbarian();
      case 'pyramid':
        return await scraper.scrapePyramid();
      case 'monsters': {
        const result = await scraper.scrapeMonsters();
        return [...result.ares, ...result.witch, ...result.goblin];
      }
      default:
        return [];
    }
  }

  private getNextType(): string {
    const nextIndex = (this.currentIndex) % this.CRAWL_SEQUENCE.length;
    return this.CRAWL_SEQUENCE[nextIndex].toUpperCase();
  }

  getTimeUntilNextUpdate(): number {
    const now = Date.now();
    const next = this.nextUpdateTime.getTime();
    return Math.max(0, Math.floor((next - now) / 1000));
  }

  getCurrentStatus(): { 
    current: string; 
    next: string; 
    sequence: string;
    timeUntilNext: number;
  } {
    const prevIndex = (this.currentIndex - 1 + this.CRAWL_SEQUENCE.length) % this.CRAWL_SEQUENCE.length;
    return {
      current: this.CRAWL_SEQUENCE[prevIndex].toUpperCase(),
      next: this.getNextType(),
      sequence: this.CRAWL_SEQUENCE.map(t => t.toUpperCase()).join(' → '),
      timeUntilNext: this.getTimeUntilNextUpdate(),
    };
  }
}

export const scheduler = new SchedulerService();
