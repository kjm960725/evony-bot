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

  // 데이터베이스 연결 종료
  async disconnect() {
    await prisma.$disconnect();
  }
}

// 싱글톤 인스턴스
export const db = new DatabaseService();
