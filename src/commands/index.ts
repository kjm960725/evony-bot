import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    Message,
} from "discord.js";
import * as fs from "fs";
import * as path from "path";
import { cache } from "../services/cache";
import { db } from "../services/db";
import { playerWatchService } from "../services/player";
import { scheduler } from "../services/scheduler";
import { Coordinate } from "../types/coordinate";
import {
    sortBarbarians,
    sortByDistance,
    sortPyramids,
} from "../utils/distance";
import { formatPower } from "../utils/format";

export interface Command {
  name: string;
  description: string;
  usage?: string;
  execute: (message: Message, args: string[]) => Promise<void>;
}

// 캐시에서 좌표 가져오기
async function fetchCoordinates(
  type: "barbarian" | "ares" | "witch" | "goblin" | "pyramid",
): Promise<Coordinate[]> {
  return cache.get(type);
}

// Help command
const helpCommand: Command = {
  name: "help",
  description: "Display all available commands",
  usage: "!help",
  execute: async (message: Message) => {
    const status = scheduler.getCurrentStatus();
    const minutes = Math.floor(status.timeUntilNext / 60);
    const seconds = status.timeUntilNext % 60;

    const embed = new EmbedBuilder()
      .setTitle("⚔️ Evony Bot Commands")
      .setDescription("Provides coordinate information for Evony game")
      .setColor(0x0099ff)
      .addFields(
        {
          name: "📍 Position Commands",
          value:
            "`!setpos <X> <Y>` - Save your coordinates\n`!mypos` - View your saved position\n`!positions` - View all users positions",
          inline: false,
        },
        {
          name: "🗺️ Coordinate Commands",
          value:
            "`!barbarian` (or `!bb`) - Barbarian coordinates (power sorted)\n`!ares` (or `!ar`) - Ares coordinates\n`!witch` (or `!wt`) - Mysterious Witch coordinates\n`!goblin` (or `!gb`) - Golden Goblin coordinates\n`!pyramid [level]` (or `!py [level]`) - Pyramid coordinates (e.g., `!py 5`)",
          inline: false,
        },
        {
          name: "⚔️ Barbarian Settings",
          value:
            "`!bbpower <min> <max>` (or `!bbp`) - Set power range (e.g., `!bbpower 500M 2B`)\n`!bbpower` - View your current power range",
          inline: false,
        },
        {
          name: "🫧 Player Watch (real-time bubble alerts)",
          value:
            "`!watch <minPower> <maxPower> <name1> [name2] [name3] ...` - Start watching players\n" +
            "`!watchstop` - Stop watching\n" +
            "`!watchresume` - Resume from last saved config (DB)\n" +
            "`!watchclear` - Delete saved watch config\n" +
            "`!watchstatus` - Show current watch status (incl. WS stats)\n" +
            'Example: `!watch 500M 2B Murda "Some Guy" Other`',
          inline: false,
        },
        {
          name: "⚙️ System Commands",
          value:
            "`!about` - How this bot works\n`!status` - Show cache status and schedule\n`!logs [lines]` - View recent server logs\n`!help` - Display this help message",
          inline: false,
        },
      )
      .addFields({
        name: "🔄 Auto-Crawl Schedule",
        value: `${status.sequence}\nRotating every 5 minutes\nNext: **${status.next}** in ${minutes}m ${seconds}s`,
        inline: false,
      })
      .setFooter({ text: "Commands start with ! | Power units: K, M, B" })
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  },
};

// Barbarian coordinates command
const barbarianCommand: Command = {
  name: "barbarian",
  description: "Display Barbarian coordinates",
  usage: "!barbarian",
  execute: async (message: Message, args: string[]) => {
    if (message.channel.isSendable()) {
      await message.channel.sendTyping();
    }

    try {
      // 파워 설정 확인
      const powerSettings = await db.getBarbarianPower(message.author.id);

      // 사용자 위치 확인
      const userPosition = await db.getUserPosition(message.author.id);

      let coordinates = await fetchCoordinates("barbarian");

      if (coordinates.length === 0) {
        const status = scheduler.getCurrentStatus();
        const embed = new EmbedBuilder()
          .setTitle("🗡️ Barbarian Coordinates")
          .setDescription(
            "⚠️ No barbarian coordinates available at the moment.",
          )
          .setColor(0xff9900)
          .addFields(
            {
              name: "🔄 Next Update",
              value: `In **${Math.floor(status.timeUntilNext / 60)}m ${status.timeUntilNext % 60}s**`,
              inline: true,
            },
            { name: "📅 Auto-Crawl", value: "Every 15 minutes", inline: true },
            {
              name: "💡 Tip",
              value:
                "Coordinates are automatically fetched from iScout.club\nTry again in a few minutes!",
              inline: false,
            },
          )
          .setFooter({ text: "Use !status to see the full crawl schedule" })
          .setTimestamp();

        await message.reply({ embeds: [embed] });
        return;
      }

      // 파워 필터링 (설정된 경우)
      let filteredByPower = 0;
      let filteredByNoPower = 0;
      const originalCount = coordinates.length;

      if (powerSettings) {
        coordinates = coordinates.filter((coord) => {
          if (coord.power === undefined) {
            filteredByNoPower++;
            return false;
          }
          if (
            coord.power < powerSettings.minPower ||
            coord.power > powerSettings.maxPower
          ) {
            filteredByPower++;
            return false;
          }
          return true;
        });
      }

      const totalFiltered = filteredByPower + filteredByNoPower;

      // 정렬: 1순위 파워 내림차순, 2순위 거리순 (사용자 위치 있을 때)
      let sortedCoordinates: (Coordinate & { distance?: number })[];
      if (userPosition) {
        sortedCoordinates = sortBarbarians(
          coordinates,
          userPosition.x,
          userPosition.y,
        );
      } else {
        // 사용자 위치 없으면 파워만으로 정렬
        sortedCoordinates = coordinates.sort((a, b) => {
          const powerA = a.power || 0;
          const powerB = b.power || 0;
          return powerB - powerA;
        });
      }

      const embed = new EmbedBuilder()
        .setTitle("🗡️ Barbarian Coordinates")
        .setColor(0xff4444)
        .setTimestamp();

      // 설명 메시지 구성
      let description = `Found ${sortedCoordinates.length} Barbarian${sortedCoordinates.length > 1 ? "s" : ""}`;

      // 정렬 정보 추가
      if (userPosition) {
        description += `\n📊 Sorted by: Power ↓ → Distance ↑`;
      } else {
        description += `\n📊 Sorted by: Power ↓`;
      }

      // 파워 설정 안내
      if (!powerSettings) {
        description +=
          `\n\n💡 **Tip**: Set your preferred power range with:\n` +
          `\`!bbpower <min> <max>\`\n` +
          `Example: \`!bbpower 500M 1B\` (500M ~ 1B)\n` +
          `Units: K, M, B (e.g., 100K, 500M, 1.5B)`;
      } else {
        const minPowerStr = formatPower(powerSettings.minPower);
        const maxPowerStr = formatPower(powerSettings.maxPower);
        description += `\n⚔️ Power range: **${minPowerStr} ~ ${maxPowerStr}**`;
        if (totalFiltered > 0) {
          description += `\n🔽 Filtered: ${totalFiltered}/${originalCount}`;
          if (filteredByNoPower > 0) {
            description += ` (${filteredByNoPower} no power data)`;
          }
        }
      }

      // 위치 미설정 안내
      if (!userPosition) {
        description += `\n\n💡 **Tip**: Use \`!setpos <X> <Y>\` to sort by distance`;
      }

      embed.setDescription(description);

      if (sortedCoordinates.length === 0) {
        await message.reply({
          embeds: [
            embed.setDescription(
              `⚠️ No barbarians found in your power range.\n` +
                `Current range: **${formatPower(powerSettings!.minPower)} ~ ${formatPower(powerSettings!.maxPower)}**\n\n` +
                `Use \`!bbpower <min> <max>\` to change your range.`,
            ),
          ],
        });
        return;
      }

      // Add fields (Discord embed 최대 25개 필드 제한)
      const maxDisplay = Math.min(sortedCoordinates.length, 25);
      sortedCoordinates.slice(0, maxDisplay).forEach((coord, index) => {
        let value = `X: \`${coord.x}\` Y: \`${coord.y}\``;
        if (coord.power !== undefined) {
          value += `\n⚔️ ${formatPower(coord.power)}`;
        }
        if (coord.distance !== undefined) {
          value += `\n📏 Distance: ${Math.round(coord.distance)}`;
        }
        if (coord.alliance) {
          value += `\n👥 ${coord.alliance}`;
        }

        embed.addFields({
          name: `#${index + 1} - Lv${coord.level}`,
          value,
          inline: true,
        });
      });

      if (sortedCoordinates.length > maxDisplay) {
        embed.setFooter({
          text: `Showing ${maxDisplay}/${sortedCoordinates.length}`,
        });
      }

      await message.reply({
        embeds: [embed],
      });
    } catch (error) {
      console.error("Failed to fetch Barbarian coordinates:", error);
      await message.reply(
        "❌ An error occurred while fetching coordinate information.",
      );
    }
  },
};

