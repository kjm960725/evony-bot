// Notification Service - DM 알림 발송
import { Client, EmbedBuilder } from 'discord.js';
import { Coordinate } from '../types/coordinate';
import { getTypeColor, getTypeEmoji, getTypeName } from '../utils/coordinateTypes';
import { calculateDistance } from '../utils/distance';
import { formatPower } from '../utils/format';
import { AlertType, db } from './db';

// 중복 알림 방지를 위한 거리 임계값
const DUPLICATE_DISTANCE_THRESHOLD = 10;

class NotificationService {
  private client: Client | null = null;

  // Discord 클라이언트 설정
  setClient(client: Client) {
    this.client = client;
    console.log('✅ Notification service initialized');
  }

  // 새로운 좌표 발견 시 알림 발송
  async sendAlerts(
    type: AlertType,
    newCoordinates: Coordinate[],
    previousCoordinates: Coordinate[]
  ): Promise<number> {
    if (!this.client) {
      console.warn('⚠️ Notification client not set');
      return 0;
    }

    // 새로 발견된 좌표 필터링 (이전에 없던 것)
    const previousSet = new Set(
      previousCoordinates.map(c => `${c.x},${c.y}`)
    );
    const actuallyNewCoords = newCoordinates.filter(
      c => !previousSet.has(`${c.x},${c.y}`)
    );

    if (actuallyNewCoords.length === 0) {
      return 0;
    }

    console.log(`🔔 Found ${actuallyNewCoords.length} new ${type} coordinates`);

    // 해당 타입에 알림을 설정한 사용자들 가져오기
    const alerts = await db.getActiveAlertsByType(type);

    if (alerts.length === 0) {
      return 0;
    }

    // 오래된 알림 기록 정리 (24시간 이상 지난 것)
    const cleanedCount = await db.cleanupOldSentAlerts();
    if (cleanedCount > 0) {
      console.log(`   🧹 Cleaned up ${cleanedCount} old sent alert records`);
    }

    console.log(`📤 Sending ${type} alerts to ${alerts.length} user(s)...`);

    let sentCount = 0;

    for (const alert of alerts) {
      try {
        // 사용자에게 맞는 좌표 필터링 (레벨, 거리, 파워)
        let matchingCoords = this.filterCoordinatesForUser(
          type,
          actuallyNewCoords,
          alert.minLevel,
          alert.maxDistance,
          alert.user?.x,
          alert.user?.y,
          alert.minPower ? Number(alert.minPower) : null,
          alert.maxPower ? Number(alert.maxPower) : null
        );

        if (matchingCoords.length === 0) {
          continue;
        }

        // 🔔 중복 알림 필터링: 이미 보낸 알림과 가까운 좌표 제외
        matchingCoords = await this.filterDuplicateAlerts(
          alert.discordId,
          type,
          matchingCoords
        );

        if (matchingCoords.length === 0) {
          continue;
        }

        // 바바리안인 경우 파워 내림차순으로 정렬
        if (type === 'barbarian') {
          matchingCoords.sort((a, b) => {
            const powerA = a.power || 0;
            const powerB = b.power || 0;
            return powerB - powerA;
          });
        }

        // Discord 사용자 가져오기
        const user = await this.client.users.fetch(alert.discordId);

        if (!user) {
          console.warn(`⚠️ User not found: ${alert.discordId}`);
          continue;
        }

        // DM 발송
        const embed = this.createAlertEmbed(type, matchingCoords, alert.user);
        await user.send({ embeds: [embed] });

        // 보낸 알림 기록 저장
        await this.saveSentAlertRecords(alert.discordId, type, matchingCoords);

        sentCount++;
        console.log(`   ✅ Sent ${matchingCoords.length} coord(s) to ${user.username}`);
      } catch (error) {
        console.error(`   ❌ Failed to send alert to ${alert.discordId}:`, error);
      }
    }

    return sentCount;
  }

