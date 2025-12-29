// Auto-update Scheduler - 5분마다 순환 크롤링
import { cache } from './cache';
import { scraper } from './scraper';
import { notification } from './notification';
import { CoordinateType, getTypeEmoji } from '../utils/coordinateTypes';

class SchedulerService {
  private intervalId: NodeJS.Timeout | null = null;
  private readonly UPDATE_INTERVAL = 5 * 60 * 1000; // 5분 (밀리초)
  
  // 크롤링 순서: 피라미드 → 바바리안 → 아레스 → 피라미드...
  private readonly CRAWL_SEQUENCE: CoordinateType[] = ['pyramid', 'barbarian', 'ares'];
  private currentIndex: number = 0;
  private nextUpdateTime: Date = new Date();

  // 스케줄러 시작
  start(): void {
    if (this.intervalId) {
      console.log('⚠️ Scheduler is already running');
      return;
    }

    console.log('🕐 Starting auto-update scheduler (5 min rotating interval)');
    console.log('📋 Crawl sequence: Pyramid → Barbarian → Ares → Pyramid...');
    
    // 시작 시 모든 타입 크롤링
    console.log('🚀 Initial crawl - fetching all coordinates...');
    this.updateAll();

    // 5분마다 순환 업데이트
    this.intervalId = setInterval(() => {
      this.updateNext();
    }, this.UPDATE_INTERVAL);
  }

  // 스케줄러 중지
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('🛑 Scheduler stopped');
    }
  }

  // 수동 업데이트 (refresh 명령어용) - 모든 타입 크롤링
  async forceUpdate(): Promise<void> {
    console.log('🔄 Force update requested - crawling all types');
    await this.updateAll();
  }

  // 다음 타입 업데이트 (순환)
  private async updateNext(): Promise<void> {
    // 이미 업데이트 중이면 스킵
    if (cache.getMetadata().isUpdating) {
      console.log('⏭️ Update already in progress, skipping...');
      return;
    }

    const type = this.CRAWL_SEQUENCE[this.currentIndex];
    
    try {
      cache.setUpdating(true);
      console.log(`\n📡 Starting scheduled crawl [${this.currentIndex + 1}/3]...`);
      console.log(`🎯 Target: ${getTypeEmoji(type)} ${type.toUpperCase()}`);

      // 이전 좌표 저장 (알림 비교용)
      const previousCoordinates = cache.get(type);

      // 해당 타입만 크롤링
      const coordinates = await this.scrapeByType(type);

      // 캐시에 저장
      cache.set(type, coordinates);
      
      // 다음 업데이트 시간 계산
      this.nextUpdateTime = new Date(Date.now() + this.UPDATE_INTERVAL);
      
      console.log(`✅ ${type.toUpperCase()} crawl completed`);
      console.log(`   - Found ${coordinates.length} coordinates`);
      console.log(`   - Next crawl: ${this.getNextType()} in 5 minutes`);
      console.log(`   - Next update time: ${this.nextUpdateTime.toLocaleTimeString()}`);

      // 🔔 알림 발송
      if (coordinates.length > 0) {
        const alertsSent = await notification.sendAlerts(type, coordinates, previousCoordinates);
        if (alertsSent > 0) {
          console.log(`   🔔 Sent ${alertsSent} alert(s)`);
        }
      }

      cache.setUpdating(false);

      // 다음 인덱스로 이동
      this.currentIndex = (this.currentIndex + 1) % this.CRAWL_SEQUENCE.length;

    } catch (error) {
      console.error(`❌ ${type.toUpperCase()} crawl failed:`, error);
      cache.setUpdating(false);
    }
  }

  // 모든 타입 크롤링 (강제 업데이트용)
  private async updateAll(): Promise<void> {
    if (cache.getMetadata().isUpdating) {
      console.log('⏭️ Update already in progress, skipping...');
      return;
    }

    try {
      cache.setUpdating(true);
      console.log('📡 Starting full crawl (all types)...');

      // 모든 좌표 크롤링
      const data = await scraper.scrapeAll();

      // 캐시에 저장
      cache.setAll(data);

      // 다음 업데이트 시간 계산
      this.nextUpdateTime = new Date(Date.now() + this.UPDATE_INTERVAL);

      console.log(`✅ Full crawl completed`);
      console.log(`   - Barbarian: ${data.barbarian.length}`);
      console.log(`   - Ares: ${data.ares.length}`);
      console.log(`   - Pyramid: ${data.pyramid.length}`);
      console.log(`   - Next scheduled crawl: ${this.getNextType()} at ${this.nextUpdateTime.toLocaleTimeString()}`);

    } catch (error) {
      console.error('❌ Full crawl failed:', error);
      cache.setUpdating(false);
    }
  }

  // 타입별 크롤링
  private async scrapeByType(type: CoordinateType) {
    switch (type) {
      case 'barbarian':
        return await scraper.scrapeBarbarian();
      case 'ares':
        return await scraper.scrapeAres();
      case 'pyramid':
        return await scraper.scrapePyramid();
    }
  }

  // 다음 크롤링 타입 가져오기
  private getNextType(): string {
    const nextIndex = (this.currentIndex) % this.CRAWL_SEQUENCE.length;
    return this.CRAWL_SEQUENCE[nextIndex].toUpperCase();
  }

  // 다음 업데이트까지 남은 시간 (초)
  getTimeUntilNextUpdate(): number {
    const now = Date.now();
    const next = this.nextUpdateTime.getTime();
    return Math.max(0, Math.floor((next - now) / 1000));
  }

  // 현재 크롤링 순서 정보
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

// 싱글톤 인스턴스
export const scheduler = new SchedulerService();