// Ares coordinates command
const aresCommand: Command = {
  name: "ares",
  description: "Display Ares coordinates",
  usage: "!ares",
  execute: async (message: Message, args: string[]) => {
    if (message.channel.isSendable()) {
      await message.channel.sendTyping();
    }

    try {
      // 사용자 위치 확인
      const userPosition = await db.getUserPosition(message.author.id);

      let coordinates = await fetchCoordinates("ares");

      if (coordinates.length === 0) {
        const status = scheduler.getCurrentStatus();
        const embed = new EmbedBuilder()
          .setTitle("⚡ Ares Coordinates")
          .setDescription("⚠️ No Ares coordinates available at the moment.")
          .setColor(0xff9900)
          .addFields(
            {
              name: "🔄 Next Update",
              value: `In **${Math.floor(status.timeUntilNext / 60)}m ${status.timeUntilNext % 60}s**`,
              inline: true,
            },
            { name: "📅 Auto-Crawl", value: "Every 15 minutes", inline: true },
            {
              name: "💡 Tip",
              value:
                "Ares coordinates are automatically fetched from iScout.club\nTry again in a few minutes!",
              inline: false,
            },
          )
          .setFooter({ text: "Use !status to see the full crawl schedule" })
          .setTimestamp();

        await message.reply({ embeds: [embed] });
        return;
      }

      // 거리순 정렬 (사용자 위치 있을 때)
      let sortedCoordinates: (Coordinate & { distance?: number })[];
      if (userPosition) {
        sortedCoordinates = sortByDistance(
          coordinates,
          userPosition.x,
          userPosition.y,
        );
      } else {
        sortedCoordinates = coordinates;
      }

      const embed = new EmbedBuilder()
        .setTitle("⚡ Ares Coordinates")
        .setDescription(
          `Found ${sortedCoordinates.length} Ares` +
            (userPosition
              ? "\n📊 Sorted by: Distance ↑"
              : "\n\n💡 **Tip**: Use `!setpos <X> <Y>` to sort by distance"),
        )
        .setColor(0xffa500)
        .setTimestamp();

      // Add fields (Discord embed 최대 25개 필드 제한)
      const maxDisplay = Math.min(sortedCoordinates.length, 25);
      sortedCoordinates.slice(0, maxDisplay).forEach((coord, index) => {
        let value = `X: \`${coord.x}\` Y: \`${coord.y}\``;
        if (coord.distance !== undefined) {
          value += `\n📏 Distance: ${Math.round(coord.distance)}`;
        }

        embed.addFields({
          name: `#${index + 1} - Lv${coord.level}`,
          value,
          inline: true,
        });
      });

      if (sortedCoordinates.length > maxDisplay) {
        embed.setFooter({
          text: `Showing ${maxDisplay}/${sortedCoordinates.length}`,
        });
      }

      await message.reply({
        embeds: [embed],
      });
    } catch (error) {
      console.error("Failed to fetch Ares coordinates:", error);
      await message.reply(
        "❌ An error occurred while fetching coordinate information.",
      );
    }
  },
};

