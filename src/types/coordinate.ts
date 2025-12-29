// Coordinate type definitions

export interface Coordinate {
  x: number;
  y: number;
  level: number;
  power?: number;      // 파워 정보 (바바리안 등)
  alliance?: string;
  timestamp?: string;
}

