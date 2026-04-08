// 좌표 타입 관련 유틸리티

export type CoordinateType = 'pyramid' | 'barbarian' | 'ares' | 'witch' | 'goblin' | 'monsters';

/**
 * 좌표 타입의 이모지 반환
 */
export function getTypeEmoji(type: CoordinateType): string {
  switch (type) {
    case 'pyramid': return '🔺';
    case 'barbarian': return '🗡️';
    case 'ares': return '⚡';
    case 'witch': return '🧙';
    case 'goblin': return '👺';
    case 'monsters': return '👾';
  }
}

/**
 * 좌표 타입의 이름 반환 (첫 글자 대문자)
 */
export function getTypeName(type: CoordinateType): string {
  switch (type) {
    case 'pyramid': return 'Pyramid';
    case 'barbarian': return 'Barbarian';
    case 'ares': return 'Ares';
    case 'witch': return 'Witch';
    case 'goblin': return 'Goblin';
    case 'monsters': return 'Monsters';
  }
}

/**
 * 좌표 타입의 색상 코드 반환 (Discord Embed용)
 */
export function getTypeColor(type: CoordinateType): number {
  switch (type) {
    case 'pyramid': return 0xffd700;
    case 'barbarian': return 0xff4444;
    case 'ares': return 0xffa500;
    case 'witch': return 0x9b59b6;
    case 'goblin': return 0x2ecc71;
    case 'monsters': return 0xff6600;
  }
}