// Pyramid coordinates command
const pyramidCommand: Command = {
  name: "pyramid",
  description:
    "Display Pyramid coordinates (sorted by level and distance from your position)",
  usage: "!pyramid [level]",
  execute: async (message: Message, args: string[]) => {
    if (message.channel.isSendable()) {
      await message.channel.sendTyping();
    }

    try {
      let coordinates = await fetchCoordinates("pyramid");

      if (coordinates.length === 0) {
        const status = scheduler.getCurrentStatus();
        const embed = new EmbedBuilder()
          .setTitle("🔺 Pyramid Coordinates")
          .setDescription("⚠️ No pyramid coordinates available at the moment.")
          .setColor(0xff9900)
          .addFields(
            {
              name: "🔄 Next Update",
              value: `In **${Math.floor(status.timeUntilNext / 60)}m ${status.timeUntilNext % 60}s**`,
              inline: true,
            },
            { name: "📅 Auto-Crawl", value: "Every 15 minutes", inline: true },
            {
              name: "🎯 Filter",
              value: "Auto-filter: **Lv4, Lv5** only",
              inline: true,
            },
            {
              name: "💡 Tip",
              value:
                "Pyramids are automatically fetched from iScout.club\nUse `!pyramid 5` to see Lv5 only",
              inline: false,
            },
          )
          .setFooter({ text: "Use !status to see the full crawl schedule" })
          .setTimestamp();

        await message.reply({ embeds: [embed] });
        return;
      }

      // 레벨 필터 (args[0]이 숫자면 해당 레벨만 필터링)
      let levelFilter: number | null = null;
      if (args.length > 0) {
        const level = parseInt(args[0]);
        if (!isNaN(level) && level >= 1 && level <= 10) {
          levelFilter = level;
          coordinates = coordinates.filter((c) => c.level === level);

          if (coordinates.length === 0) {
            const status = scheduler.getCurrentStatus();
            const totalCoords = (await fetchCoordinates("pyramid")).length;
            const embed = new EmbedBuilder()
              .setTitle(`🔺 Pyramid Coordinates - Level ${level}`)
              .setDescription(
                `⚠️ No Level ${level} pyramids available at the moment.`,
              )
              .setColor(0xff9900)
              .addFields(
                {
                  name: "📊 Total Pyramids",
                  value: `${totalCoords} (all levels)`,
                  inline: true,
                },
                {
                  name: "🔄 Next Update",
                  value: `In **${Math.floor(status.timeUntilNext / 60)}m ${status.timeUntilNext % 60}s**`,
                  inline: true,
                },
                {
                  name: "💡 Tip",
                  value: `Try \`!pyramid\` to see all levels\nOr wait for the next update in ${Math.floor(status.timeUntilNext / 60)} minutes`,
                  inline: false,
                },
              )
              .setFooter({ text: "Pyramids update every 15 minutes" })
              .setTimestamp();

            await message.reply({ embeds: [embed] });
            return;
          }
        } else if (!isNaN(level)) {
          await message.reply(
            "❌ Level must be between 1 and 10.\nExample: `!pyramid 5`",
          );
          return;
        }
      }

      // 사용자 좌표 가져오기
      const userPosition = await db.getUserPosition(message.author.id);

      let sortedCoords: (Coordinate & { distance?: number })[];
      let description = levelFilter
        ? `Found ${coordinates.length} Level ${levelFilter} Pyramid${coordinates.length > 1 ? "s" : ""}`
        : `Found ${coordinates.length} Pyramid${coordinates.length > 1 ? "s" : ""}`;

      if (userPosition) {
        // 사용자 좌표가 있으면 정렬 (레벨 역순 → 거리순)
        sortedCoords = sortPyramids(
          coordinates,
          userPosition.x,
          userPosition.y,
        );
        description += `\n📍 Sorted by distance from your position (${userPosition.x}, ${userPosition.y})`;
      } else {
        // 사용자 좌표가 없으면 레벨순으로만 정렬
        sortedCoords = coordinates.sort((a, b) => b.level - a.level);
        description += `\n💡 Use \`!setpos X Y\` to set your position for distance-based sorting`;
      }

      const titleSuffix = levelFilter ? ` - Level ${levelFilter}` : "";
      const embed = new EmbedBuilder()
        .setTitle(`🔺 Pyramid Coordinates${titleSuffix}`)
        .setDescription(description)
        .setColor(0xffd700)
        .setTimestamp();

      // Add fields (Discord embed 최대 25개 필드 제한)
      const maxDisplay = Math.min(sortedCoords.length, 25);
      sortedCoords.slice(0, maxDisplay).forEach((coord, index) => {
        let value = `X: \`${coord.x}\` Y: \`${coord.y}\``;
        if (coord.distance !== undefined) {
          value += ` 📏${Math.round(coord.distance)}`;
        }

        embed.addFields({
          name: `#${index + 1} - Lv${coord.level}`,
          value,
          inline: true,
        });
      });

      if (sortedCoords.length > maxDisplay) {
        embed.setFooter({
          text: `Showing ${maxDisplay}/${sortedCoords.length}`,
        });
      }

      await message.reply({
        embeds: [embed],
      });
    } catch (error) {
      console.error("Failed to fetch Pyramid coordinates:", error);
      await message.reply(
        "❌ An error occurred while fetching coordinate information.",
      );
    }
  },
};

