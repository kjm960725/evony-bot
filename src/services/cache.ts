// Cache Manager - 크롤링 데이터 캐싱
import { Coordinate } from '../types/coordinate';

interface CacheData {
  barbarian: Coordinate[];
  ares: Coordinate[];
  pyramid: Coordinate[];
}

interface CacheMetadata {
  lastUpdate: Date;
  nextUpdate: Date;
  isUpdating: boolean;
}

class CacheManager {
  private data: CacheData = {
    barbarian: [],
    ares: [],
    pyramid: [],
  };

  private metadata: CacheMetadata = {
    lastUpdate: new Date(0), // 1970-01-01
    nextUpdate: new Date(),
    isUpdating: false,
  };

  // 데이터 가져오기
  get(type: 'barbarian' | 'ares' | 'pyramid'): Coordinate[] {
    return this.data[type];
  }

  // 데이터 저장 (기존 데이터를 완전히 교체)
  set(type: 'barbarian' | 'ares' | 'pyramid', coordinates: Coordinate[]): void {
    this.data[type] = coordinates;
    this.metadata.lastUpdate = new Date();
  }

  // 모든 데이터 저장
  setAll(data: CacheData): void {
    this.data = data;
    this.metadata.lastUpdate = new Date();
    this.metadata.nextUpdate = new Date(Date.now() + 15 * 60 * 1000); // 15분 후
    this.metadata.isUpdating = false;
  }

  // 메타데이터 가져오기
  getMetadata(): CacheMetadata {
    return { ...this.metadata };
  }

  // 업데이트 상태 설정
  setUpdating(isUpdating: boolean): void {
    this.metadata.isUpdating = isUpdating;
  }

  // 캐시가 유효한지 확인
  isValid(): boolean {
    const now = new Date();
    const timeSinceLastUpdate = now.getTime() - this.metadata.lastUpdate.getTime();
    return timeSinceLastUpdate < 15 * 60 * 1000; // 15분 이내
  }

  // 데이터가 있는지 확인
  hasData(): boolean {
    return this.data.barbarian.length > 0 || 
           this.data.ares.length > 0 || 
           this.data.pyramid.length > 0;
  }

  // 캐시 초기화
  clear(): void {
    this.data = {
      barbarian: [],
      ares: [],
      pyramid: [],
    };
    this.metadata.lastUpdate = new Date(0);
  }
}

// 싱글톤 인스턴스
export const cache = new CacheManager();