  // 이미 보낸 알림과 가까운 좌표 제외
  private async filterDuplicateAlerts(
    discordId: string,
    type: AlertType,
    coordinates: (Coordinate & { distance?: number })[]
  ): Promise<(Coordinate & { distance?: number })[]> {
    const filtered: (Coordinate & { distance?: number })[] = [];

    for (const coord of coordinates) {
      // 해당 사용자의 동일 타입, 동일 레벨에 대한 보낸 알림 기록 조회
      const sentAlerts = await db.getSentAlerts(discordId, type, coord.level);

      // 이미 보낸 알림과 X, Y 차이가 10 이하인지 확인
      const isDuplicate = sentAlerts.some((sent: { x: number; y: number }) => {
        const xDiff = Math.abs(sent.x - coord.x);
        const yDiff = Math.abs(sent.y - coord.y);
        return xDiff <= DUPLICATE_DISTANCE_THRESHOLD && yDiff <= DUPLICATE_DISTANCE_THRESHOLD;
      });

      if (!isDuplicate) {
        filtered.push(coord);
      }
    }

    return filtered;
  }

  // 보낸 알림 기록 저장
  private async saveSentAlertRecords(
    discordId: string,
    type: AlertType,
    coordinates: Coordinate[]
  ): Promise<void> {
    const records = coordinates.map(coord => ({
      discordId,
      type,
      level: coord.level,
      power: coord.power,
      x: coord.x,
      y: coord.y,
    }));

    await db.saveSentAlerts(records);
  }

  // 사용자 설정에 맞는 좌표 필터링
  private filterCoordinatesForUser(
    type: AlertType,
    coordinates: Coordinate[],
    minLevel: number | null,
    maxDistance: number | null,
    userX: number | undefined | null,
    userY: number | undefined | null,
    minPower: number | null,
    maxPower: number | null
  ): (Coordinate & { distance?: number })[] {
    return coordinates.filter(coord => {
      // 최소 레벨 필터
      if (minLevel !== null && coord.level < minLevel) {
        return false;
      }

      // 파워 필터 (바바리안 전용, 설정된 경우만)
      if (type === 'barbarian' && minPower !== null && maxPower !== null) {
        if (coord.power === undefined) {
          return false; // 파워 정보 없으면 제외
        }
        if (coord.power < minPower || coord.power > maxPower) {
          return false; // 파워 범위 벗어나면 제외
        }
      }

      // 최대 거리 필터 (사용자 좌표가 있을 때만)
      if (maxDistance !== null && userX !== undefined && userX !== null && userY !== undefined && userY !== null) {
        const distance = calculateDistance(userX, userY, coord.x, coord.y);
        if (distance > maxDistance) {
          return false;
        }
        (coord as any).distance = Math.round(distance);
      }

      return true;
    });
  }

  // 알림 Embed 생성
  private createAlertEmbed(
    type: AlertType,
    coordinates: (Coordinate & { distance?: number })[],
    user: { x: number; y: number } | undefined | null
  ): EmbedBuilder {
    const typeEmoji = getTypeEmoji(type);
    const typeName = getTypeName(type);
    const typeColor = getTypeColor(type);

    const embed = new EmbedBuilder()
      .setTitle(`${typeEmoji} New ${typeName} Alert!`)
      .setDescription(`${coordinates.length} new ${typeName.toLowerCase()}(s) found!`)
      .setColor(typeColor)
      .setTimestamp();

    // 최대 10개까지만 표시
    const displayCoords = coordinates.slice(0, 10);

    displayCoords.forEach((coord, index) => {
      let value = `**X:** \`${coord.x}\` | **Y:** \`${coord.y}\``;
      if (coord.power !== undefined) {
        value += `\n⚔️ Power: ${formatPower(coord.power)}`;
      }
      if (coord.distance !== undefined) {
        value += `\n📏 Distance: ${coord.distance}`;
      }

      embed.addFields({
        name: `#${index + 1} - Level ${coord.level}`,
        value,
        inline: true,
      });
    });

    if (coordinates.length > 10) {
      embed.setFooter({
        text: `...and ${coordinates.length - 10} more. Use !${type} to see all.`
      });
    } else {
      embed.setFooter({
        text: `Use !${type} to see all coordinates`
      });
    }

    return embed;
  }
}

// 싱글톤 인스턴스
export const notification = new NotificationService();