// All Positions command - 모든 사용자 포지션 보기
const allPositionsCommand: Command = {
  name: "positions",
  description: "View all users positions",
  usage: "!positions",
  execute: async (message: Message, args: string[]) => {
    try {
      const allUsers = await db.getAllUsers();

      if (allUsers.length === 0) {
        await message.reply("ℹ️ No user positions saved yet.");
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle("📍 All User Positions")
        .setDescription(`${allUsers.length} user(s) have saved their positions`)
        .setColor(0x0099ff)
        .setTimestamp();

      // 최대 25개 필드 제한
      const maxDisplay = Math.min(allUsers.length, 25);
      allUsers
        .slice(0, maxDisplay)
        .forEach(
          (user: { username: string; x: number; y: number }, index: number) => {
            embed.addFields({
              name: `${index + 1}. ${user.username}`,
              value: `X: \`${user.x}\` Y: \`${user.y}\``,
              inline: true,
            });
          },
        );

      if (allUsers.length > maxDisplay) {
        embed.setFooter({
          text: `Showing ${maxDisplay}/${allUsers.length} users`,
        });
      }

      await message.reply({ embeds: [embed] });
    } catch (error) {
      console.error("Failed to get all positions:", error);
      await message.reply("❌ An error occurred while retrieving positions.");
    }
  },
};

// About command - 봇 작동 원리 설명
const aboutCommand: Command = {
  name: "about",
  description: "Explain how this bot works",
  usage: "!about",
  execute: async (message: Message) => {
    const embed = new EmbedBuilder()
      .setTitle("🤖 About Evony Bot")
      .setDescription(
        "Your intelligent hunting companion for Evony - Automated crawling, Smart filtering, Distance optimization!",
      )
      .setColor(0x5865f2)
      .addFields(
        {
          name: "🌐 Data Source",
          value:
            "Automated **Puppeteer** web scraping from **iScout.club**\n" +
            "• Stealth mode with anti-bot detection\n" +
            "• Auto-login with session persistence\n" +
            "• Cloudflare bypass capability",
          inline: false,
        },
        {
          name: "🔄 Auto-Update System",
          value:
            "**5-minute rotating schedule:**\n" +
            "`0min` 🔺 Pyramid → `5min` 🗡️ Barbarian → `10min` 👾 Monsters(Ares+Witch+Goblin) → `15min` 🔺 Pyramid...\n" +
            "→ Each type refreshes **every 15 minutes**\n" +
            "→ Check current status with `!status`",
          inline: false,
        },
        {
          name: "🗡️ Barbarian Intelligence",
          value:
            "**Premium features for barbarian hunting:**\n" +
            "• Auto-filter: **Lv5, 6, 7 only**\n" +
            "• `!bbpower 500M 2B` - Set your power range\n" +
            "• **2-tier sorting**: Power ↓ → Distance ↑\n" +
            "• Shows: Level, Power, Alliance, Distance",
          inline: false,
        },
        {
          name: "🔺 Pyramid Intelligence",
          value:
            "**Optimized for ruin hunting:**\n" +
            "• Auto-filter: **Lv4, 5 only**\n" +
            "• `!pyramid 5` - Show Lv5 only\n" +
            "• **2-tier sorting**: Level ↓ → Distance ↑\n" +
            "• Perfect for finding nearby high-level ruins",
          inline: false,
        },
        {
          name: "👾 Monsters (Ares + Witch + Goblin)",
          value:
            "**Crawled together in one pass:**\n" +
            "• `!ares` (`!ar`) - Ares Statue coordinates\n" +
            "• `!witch` (`!wt`) - Mysterious Witch coordinates\n" +
            "• `!goblin` (`!gb`) - Golden Goblin coordinates\n" +
            "• Distance-based sorting\n" +
            "• Auto-updates every 15 minutes",
          inline: false,
        },
        {
          name: "📍 Position System",
          value:
            "**Set your city location** (`!setpos X Y`):\n" +
            "✅ All coordinates sorted by distance\n" +
            "✅ Distance displayed for each target\n" +
            "→ **Find the closest targets instantly!**",
          inline: false,
        },
        {
          name: "💾 Database",
          value:
            "**SQLite + Prisma** stores your preferences:\n" +
            "• City coordinates (permanent)\n" +
            "• Power ranges (per user)",
          inline: false,
        },
        {
          name: "🚀 Quick Start Guide",
          value:
            "1️⃣ `!setpos 500 600` - Save your city location\n" +
            "2️⃣ `!bbpower 300M 1B` - Set barbarian power filter\n" +
            "3️⃣ `!bb` - View your personalized barbarian list!",
          inline: false,
        },
      )
      .setFooter({
        text: "Tech: Puppeteer + Prisma + Discord.js | Data: iScout.club | Use !help for all commands",
      })
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  },
};

// Status command - 캐시 상태 확인
const statusCommand: Command = {
  name: "status",
  description: "Show cache status and next update time",
  usage: "!status",
  execute: async (message: Message) => {
    const metadata = cache.getMetadata();
    const barbarianCount = cache.get("barbarian").length;
    const aresCount = cache.get("ares").length;
    const witchCount = cache.get("witch").length;
    const goblinCount = cache.get("goblin").length;
    const pyramidCount = cache.get("pyramid").length;
    const status = scheduler.getCurrentStatus();
    const minutes = Math.floor(status.timeUntilNext / 60);
    const seconds = status.timeUntilNext % 60;

    const embed = new EmbedBuilder()
      .setTitle("📊 Cache Status")
      .setColor(metadata.isUpdating ? 0xffa500 : 0x00ff00)
      .setDescription(
        `**Crawl Sequence:** ${status.sequence}\n**Rotating every 5 minutes**`,
      )
      .addFields(
        {
          name: "🗡️ Barbarian",
          value: `${barbarianCount} coordinates`,
          inline: true,
        },
        {
          name: "⚡ Ares",
          value: `${aresCount} coordinates`,
          inline: true,
        },
        {
          name: "🧙 Witch",
          value: `${witchCount} coordinates`,
          inline: true,
        },
        {
          name: "👺 Goblin",
          value: `${goblinCount} coordinates`,
          inline: true,
        },
        {
          name: "🔺 Pyramid",
          value: `${pyramidCount} coordinates`,
          inline: true,
        },
        {
          name: "📍 Last Crawled",
          value: status.current,
          inline: true,
        },
        {
          name: "🎯 Next Target",
          value: status.next,
          inline: true,
        },
        {
          name: "⏰ Next Crawl",
          value: `in ${minutes}m ${seconds}s`,
          inline: true,
        },
        {
          name: "🔄 Status",
          value: metadata.isUpdating ? "⏳ Crawling..." : "✅ Ready",
          inline: false,
        },
      )
      .setFooter({ text: "Use !refresh to crawl all types immediately" })
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  },
};

// Set Position command - 사용자 좌표 저장
const setPositionCommand: Command = {
  name: "setpos",
  description: "Set your coordinates for distance-based sorting",
  usage: "!setpos <X> <Y>",
  execute: async (message: Message, args: string[]) => {
    try {
      // 인수 검증
      if (args.length !== 2) {
        await message.reply(
          "❌ Usage: `!setpos <X> <Y>`\nExample: `!setpos 500 600`",
        );
        return;
      }

      const x = parseInt(args[0]);
      const y = parseInt(args[1]);

      // 숫자 검증
      if (isNaN(x) || isNaN(y)) {
        await message.reply(
          "❌ X and Y coordinates must be numbers.\nExample: `!setpos 500 600`",
        );
        return;
      }

      // 좌표 범위 검증 (Evony 맵은 0-9999)
      if (x < 0 || x > 9999 || y < 0 || y > 9999) {
        await message.reply("❌ Coordinates must be between 0 and 9999.");
        return;
      }

      // 데이터베이스에 저장
      await db.setUserPosition(
        message.author.id,
        message.author.username,
        x,
        y,
      );

      const embed = new EmbedBuilder()
        .setTitle("✅ Position Saved")
        .setDescription(`Your coordinates have been saved successfully!`)
        .setColor(0x00ff00)
        .addFields(
          { name: "Username", value: message.author.username, inline: true },
          { name: "X Coordinate", value: x.toString(), inline: true },
          { name: "Y Coordinate", value: y.toString(), inline: true },
        )
        .setFooter({
          text: "Pyramid, Barbarian, and Ares coordinates will now be sorted by distance",
        })
        .setTimestamp();

      await message.reply({ embeds: [embed] });
    } catch (error) {
      console.error("Failed to set user position:", error);
      await message.reply("❌ An error occurred while saving your position.");
    }
  },
};

// Get Position command - 사용자 좌표 조회
const getPositionCommand: Command = {
  name: "mypos",
  description: "View your saved coordinates",
  usage: "!mypos",
  execute: async (message: Message, args: string[]) => {
    try {
      const userPosition = await db.getUserPosition(message.author.id);

      if (!userPosition) {
        await message.reply(
          "❌ You haven't set your position yet.\nUse `!setpos <X> <Y>` to set your coordinates.",
        );
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle("📍 Your Position")
        .setColor(0x0099ff)
        .addFields(
          { name: "Username", value: userPosition.username, inline: true },
          {
            name: "X Coordinate",
            value: userPosition.x.toString(),
            inline: true,
          },
          {
            name: "Y Coordinate",
            value: userPosition.y.toString(),
            inline: true,
          },
        )
        .setFooter({
          text: `Last updated: ${userPosition.updatedAt.toLocaleString()}`,
        })
        .setTimestamp();

      await message.reply({ embeds: [embed] });
    } catch (error) {
      console.error("Failed to get user position:", error);
      await message.reply(
        "❌ An error occurred while retrieving your position.",
      );
    }
  },
};

// Logs command - 최근 서버 로그 보기 (페이징 지원)
const logsCommand: Command = {
  name: "logs",
  description: "View recent server logs with pagination",
  usage: "!logs [filter]  (filter: all, error, warn, info)",
  execute: async (message: Message, args: string[]) => {
    try {
      const logFile = path.join(process.cwd(), "logs", "out.log");

      // 로그 파일이 존재하지 않으면
      if (!fs.existsSync(logFile)) {
        await message.reply(
          "ℹ️ No log file found. Logs will be available after first crawl.",
        );
        return;
      }

      // 필터 파라미터 (all, error, warn, info)
      const filter = args[0]?.toLowerCase() || "all";

      // 로그 파일 읽기
      const logContent = fs.readFileSync(logFile, "utf-8");
      let allLines = logContent
        .trim()
        .split("\n")
        .filter((line) => line.length > 0);

      if (allLines.length === 0) {
        await message.reply("ℹ️ No logs available yet.");
        return;
      }

      // 민감한 정보 필터링 (비밀번호, 토큰 등)
      allLines = allLines.map((line) =>
        line
          .replace(/PASSWORD[^\s]*/gi, "PASSWORD***")
          .replace(/TOKEN[^\s]*/gi, "TOKEN***")
          .replace(/email[^\s]*@[^\s]*/gi, "email***@***"),
      );

      // 로그 레벨별 필터링
      let filteredLines = allLines;
      if (filter === "error") {
        filteredLines = allLines.filter(
          (line) =>
            line.includes("❌") ||
            line.includes("ERROR") ||
            line.includes("Failed"),
        );
      } else if (filter === "warn") {
        filteredLines = allLines.filter(
          (line) => line.includes("⚠️") || line.includes("WARN"),
        );
      } else if (filter === "info") {
        filteredLines = allLines.filter(
          (line) =>
            line.includes("✅") || line.includes("🔔") || line.includes("📡"),
        );
      }

      if (filteredLines.length === 0) {
        await message.reply(`ℹ️ No logs found for filter: ${filter}`);
        return;
      }

      // 페이지당 라인 수 (Discord Embed 제한 고려)
      const linesPerPage = 12;
      const totalPages = Math.ceil(filteredLines.length / linesPerPage);
      const currentPage = 1; // 첫 페이지부터 시작

      // 첫 페이지 표시
      await sendLogPage(
        message,
        filteredLines,
        currentPage,
        totalPages,
        linesPerPage,
        filter,
      );
    } catch (error) {
      console.error("Failed to read logs:", error);
      await message.reply("❌ An error occurred while reading logs.");
    }
  },
};

// 로그 페이지 전송 헬퍼 함수
async function sendLogPage(
  message: Message,
  allLines: string[],
  page: number,
  totalPages: number,
  linesPerPage: number,
  filter = "all",
) {
  // 현재 페이지의 로그 라인 추출
  const startIdx = (page - 1) * linesPerPage;
  const endIdx = Math.min(startIdx + linesPerPage, allLines.length);
  const pageLines = allLines.slice(startIdx, endIdx);

  // 로그 가독성 개선: 타임스탬프 단축 + 포맷팅
  const formattedLines = pageLines.map((line) => {
    // 타임스탬프 포맷 변경: "2025-12-24 07:24:00 +00:00:" → "07:24:00"
    let formatted = line.replace(
      /^\d{4}-\d{2}-\d{2}\s+(\d{2}:\d{2}:\d{2})\s+[+\-]\d{2}:\d{2}:\s*/,
      "$1 │ ",
    );

    // 로그 라인 길이 제한 (너무 긴 라인 잘라내기)
    const maxLineLength = 80;
    if (formatted.length > maxLineLength) {
      formatted = formatted.substring(0, maxLineLength - 3) + "...";
    }

    return formatted;
  });

  // Discord Embed 필드 값 길이 제한 (1024자)
  let logText = formattedLines.join("\n");

  // ANSI 색상 코드 블록 사용 (더 나은 가독성)
  let finalValue = `\`\`\`ansi\n${logText}\n\`\`\``;

  // 1024자 초과 시 점진적으로 줄임
  while (finalValue.length > 1024) {
    const cutLength = Math.min(
      logText.length - 100,
      finalValue.length - 1024 + 50,
    );
    logText = "...\n" + logText.slice(cutLength > 0 ? cutLength : 100);
    finalValue = `\`\`\`ansi\n${logText}\n\`\`\``;
  }

  // 필터 이모지
  const filterEmoji =
    filter === "error"
      ? "❌"
      : filter === "warn"
        ? "⚠️"
        : filter === "info"
          ? "ℹ️"
          : "📋";
  const filterText =
    filter === "all"
      ? "All Logs"
      : `${filterEmoji} ${filter.charAt(0).toUpperCase() + filter.slice(1)} Only`;

  const embed = new EmbedBuilder()
    .setTitle(`📋 Server Logs`)
    .setDescription(
      `${filterText} | Page ${page}/${totalPages} | Lines ${startIdx + 1}-${endIdx} of ${allLines.length}`,
    )
    .setColor(
      filter === "error" ? 0xff0000 : filter === "warn" ? 0xffa500 : 0x808080,
    )
    .addFields({
      name: "Logs",
      value: finalValue,
      inline: false,
    })
    .setFooter({ text: `Use buttons to navigate | Auto-expires in 15 minutes` })
    .setTimestamp();

  // 페이징 + 필터 버튼 (2줄)
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`logs_first_${filter}`)
      .setLabel("⏮️ First")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 1),
    new ButtonBuilder()
      .setCustomId(`logs_prev_${page}_${filter}`)
      .setLabel("⬅️ Prev")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page === 1),
    new ButtonBuilder()
      .setCustomId(`logs_page_${page}`)
      .setLabel(`📄 ${page}/${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`logs_next_${page}_${filter}`)
      .setLabel("Next ➡️")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page === totalPages),
    new ButtonBuilder()
      .setCustomId(`logs_last_${totalPages}_${filter}`)
      .setLabel("Last ⏭️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === totalPages),
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`logs_filter_all_${page}`)
      .setLabel("📋 All")
      .setStyle(filter === "all" ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`logs_filter_info_${page}`)
      .setLabel("ℹ️ Info")
      .setStyle(
        filter === "info" ? ButtonStyle.Success : ButtonStyle.Secondary,
      ),
    new ButtonBuilder()
      .setCustomId(`logs_filter_warn_${page}`)
      .setLabel("⚠️ Warn")
      .setStyle(
        filter === "warn" ? ButtonStyle.Success : ButtonStyle.Secondary,
      ),
    new ButtonBuilder()
      .setCustomId(`logs_filter_error_${page}`)
      .setLabel("❌ Error")
      .setStyle(
        filter === "error" ? ButtonStyle.Success : ButtonStyle.Secondary,
      ),
    new ButtonBuilder()
      .setCustomId(`logs_refresh_${page}_${filter}`)
      .setLabel("🔄 Refresh")
      .setStyle(ButtonStyle.Primary),
  );

  await message.reply({
    embeds: [embed],
    components: [row1, row2],
  });
}

// 파워 문자열을 숫자로 변환 (예: "500M" -> 500000000)
function parsePowerString(powerStr: string): number | null {
  const match = powerStr.match(/^([0-9.]+)\s*([KMB])$/i);
  if (!match) return null;

  const value = parseFloat(match[1]);
  const unit = match[2].toUpperCase();

  if (isNaN(value) || value <= 0) return null;

  switch (unit) {
    case "K":
      return Math.round(value * 1000);
    case "M":
      return Math.round(value * 1000000);
    case "B":
      return Math.round(value * 1000000000);
    default:
      return null;
  }
}

// Barbarian Power Range command
const barbarianPowerCommand: Command = {
  name: "bbpower",
  description: "Set your preferred barbarian power range",
  usage: "!bbpower <min> <max> (예: !bbpower 500M 2B)",
  execute: async (message: Message, args: string[]) => {
    try {
      // 인자 없이 호출 시 현재 설정 표시
      if (args.length === 0) {
        const settings = await db.getBarbarianPower(message.author.id);

        if (!settings) {
          const embed = new EmbedBuilder()
            .setTitle("⚔️ Barbarian Power Range")
            .setDescription("You have not set a power range yet.")
            .setColor(0xffa500)
            .addFields(
              {
                name: "📖 Usage",
                value: "`!bbpower <min> <max>`",
                inline: false,
              },
              {
                name: "💡 Example",
                value: "`!bbpower 500M 2B`\n500M ~ 2B power range",
                inline: false,
              },
              {
                name: "📏 Units",
                value: "K (thousand)\nM (million)\nB (billion)",
                inline: true,
              },
              {
                name: "📝 More Examples",
                value: "`!bbpower 100M 1B`\n`!bbpower 1B 5B`",
                inline: true,
              },
            )
            .setFooter({
              text: "Set a power range to filter barbarian results",
            })
            .setTimestamp();

          await message.reply({ embeds: [embed] });
          return;
        }

        const embed = new EmbedBuilder()
          .setTitle("⚔️ Your Barbarian Power Range")
          .setDescription("Current power filter settings")
          .setColor(0x00ff00)
          .addFields(
            { name: "Username", value: message.author.username, inline: true },
            {
              name: "Min Power",
              value: formatPower(settings.minPower),
              inline: true,
            },
            {
              name: "Max Power",
              value: formatPower(settings.maxPower),
              inline: true,
            },
          )
          .setFooter({ text: "Use !bbpower <min> <max> to change your range" })
          .setTimestamp();

        await message.reply({ embeds: [embed] });
        return;
      }

      // 2개 인자 필요
      if (args.length !== 2) {
        await message.reply(
          "❌ Usage: `!bbpower <min> <max>`\nExample: `!bbpower 500M 2B`",
        );
        return;
      }

      const minPower = parsePowerString(args[0]);
      const maxPower = parsePowerString(args[1]);

      if (minPower === null || maxPower === null) {
        await message.reply(
          "❌ Invalid power format.\n**Valid formats**: 100K, 500M, 1.5B\n**Units**: K, M, B",
        );
        return;
      }

      if (minPower >= maxPower) {
        await message.reply(
          "❌ Minimum power must be less than maximum power.",
        );
        return;
      }

      // DB에 저장
      await db.setBarbarianPower(
        message.author.id,
        message.author.username,
        minPower,
        maxPower,
      );

      const embed = new EmbedBuilder()
        .setTitle("✅ Power Range Saved")
        .setDescription("Your barbarian power range has been set successfully!")
        .setColor(0x00ff00)
        .addFields(
          { name: "Username", value: message.author.username, inline: true },
          { name: "Min Power", value: formatPower(minPower), inline: true },
          { name: "Max Power", value: formatPower(maxPower), inline: true },
        )
        .setFooter({ text: "Use !bb or !barbarian to see filtered results" })
        .setTimestamp();

      await message.reply({ embeds: [embed] });
    } catch (error) {
      console.error("Failed to set barbarian power:", error);
      await message.reply("❌ An error occurred while setting power range.");
    }
  },
};

// Witch coordinates command
const witchCommand: Command = {
  name: "witch",
  description: "Display Mysterious Witch coordinates",
  usage: "!witch",
  execute: async (message: Message, args: string[]) => {
    if (message.channel.isSendable()) {
      await message.channel.sendTyping();
    }

    try {
      const userPosition = await db.getUserPosition(message.author.id);
      let coordinates = await fetchCoordinates("witch");

      if (coordinates.length === 0) {
        const status = scheduler.getCurrentStatus();
        const embed = new EmbedBuilder()
          .setTitle("🧙 Witch Coordinates")
          .setDescription("⚠️ No Mysterious Witch coordinates available at the moment.")
          .setColor(0x9b59b6)
          .addFields(
            {
              name: "🔄 Next Update",
              value: `In **${Math.floor(status.timeUntilNext / 60)}m ${status.timeUntilNext % 60}s**`,
              inline: true,
            },
            { name: "📅 Auto-Crawl", value: "Every 15 minutes", inline: true },
          )
          .setTimestamp();

        await message.reply({ embeds: [embed] });
        return;
      }

      let sortedCoordinates: (Coordinate & { distance?: number })[];
      if (userPosition) {
        sortedCoordinates = sortByDistance(coordinates, userPosition.x, userPosition.y);
      } else {
        sortedCoordinates = coordinates;
      }

      const embed = new EmbedBuilder()
        .setTitle("🧙 Mysterious Witch Coordinates")
        .setDescription(
          `Found ${sortedCoordinates.length} Mysterious Witch` +
            (userPosition
              ? "\n📊 Sorted by: Distance ↑"
              : "\n\n💡 **Tip**: Use `!setpos <X> <Y>` to sort by distance"),
        )
        .setColor(0x9b59b6)
        .setTimestamp();

      const maxDisplay = Math.min(sortedCoordinates.length, 25);
      sortedCoordinates.slice(0, maxDisplay).forEach((coord, index) => {
        let value = `X: \`${coord.x}\` Y: \`${coord.y}\``;
        if (coord.distance !== undefined) {
          value += `\n📏 Distance: ${Math.round(coord.distance)}`;
        }
        embed.addFields({
          name: `#${index + 1}`,
          value,
          inline: true,
        });
      });

      if (sortedCoordinates.length > maxDisplay) {
        embed.setFooter({ text: `Showing ${maxDisplay}/${sortedCoordinates.length}` });
      }

      await message.reply({ embeds: [embed] });
    } catch (error) {
      console.error("Failed to fetch Witch coordinates:", error);
      await message.reply("❌ An error occurred while fetching coordinate information.");
    }
  },
};

