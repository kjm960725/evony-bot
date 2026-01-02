// Prisma Database Service
import { PrismaClient } from '@prisma/client';

// PrismaClient 초기화
const prisma = new PrismaClient();

export type AlertType = 'pyramid' | 'barbarian' | 'ares';

export class DatabaseService {
  // ===============================
  // 사용자 좌표 관련 메서드
  // ===============================
  
  // 사용자 좌표 저장 또는 업데이트
  async setUserPosition(discordId: string, username: string, x: number, y: number) {
    return await prisma.user.upsert({
      where: { discordId },
      update: {
        username,
        x,
        y,
      },
      create: {
        discordId,
        username,
        x,
        y,
      },
    });
  }

  // 사용자 좌표 가져오기
  async getUserPosition(discordId: string) {
    return await prisma.user.findUnique({
      where: { discordId },
    });
  }

  // 모든 사용자 목록 가져오기
  async getAllUsers() {
    return await prisma.user.findMany({
      orderBy: {
        updatedAt: 'desc',
      },
    });
  }

  // ===============================
  // 알림 설정 관련 메서드
  // ===============================

  // 알림 설정 생성 또는 업데이트
  async setAlert(
    discordId: string, 
    username: string,
    type: AlertType, 
    minLevel?: number, 
    maxDistance?: number,
    minPower?: number,
    maxPower?: number
  ) {
    // 먼저 User가 존재하는지 확인하고 없으면 생성
    await prisma.user.upsert({
      where: { discordId },
      update: { username },
      create: {
        discordId,
        username,
        x: 0,
        y: 0,
      },
    });

    // 알림 설정 생성 또는 업데이트
    return await prisma.userAlert.upsert({
      where: {
        discordId_type: {
          discordId,
          type,
        },
      },
      update: {
        minLevel,
        maxDistance,
        minPower: minPower !== undefined ? BigInt(minPower) : undefined,
        maxPower: maxPower !== undefined ? BigInt(maxPower) : undefined,
        enabled: true,
      },
      create: {
        discordId,
        type,
        minLevel,
        maxDistance,
        minPower: minPower !== undefined ? BigInt(minPower) : undefined,
        maxPower: maxPower !== undefined ? BigInt(maxPower) : undefined,
        enabled: true,
      },
    });
  }

  // 바바리안 파워 설정 (간단 메서드)
  async setBarbarianPower(discordId: string, username: string, minPower: number, maxPower: number) {
    // 먼저 User가 존재하는지 확인하고 없으면 생성
    await prisma.user.upsert({
      where: { discordId },
      update: { username },
      create: {
        discordId,
        username,
        x: 0,
        y: 0,
      },
    });

    // 바바리안 알림 설정 업데이트 (없으면 생성)
    return await prisma.userAlert.upsert({
      where: {
        discordId_type: {
          discordId,
          type: 'barbarian',
        },
      },
      update: {
        minPower: BigInt(minPower),
        maxPower: BigInt(maxPower),
        enabled: true,
      },
      create: {
        discordId,
        type: 'barbarian',
        minPower: BigInt(minPower),
        maxPower: BigInt(maxPower),
        enabled: true,
      },
    });
  }

  // 바바리안 파워 설정 가져오기
  async getBarbarianPower(discordId: string) {
    const alert = await prisma.userAlert.findUnique({
      where: {
        discordId_type: {
          discordId,
          type: 'barbarian',
        },
      },
    });

    if (alert && alert.minPower !== null && alert.maxPower !== null) {
      return {
        minPower: Number(alert.minPower),
        maxPower: Number(alert.maxPower),
      };
    }

    return null;
  }

  // 사용자의 특정 타입 알림 가져오기
  async getAlert(discordId: string, type: AlertType) {
    return await prisma.userAlert.findUnique({
      where: {
        discordId_type: {
          discordId,
          type,
        },
      },
    });
  }

  // 사용자의 모든 알림 가져오기
  async getAllAlerts(discordId: string) {
    return await prisma.userAlert.findMany({
      where: { discordId },
      orderBy: { type: 'asc' },
    });
  }

  // 특정 타입에 활성화된 모든 알림 가져오기 (알림 발송용)
  async getActiveAlertsByType(type: AlertType) {
    return await prisma.userAlert.findMany({
      where: {
        type,
        enabled: true,
      },
      include: {
        user: true, // 사용자 좌표 정보도 함께 가져옴
      },
    });
  }

  // 알림 삭제
  async deleteAlert(discordId: string, type: AlertType) {
    try {
      await prisma.userAlert.delete({
        where: {
          discordId_type: {
            discordId,
            type,
          },
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  // 모든 알림 삭제
  async deleteAllAlerts(discordId: string) {
    const result = await prisma.userAlert.deleteMany({
      where: { discordId },
    });
    return result.count;
  }

  // 알림 활성화/비활성화
  async toggleAlert(discordId: string, type: AlertType, enabled: boolean) {
    return await prisma.userAlert.update({
      where: {
        discordId_type: {
          discordId,
          type,
        },
      },
      data: { enabled },
    });
  }

  // ===============================
  // 보낸 알림 기록 관련 메서드
  // ===============================

  // 보낸 알림 기록 저장
  async saveSentAlert(discordId: string, type: AlertType, level: number, x: number, y: number, power?: number) {
    return await prisma.sentAlert.create({
      data: {
        discordId,
        type,
        level,
        power,
        x,
        y,
      },
    });
  }

  // 보낸 알림 기록 일괄 저장
  async saveSentAlerts(alerts: { discordId: string; type: AlertType; level: number; power?: number; x: number; y: number }[]) {
    return await prisma.sentAlert.createMany({
      data: alerts,
    });
  }

  // 사용자의 특정 타입, 레벨에 대한 보낸 알림 기록 가져오기
  async getSentAlerts(discordId: string, type: AlertType, level: number) {
    return await prisma.sentAlert.findMany({
      where: {
        discordId,
        type,
        level,
      },
      orderBy: {
        sentAt: 'desc',
      },
    });
  }

  // 오래된 보낸 알림 기록 삭제 (24시간 이상 지난 것)
  async cleanupOldSentAlerts() {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const result = await prisma.sentAlert.deleteMany({
      where: {
        sentAt: {
          lt: yesterday,
        },
      },
    });
    return result.count;
  }

  // 데이터베이스 연결 종료
  async disconnect() {
    await prisma.$disconnect();
  }
}

// 싱글톤 인스턴스
export const db = new DatabaseService();

