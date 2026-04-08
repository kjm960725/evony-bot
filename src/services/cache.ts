// Cache Manager - 크롤링 데이터 캐싱
import { Coordinate } from '../types/coordinate';

interface CacheData {
  barbarian: Coordinate[];
  ares: Coordinate[];
  witch: Coordinate[];
  goblin: Coordinate[];
  pyramid: Coordinate[];
}

type CacheType = keyof CacheData;

interface CacheMetadata {
  lastUpdate: Date;
  nextUpdate: Date;
  isUpdating: boolean;
}

class CacheManager {
  private data: CacheData = {
    barbarian: [],
    ares: [],
    witch: [],
    goblin: [],
    pyramid: [],
  };

  private metadata: CacheMetadata = {
    lastUpdate: new Date(0), // 1970-01-01
    nextUpdate: new Date(),
    isUpdating: false,
  };

  get(type: CacheType): Coordinate[] {
    return this.data[type];
  }

  set(type: CacheType, coordinates: Coordinate[]): void {
    this.data[type] = coordinates;
    this.metadata.lastUpdate = new Date();
  }

  setAll(data: CacheData): void {
    this.data = data;
    this.metadata.lastUpdate = new Date();
    this.metadata.nextUpdate = new Date(Date.now() + 15 * 60 * 1000);
    this.metadata.isUpdating = false;
  }

  getMetadata(): CacheMetadata {
    return { ...this.metadata };
  }

  setUpdating(isUpdating: boolean): void {
    this.metadata.isUpdating = isUpdating;
  }

  isValid(): boolean {
    const now = new Date();
    const timeSinceLastUpdate = now.getTime() - this.metadata.lastUpdate.getTime();
    return timeSinceLastUpdate < 15 * 60 * 1000;
  }

  hasData(): boolean {
    return this.data.barbarian.length > 0 || 
           this.data.ares.length > 0 || 
           this.data.witch.length > 0 ||
           this.data.goblin.length > 0 ||
           this.data.pyramid.length > 0;
  }

  clear(): void {
    this.data = {
      barbarian: [],
      ares: [],
      witch: [],
      goblin: [],
      pyramid: [],
    };
    this.metadata.lastUpdate = new Date(0);
  }
}

export const cache = new CacheManager();