// Goblin coordinates command
const goblinCommand: Command = {
  name: "goblin",
  description: "Display Golden Goblin coordinates",
  usage: "!goblin",
  execute: async (message: Message, args: string[]) => {
    if (message.channel.isSendable()) {
      await message.channel.sendTyping();
    }

    try {
      const userPosition = await db.getUserPosition(message.author.id);
      let coordinates = await fetchCoordinates("goblin");

      if (coordinates.length === 0) {
        const status = scheduler.getCurrentStatus();
        const embed = new EmbedBuilder()
          .setTitle("👺 Goblin Coordinates")
          .setDescription("⚠️ No Golden Goblin coordinates available at the moment.")
          .setColor(0x2ecc71)
          .addFields(
            {
              name: "🔄 Next Update",
              value: `In **${Math.floor(status.timeUntilNext / 60)}m ${status.timeUntilNext % 60}s**`,
              inline: true,
            },
            { name: "📅 Auto-Crawl", value: "Every 15 minutes", inline: true },
          )
          .setTimestamp();

        await message.reply({ embeds: [embed] });
        return;
      }

      let sortedCoordinates: (Coordinate & { distance?: number })[];
      if (userPosition) {
        sortedCoordinates = sortByDistance(coordinates, userPosition.x, userPosition.y);
      } else {
        sortedCoordinates = coordinates;
      }

      const embed = new EmbedBuilder()
        .setTitle("👺 Golden Goblin Coordinates")
        .setDescription(
          `Found ${sortedCoordinates.length} Golden Goblin` +
            (userPosition
              ? "\n📊 Sorted by: Distance ↑"
              : "\n\n💡 **Tip**: Use `!setpos <X> <Y>` to sort by distance"),
        )
        .setColor(0x2ecc71)
        .setTimestamp();

      const maxDisplay = Math.min(sortedCoordinates.length, 25);
      sortedCoordinates.slice(0, maxDisplay).forEach((coord, index) => {
        let value = `X: \`${coord.x}\` Y: \`${coord.y}\``;
        if (coord.distance !== undefined) {
          value += `\n📏 Distance: ${Math.round(coord.distance)}`;
        }
        embed.addFields({
          name: `#${index + 1}`,
          value,
          inline: true,
        });
      });

      if (sortedCoordinates.length > maxDisplay) {
        embed.setFooter({ text: `Showing ${maxDisplay}/${sortedCoordinates.length}` });
      }

      await message.reply({ embeds: [embed] });
    } catch (error) {
      console.error("Failed to fetch Goblin coordinates:", error);
      await message.reply("❌ An error occurred while fetching coordinate information.");
    }
  },
};

