// Auto-update Scheduler - 5분마다 순환 크롤링
import { cache } from './cache';
import { scraper } from './scraper';
import { notification } from './notification';
import { CoordinateType, getTypeEmoji } from '../utils/coordinateTypes';
import { AlertType } from './db';

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
        const previousCoordinates = cache.get(cacheType);
        const coordinates = await this.scrapeByType(type);
        cache.set(cacheType, coordinates);

        if (coordinates.length > 0) {
          const alertsSent = await notification.sendAlerts(cacheType, coordinates, previousCoordinates);
          if (alertsSent > 0) {
            console.log(`   🔔 Sent ${alertsSent} alert(s)`);
          }
        }
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
    }
  }

  // Monsters 크롤링 → ares/witch/goblin 3종 캐시 저장 + 알림 발송
  private async updateMonsters(): Promise<void> {
    const prevAres = cache.get('ares');
    const prevWitch = cache.get('witch');
    const prevGoblin = cache.get('goblin');

    const { ares, witch, goblin } = await scraper.scrapeMonsters();

    cache.set('ares', ares);
    cache.set('witch', witch);
    cache.set('goblin', goblin);

    console.log(`   - Ares: ${ares.length}, Witch: ${witch.length}, Goblin: ${goblin.length}`);

    const alertTypes: { type: AlertType; coords: typeof ares; prev: typeof ares }[] = [
      { type: 'ares', coords: ares, prev: prevAres },
      { type: 'witch', coords: witch, prev: prevWitch },
      { type: 'goblin', coords: goblin, prev: prevGoblin },
    ];
    for (const { type, coords, prev } of alertTypes) {
      if (coords.length > 0) {
        const sent = await notification.sendAlerts(type, coords, prev);
        if (sent > 0) console.log(`   🔔 Sent ${sent} ${type} alert(s)`);
      }
    }
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
