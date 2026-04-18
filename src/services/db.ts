// Prisma Database Service
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

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
  // 바바리안 파워 설정 관련 메서드
  // ===============================

  // 바바리안 파워 설정
  async setBarbarianPower(discordId: string, username: string, minPower: number, maxPower: number) {
    return await prisma.user.upsert({
      where: { discordId },
      update: {
        username,
        minPower: BigInt(minPower),
        maxPower: BigInt(maxPower),
      },
      create: {
        discordId,
        username,
        x: 0,
        y: 0,
        minPower: BigInt(minPower),
        maxPower: BigInt(maxPower),
      },
    });
  }

  // 바바리안 파워 설정 가져오기
  async getBarbarianPower(discordId: string) {
    const user = await prisma.user.findUnique({
      where: { discordId },
    });

    if (user && user.minPower !== null && user.maxPower !== null) {
      return {
        minPower: Number(user.minPower),
        maxPower: Number(user.maxPower),
      };
    }

    return null;
  }

  // ===============================
  // Player Watch 설정 영속화 (마지막 사용 설정 저장 / 재개)
  // ===============================

  /**
   * 마지막 Watch 설정 저장 (싱글톤 - 항상 id=1).
   * !watchresume 명령으로 재개 시 이 값을 사용.
   */
  async savePlayerWatchConfig(opts: {
    minPower: number;
    maxPower: number;
    names: string[];
    channelId: string;
  }) {
    const namesJson = JSON.stringify(opts.names);
    return await prisma.playerWatchConfig.upsert({
      where: { id: 1 },
      update: {
        minPower: opts.minPower,
        maxPower: opts.maxPower,
        names: namesJson,
        channelId: opts.channelId,
      },
      create: {
        id: 1,
        minPower: opts.minPower,
        maxPower: opts.maxPower,
        names: namesJson,
        channelId: opts.channelId,
      },
    });
  }

  /**
   * 저장된 Watch 설정 조회. 없으면 null.
   */
  async getPlayerWatchConfig(): Promise<{
    minPower: number;
    maxPower: number;
    names: string[];
    channelId: string;
    updatedAt: Date;
  } | null> {
    const cfg = await prisma.playerWatchConfig.findUnique({ where: { id: 1 } });
    if (!cfg) return null;
    let names: string[] = [];
    try {
      const parsed = JSON.parse(cfg.names);
      if (Array.isArray(parsed)) names = parsed.map(String);
    } catch {
      names = cfg.names
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);
    }
    return {
      minPower: cfg.minPower,
      maxPower: cfg.maxPower,
      names,
      channelId: cfg.channelId,
      updatedAt: cfg.updatedAt,
    };
  }

  /**
   * 저장된 Watch 설정 삭제.
   */
  async clearPlayerWatchConfig(): Promise<boolean> {
    try {
      await prisma.playerWatchConfig.delete({ where: { id: 1 } });
      return true;
    } catch {
      return false;
    }
  }

  // 데이터베이스 연결 종료
  async disconnect() {
    await prisma.$disconnect();
  }
}

// 싱글톤 인스턴스
export const db = new DatabaseService();