/**
 * 큰따옴표를 인식하는 토크나이저.
 * 예) `500M 2B "Murda Inc." Player2` → ["500M", "2B", "Murda Inc.", "Player2"]
 */
function tokenizeWithQuotes(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i])) i++;
    if (i >= input.length) break;

    if (input[i] === '"' || input[i] === "'") {
      const quote = input[i];
      i++;
      let end = input.indexOf(quote, i);
      if (end === -1) end = input.length;
      tokens.push(input.substring(i, end));
      i = end + 1;
    } else {
      let end = i;
      while (end < input.length && !/\s/.test(input[end])) end++;
      tokens.push(input.substring(i, end));
      i = end;
    }
  }
  return tokens;
}

/**
 * Watch 모드 시작 명령.
 * 사용법: `!watch <minPower> <maxPower> <name1> [name2] [name3] ...`
 *   - 파워 단위: K / M / B (예: 500M, 2B)
 *   - 공백을 포함한 이름은 따옴표로 감싸기 (예: "Murda Inc.")
 *
 * 동작:
 *   1) 기존 자동 크롤링 스케줄러를 중단
 *   2) iScout Players 섹션을 열고 Power 범위 + Bubble=No 필터 적용
 *   3) 페이지에 옵저버를 설치해 새 결과 행을 실시간 감지
 *   4) Watch 대상 이름과 매칭되면 명령을 실행한 채널로 즉시 알림
 */
