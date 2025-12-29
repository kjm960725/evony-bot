// 포맷팅 유틸리티

/**
 * 파워를 M, B 단위로 포맷팅
 * @param power 파워 값
 * @returns 포맷팅된 문자열
 */
export function formatPower(power: number): string {
  if (power >= 1000000000) {
    // 1B 이상
    const billions = power / 1000000000;
    return `${billions.toFixed(1)}B`;
  } else if (power >= 1000000) {
    // 1M 이상
    const millions = power / 1000000;
    return `${millions.toFixed(1)}M`;
  } else {
    // 1M 미만
    return power.toLocaleString();
  }
}

