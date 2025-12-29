// 좌표 타입 관련 유틸리티

export type CoordinateType = 'pyramid' | 'barbarian' | 'ares';

/**
 * 좌표 타입의 이모지 반환
 */
export function getTypeEmoji(type: CoordinateType): string {
  switch (type) {
    case 'pyramid': return '🔺';
    case 'barbarian': return '🗡️';
    case 'ares': return '⚡';
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
  }
}

/**
 * 좌표 타입의 색상 코드 반환 (Discord Embed용)
 */
export function getTypeColor(type: CoordinateType): number {
  switch (type) {
    case 'pyramid': return 0xffd700; // 금색
    case 'barbarian': return 0xff4444; // 빨간색
    case 'ares': return 0xffa500; // 주황색
  }
}