const watchCommand: Command = {
  name: "watch",
  description:
    "Start Player Watch: real-time bubble-down alerts for specified players (stops auto-crawling)",
  usage:
    "!watch <minPower> <maxPower> <name1> [name2] [name3] ...  (e.g. !watch 500M 2B Murda \"Some Guy\")",
  execute: async (message: Message, args: string[]) => {
    try {
      // 원본 메시지에서 커맨드 이름 뒤의 raw 문자열을 추출 → 따옴표 인식 토큰화
      const raw = message.content.trim();
      const afterPrefix = raw.replace(/^![\w]+\s*/i, "");
      const tokens = tokenizeWithQuotes(afterPrefix);

      if (tokens.length < 3) {
        await message.reply(
          "❌ Usage: `!watch <minPower> <maxPower> <name1> [name2] [name3] ...`\n" +
            'Example: `!watch 500M 2B Murda "Some Guy" Other`\n' +
            "Power units: K, M, B",
        );
        return;
      }

      const minPowerRaw = tokens[0];
      const maxPowerRaw = tokens[1];
      const names = tokens.slice(2);

      const minPower = parsePowerString(minPowerRaw);
      const maxPower = parsePowerString(maxPowerRaw);

      if (minPower === null || maxPower === null) {
        await message.reply(
          "❌ Invalid power format.\n**Valid formats**: 100K, 500M, 1.5B\n**Units**: K, M, B",
        );
        return;
      }
      if (minPower >= maxPower) {
        await message.reply("❌ Minimum power must be less than maximum power.");
        return;
      }

      // iScout Power 입력은 Million 단위 - 내부 절대값 → M 단위 변환
      const minPowerM = Math.max(1, Math.round(minPower / 1_000_000));
      const maxPowerM = Math.max(minPowerM + 1, Math.round(maxPower / 1_000_000));

      const channel = message.channel;
      if (!channel || !channel.isSendable()) {
        await message.reply(
          "❌ This command must be used in a channel where the bot can send messages.",
        );
        return;
      }

      // 시작 임시 응답 (시간이 걸리는 작업 안내)
      const startingEmbed = new EmbedBuilder()
        .setTitle("🫧 Starting Player Watch...")
        .setDescription(
          `Stopping auto-crawler and applying Players filter.\nThis takes ~10–20 seconds.`,
        )
        .setColor(0xffa500)
        .addFields(
          {
            name: "Power Range",
            value: `${formatPower(minPower)} ~ ${formatPower(maxPower)} (${minPowerM}M ~ ${maxPowerM}M)`,
            inline: false,
          },
          {
            name: "Watch Targets",
            value: names.map((n) => `• ${n}`).join("\n"),
            inline: false,
          },
        )
        .setTimestamp();
      await message.reply({ embeds: [startingEmbed] });

      try {
        await playerWatchService.start({
          channelId: channel.id,
          channelSend: (payload: any) => (channel as any).send(payload),
          minPower: minPowerM,
          maxPower: maxPowerM,
          names,
        });
      } catch (err) {
        console.error("❌ Watch start failed:", err);
        const errEmbed = new EmbedBuilder()
          .setTitle("❌ Player Watch Failed to Start")
          .setDescription(
            `Error: ${err instanceof Error ? err.message : String(err)}\n\nThe auto-crawler has been restored.`,
          )
          .setColor(0xff0000)
          .setTimestamp();
        await channel.send({ embeds: [errEmbed] });
        return;
      }

      const okEmbed = new EmbedBuilder()
        .setTitle("✅ Player Watch Active")
        .setDescription(
          "Real-time alerts will be posted in this channel whenever a target's bubble drops.\nUse `!watchstop` to end Player Watch and resume auto-crawling.",
        )
        .setColor(0x00ff00)
        .addFields(
          {
            name: "Power Range",
            value: `${formatPower(minPower)} ~ ${formatPower(maxPower)}`,
            inline: false,
          },
          {
            name: "Watch Targets",
            value: names.map((n) => `• ${n}`).join("\n"),
            inline: false,
          },
          {
            name: "Cooldown",
            value: "Each target re-notifies after 5 minutes",
            inline: false,
          },
        )
        .setTimestamp();
      await channel.send({ embeds: [okEmbed] });
    } catch (error) {
      console.error("Failed to start Player Watch:", error);
      await message.reply("❌ An error occurred while starting Player Watch.");
    }
  },
};

/**
 * Watch 모드 종료 명령.
 * 옵저버 해제 + 기존 스케줄러 재시작.
 */
const watchStopCommand: Command = {
  name: "watchstop",
  description: "Stop Player Watch and resume auto-crawling",
  usage: "!watchstop",
  execute: async (message: Message) => {
    try {
      if (!playerWatchService.isActive()) {
        await message.reply("ℹ️ Player Watch is not currently active.");
        return;
      }

      const status = playerWatchService.getStatus();

      const stoppingEmbed = new EmbedBuilder()
        .setTitle("🛑 Stopping Player Watch...")
        .setDescription("Disconnecting observer and restarting auto-crawler.")
        .setColor(0xffa500)
        .setTimestamp();
      await message.reply({ embeds: [stoppingEmbed] });

      await playerWatchService.stop();

      const okEmbed = new EmbedBuilder()
        .setTitle("✅ Player Watch Stopped")
        .setDescription(
          "Auto-crawling has been resumed (Pyramid → Barbarian → Monsters).",
        )
        .setColor(0x00ff00)
        .addFields({
          name: "Was Monitoring",
          value: status.targetNames.length > 0
            ? status.targetNames.map((n) => `• ${n}`).join("\n")
            : "(none)",
          inline: false,
        })
        .setTimestamp();
      await message.reply({ embeds: [okEmbed] });
    } catch (error) {
      console.error("Failed to stop Player Watch:", error);
      await message.reply("❌ An error occurred while stopping Player Watch.");
    }
  },
};

