// 거리 계산 유틸리티
import { Coordinate } from '../types/coordinate';

/**
 * 두 좌표 간의 유클리드 거리 계산
 * @param x1 첫 번째 점의 X 좌표
 * @param y1 첫 번째 점의 Y 좌표
 * @param x2 두 번째 점의 X 좌표
 * @param y2 두 번째 점의 Y 좌표
 * @returns 거리
 */
export function calculateDistance(x1: number, y1: number, x2: number, y2: number): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
}

/**
 * 사용자 좌표를 기준으로 좌표 배열을 거리순으로 정렬
 * @param coordinates 정렬할 좌표 배열
 * @param userX 사용자 X 좌표
 * @param userY 사용자 Y 좌표
 * @returns 거리 정보가 추가된 정렬된 배열
 */
export function sortByDistance<T extends Coordinate>(
    coordinates: T[],
    userX: number,
    userY: number
): (T & { distance: number })[] {
    return coordinates
        .map(coord => ({
            ...coord,
            distance: calculateDistance(userX, userY, coord.x, coord.y),
        }))
        .sort((a, b) => a.distance - b.distance);
}

/**
 * 피라미드를 레벨 역순 → 거리순으로 정렬
 * @param pyramids 피라미드 배열
 * @param userX 사용자 X 좌표
 * @param userY 사용자 Y 좌표
 * @returns 정렬된 피라미드 배열 (거리 정보 포함)
 */
export function sortPyramids<T extends Coordinate>(
    pyramids: T[],
    userX: number,
    userY: number
): (T & { distance: number })[] {
    return pyramids
        .map(pyramid => ({
            ...pyramid,
            distance: calculateDistance(userX, userY, pyramid.x, pyramid.y),
        }))
        .sort((a, b) => {
            // 1순위: 레벨 역순 (높은 레벨 먼저)
            if (b.level !== a.level) {
                return b.level - a.level;
            }
            // 2순위: 거리순 (가까운 것 먼저)
            return a.distance - b.distance;
        });
}