/** 현재 Watch 모드 상태 조회 */
const watchStatusCommand: Command = {
  name: "watchstatus",
  description: "Show current Player Watch status",
  usage: "!watchstatus",
  execute: async (message: Message) => {
    const status = playerWatchService.getStatus();
    const embed = new EmbedBuilder()
      .setTitle(`🫧 Player Watch — ${status.active ? "ACTIVE" : "INACTIVE"}`)
      .setColor(status.active ? 0x3498db : 0x808080)
      .setTimestamp();

    if (status.active) {
      const s = status.stats;
      embed.addFields(
        {
          name: "Power Range (M)",
          value: `${status.minPower} ~ ${status.maxPower}`,
          inline: false,
        },
        {
          name: "Targets",
          value:
            status.targetNames.length > 0
              ? status.targetNames.map((n) => `• ${n}`).join("\n")
              : "(none)",
          inline: false,
        },
        {
          name: "Channel",
          value: status.channelId
            ? `<#${status.channelId}>`
            : "(unknown)",
          inline: true,
        },
        {
          name: "Started",
          value: status.startedAt
            ? `<t:${Math.floor(status.startedAt.getTime() / 1000)}:R>`
            : "(unknown)",
          inline: true,
        },
        {
          name: "WebSocket Stats",
          value:
            `Frames received: **${s.wsFramesReceived}**\n` +
            `Socket.IO events: **${s.socketIoEvents}**\n` +
            `Events with players: **${s.eventsWithPlayers}**\n` +
            `Players extracted: **${s.playersExtracted}**\n` +
            `Matched targets: **${s.matched}**\n` +
            `Notifications sent: **${s.notificationsSent}**`,
          inline: false,
        },
      );
    } else {
      embed.setDescription(
        "Player Watch is not active. Use `!watch <minPower> <maxPower> <name1> [name2] ...` to start.",
      );
    }

    await message.reply({ embeds: [embed] });
  },
};

/**
 * Watch 모드 재개: DB에 저장된 마지막 Watch 설정으로 다시 모니터링 시작.
 * 사용법: `!watchresume`
 */
const watchResumeCommand: Command = {
  name: "watchresume",
  description:
    "Resume Player Watch using the last saved configuration (targets, power range, channel)",
  usage: "!watchresume",
  execute: async (message: Message) => {
    try {
      if (playerWatchService.isActive()) {
        await message.reply(
          "ℹ️ Player Watch is already active. Use `!watchstop` first if you want to restart.",
        );
        return;
      }

      const saved = await playerWatchService.getSavedConfig();
      if (!saved) {
        await message.reply(
          "❌ No saved Watch configuration found. Use `!watch <minPower> <maxPower> <names...>` to start a new Player Watch first.",
        );
        return;
      }

      const channel = message.channel;
      if (!channel || !channel.isSendable()) {
        await message.reply(
          "❌ This command must be used in a sendable channel.",
        );
        return;
      }

      // 저장된 channel과 호출 channel이 다르면 사용자가 알도록 표시
      const savedChannelId = saved.channelId;
      const willOverride = savedChannelId !== channel.id;

      const startingEmbed = new EmbedBuilder()
        .setTitle("▶️ Resuming Player Watch...")
        .setDescription(
          willOverride
            ? `Using saved targets/power but **overriding channel** to <#${channel.id}> (saved was <#${savedChannelId}>).`
            : "Using saved targets, power range, and channel.",
        )
        .setColor(0xffa500)
        .addFields(
          {
            name: "Power Range (M)",
            value: `${saved.minPower} ~ ${saved.maxPower}`,
            inline: false,
          },
          {
            name: "Targets",
            value: saved.names.map((n) => `• ${n}`).join("\n"),
            inline: false,
          },
          {
            name: "Last saved",
            value: `<t:${Math.floor(saved.updatedAt.getTime() / 1000)}:R>`,
            inline: true,
          },
        )
        .setTimestamp();
      await message.reply({ embeds: [startingEmbed] });

      try {
        const result = await playerWatchService.resume({
          overrideChannelId: channel.id,
          channelSend: (payload: any) => (channel as any).send(payload),
        });
        if (!result.started) {
          await channel.send(`❌ Resume failed: ${result.reason ?? "unknown"}`);
          return;
        }
      } catch (err) {
        console.error("Watch resume failed:", err);
        const errEmbed = new EmbedBuilder()
          .setTitle("❌ Watch Resume Failed")
          .setDescription(
            `Error: ${err instanceof Error ? err.message : String(err)}`,
          )
          .setColor(0xff0000)
          .setTimestamp();
        await channel.send({ embeds: [errEmbed] });
        return;
      }

      const okEmbed = new EmbedBuilder()
        .setTitle("✅ Player Watch Resumed")
        .setDescription(
          "Real-time alerts will be posted in this channel whenever a target's bubble drops.\nUse `!watchstop` to end Player Watch.",
        )
        .setColor(0x00ff00)
        .addFields(
          {
            name: "Power Range (M)",
            value: `${saved.minPower} ~ ${saved.maxPower}`,
            inline: false,
          },
          {
            name: "Targets",
            value: saved.names.map((n) => `• ${n}`).join("\n"),
            inline: false,
          },
        )
        .setTimestamp();
      await channel.send({ embeds: [okEmbed] });
    } catch (error) {
      console.error("Failed to resume Player Watch:", error);
      await message.reply("❌ An error occurred while resuming Player Watch.");
    }
  },
};

/**
 * 저장된 Watch 설정 삭제. !watchresume이 더 이상 작동하지 않게 됨.
 */
const watchClearCommand: Command = {
  name: "watchclear",
  description:
    "Clear the saved Watch configuration (so !watchresume will no longer work until a new !watch)",
  usage: "!watchclear",
  execute: async (message: Message) => {
    try {
      const cleared = await playerWatchService.clearSavedConfig();
      if (cleared) {
        await message.reply(
          "✅ Saved Watch configuration cleared. Use `!watch <minPower> <maxPower> <names...>` to start a new one.",
        );
      } else {
        await message.reply("ℹ️ No saved Watch configuration to clear.");
      }
    } catch (error) {
      console.error("Failed to clear Watch config:", error);
      await message.reply("❌ An error occurred while clearing Watch config.");
    }
  },
};

// Commands array
export const commands: Command[] = [
  helpCommand,
  aboutCommand,
  barbarianCommand,
  aresCommand,
  witchCommand,
  goblinCommand,
  pyramidCommand,
  statusCommand,
  setPositionCommand,
  getPositionCommand,
  allPositionsCommand,
  logsCommand,
  barbarianPowerCommand,
  watchCommand,
  watchStopCommand,
  watchStatusCommand,
  watchResumeCommand,
  watchClearCommand,
];

// Command aliases mapping
export const commandAliases: { [key: string]: string } = {
  bb: "barbarian",
  barb: "barbarian",

  ar: "ares",

  wt: "witch",

  gb: "goblin",

  py: "pyramid",
  pyr: "pyramid",

  pos: "setpos",
  position: "setpos",

  getpos: "mypos",

  bbp: "bbpower",
};
