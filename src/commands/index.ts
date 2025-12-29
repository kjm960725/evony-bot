import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Message } from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';
import { cache } from '../services/cache';
import { AlertType, db } from '../services/db';
import { scheduler } from '../services/scheduler';
import { Coordinate } from '../types/coordinate';
import { sortPyramids } from '../utils/distance';
import { formatPower } from '../utils/format';

export interface Command {
  name: string;
  description: string;
  usage?: string;
  execute: (message: Message, args: string[]) => Promise<void>;
}

// 캐시에서 좌표 가져오기
async function fetchCoordinates(type: 'barbarian' | 'ares' | 'pyramid'): Promise<Coordinate[]> {
  return cache.get(type);
}

// Help command
const helpCommand: Command = {
  name: 'help',
  description: 'Display all available commands',
  usage: '!help',
  execute: async (message: Message) => {
    const status = scheduler.getCurrentStatus();
    const minutes = Math.floor(status.timeUntilNext / 60);
    const seconds = status.timeUntilNext % 60;

    const embed = new EmbedBuilder()
      .setTitle('⚔️ Evony Bot Commands')
      .setDescription('Provides coordinate information for Evony game')
      .setColor(0x0099ff)
      .addFields(
        {
          name: '📍 Position Commands',
          value: '`!setpos <X> <Y>` - Save your coordinates\n`!mypos` - View your saved position\n`!positions` - View all users positions',
          inline: false
        },
        {
          name: '🗺️ Coordinate Commands',
          value: '`!barbarian` (or `!bb`) - Barbarian coordinates\n`!ares` (or `!ar`) - Ares coordinates\n`!pyramid [level]` (or `!py [level]`) - Pyramid coordinates (e.g., `!py 5`)',
          inline: false
        },
        {
          name: '🔔 Alert Commands',
          value: '`!alert <type> [level]` - Set DM alert (e.g., `!alert pyramid 5`)\n`!alerts` - View your alerts\n`!alert off [type]` - Remove alert(s)',
          inline: false
        },
        {
          name: '⚙️ System Commands',
          value: '`!about` - How this bot works\n`!status` - Show cache status and schedule\n`!logs [lines]` - View recent server logs\n`!help` - Display this help message',
          inline: false
        },
      )
      .addFields({
        name: '🔄 Auto-Crawl Schedule',
        value: `${status.sequence}\nRotating every 5 minutes\nNext: **${status.next}** in ${minutes}m ${seconds}s`,
        inline: false
      })
      .setFooter({ text: 'Commands start with ! | Each type updates every 15 minutes' })
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  },
};

// Barbarian coordinates command
const barbarianCommand: Command = {
  name: 'barbarian',
  description: 'Display Barbarian coordinates',
  usage: '!barbarian',
  execute: async (message: Message, args: string[]) => {
    if (message.channel.isSendable()) {
      await message.channel.sendTyping();
    }

    try {
      const coordinates = await fetchCoordinates('barbarian');

      if (coordinates.length === 0) {
        await message.reply('⚠️ No Barbarian coordinates available at the moment.');
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('🗡️ Barbarian Coordinates')
        .setDescription(`Found ${coordinates.length} Barbarian${coordinates.length > 1 ? 's' : ''}`)
        .setColor(0xff4444)
        .setTimestamp();

      // Add fields (Discord embed 최대 25개 필드 제한)
      const maxDisplay = Math.min(coordinates.length, 25);
      coordinates.slice(0, maxDisplay).forEach((coord, index) => {
        let value = `X: \`${coord.x}\` Y: \`${coord.y}\``;
        if (coord.power !== undefined) {
          value += `\n⚔️ ${formatPower(coord.power)}`;
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

      if (coordinates.length > maxDisplay) {
        embed.setFooter({ text: `Showing ${maxDisplay}/${coordinates.length}` });
      }

      await message.reply({
        embeds: [embed]
      });

    } catch (error) {
      console.error('Failed to fetch Barbarian coordinates:', error);
      await message.reply('❌ An error occurred while fetching coordinate information.');
    }
  },
};

// Ares coordinates command
const aresCommand: Command = {
  name: 'ares',
  description: 'Display Ares coordinates',
  usage: '!ares',
  execute: async (message: Message, args: string[]) => {
    if (message.channel.isSendable()) {
      await message.channel.sendTyping();
    }

    try {
      const coordinates = await fetchCoordinates('ares');

      if (coordinates.length === 0) {
        await message.reply('⚠️ No Ares coordinates available at the moment.');
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('⚡ Ares Coordinates')
        .setDescription(`Found ${coordinates.length} Ares`)
        .setColor(0xffa500)
        .setTimestamp();

      // Add fields (Discord embed 최대 25개 필드 제한)
      const maxDisplay = Math.min(coordinates.length, 25);
      coordinates.slice(0, maxDisplay).forEach((coord, index) => {
        embed.addFields({
          name: `#${index + 1} - Lv${coord.level}`,
          value: `X: \`${coord.x}\` Y: \`${coord.y}\``,
          inline: true,
        });
      });

      if (coordinates.length > maxDisplay) {
        embed.setFooter({ text: `Showing ${maxDisplay}/${coordinates.length}` });
      }

      await message.reply({
        embeds: [embed]
      });

    } catch (error) {
      console.error('Failed to fetch Ares coordinates:', error);
      await message.reply('❌ An error occurred while fetching coordinate information.');
    }
  },
};

// Pyramid coordinates command
const pyramidCommand: Command = {
  name: 'pyramid',
  description: 'Display Pyramid coordinates (sorted by level and distance from your position)',
  usage: '!pyramid [level]',
  execute: async (message: Message, args: string[]) => {
    if (message.channel.isSendable()) {
      await message.channel.sendTyping();
    }

    try {
      let coordinates = await fetchCoordinates('pyramid');

      if (coordinates.length === 0) {
        await message.reply('⚠️ No Pyramid coordinates available at the moment.');
        return;
      }

      // 레벨 필터 (args[0]이 숫자면 해당 레벨만 필터링)
      let levelFilter: number | null = null;
      if (args.length > 0) {
        const level = parseInt(args[0]);
        if (!isNaN(level) && level >= 1 && level <= 10) {
          levelFilter = level;
          coordinates = coordinates.filter(c => c.level === level);

          if (coordinates.length === 0) {
            await message.reply(`⚠️ No Level ${level} Pyramid coordinates available at the moment.`);
            return;
          }
        } else if (!isNaN(level)) {
          await message.reply('❌ Level must be between 1 and 10.\nExample: `!pyramid 5`');
          return;
        }
      }

      // 사용자 좌표 가져오기
      const userPosition = await db.getUserPosition(message.author.id);

      let sortedCoords: (Coordinate & { distance?: number })[];
      let description = levelFilter
        ? `Found ${coordinates.length} Level ${levelFilter} Pyramid${coordinates.length > 1 ? 's' : ''}`
        : `Found ${coordinates.length} Pyramid${coordinates.length > 1 ? 's' : ''}`;

      if (userPosition) {
        // 사용자 좌표가 있으면 정렬 (레벨 역순 → 거리순)
        sortedCoords = sortPyramids(coordinates, userPosition.x, userPosition.y);
        description += `\n📍 Sorted by distance from your position (${userPosition.x}, ${userPosition.y})`;
      } else {
        // 사용자 좌표가 없으면 레벨순으로만 정렬
        sortedCoords = coordinates.sort((a, b) => b.level - a.level);
        description += `\n💡 Use \`!setpos X Y\` to set your position for distance-based sorting`;
      }

      const titleSuffix = levelFilter ? ` - Level ${levelFilter}` : '';
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
        embed.setFooter({ text: `Showing ${maxDisplay}/${sortedCoords.length}` });
      }

      await message.reply({
        embeds: [embed]
      });

    } catch (error) {
      console.error('Failed to fetch Pyramid coordinates:', error);
      await message.reply('❌ An error occurred while fetching coordinate information.');
    }
  },
};

// All Positions command - 모든 사용자 포지션 보기
const allPositionsCommand: Command = {
  name: 'positions',
  description: 'View all users positions',
  usage: '!positions',
  execute: async (message: Message, args: string[]) => {
    try {
      const allUsers = await db.getAllUsers();

      if (allUsers.length === 0) {
        await message.reply('ℹ️ No user positions saved yet.');
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('📍 All User Positions')
        .setDescription(`${allUsers.length} user(s) have saved their positions`)
        .setColor(0x0099ff)
        .setTimestamp();

      // 최대 25개 필드 제한
      const maxDisplay = Math.min(allUsers.length, 25);
      allUsers.slice(0, maxDisplay).forEach((user: { username: string; x: number; y: number }, index: number) => {
        embed.addFields({
          name: `${index + 1}. ${user.username}`,
          value: `X: \`${user.x}\` Y: \`${user.y}\``,
          inline: true,
        });
      });

      if (allUsers.length > maxDisplay) {
        embed.setFooter({ text: `Showing ${maxDisplay}/${allUsers.length} users` });
      }

      await message.reply({ embeds: [embed] });

    } catch (error) {
      console.error('Failed to get all positions:', error);
      await message.reply('❌ An error occurred while retrieving positions.');
    }
  },
};

// About command - 봇 작동 원리 설명
const aboutCommand: Command = {
  name: 'about',
  description: 'Explain how this bot works',
  usage: '!about',
  execute: async (message: Message) => {
    const embed = new EmbedBuilder()
      .setTitle('🤖 About Evony Bot')
      .setDescription('Your automated assistant for finding Barbarian, Ares, and Pyramid coordinates in Evony!')
      .setColor(0x5865F2)
      .addFields(
        {
          name: '🌐 Where do coordinates come from?',
          value: 'The bot automatically visits **iScout.club** website and collects the latest coordinates for you.',
          inline: false
        },
        {
          name: '🔄 How often does it update?',
          value: '• **When bot starts**: Fetches all coordinate types at once\n' +
            '• **Every 5 minutes**: Updates one type in rotation\n' +
            '• **Result**: Fresh data every 15 minutes for each type',
          inline: false
        },
        {
          name: '📍 Smart Distance Sorting',
          value: 'Tell the bot your city location with `!setpos X Y` and Pyramid results will show closest ones first!\n' +
            '**Sorting**: Higher levels first, then sorted by distance to your city',
          inline: false
        },
        {
          name: '🔔 Personal Alerts',
          value: 'Set up alerts like `!alert pyramid 5` and get a private message when new high-level targets appear!\n' +
            '• Only alerts you about genuinely new targets (not duplicates)\n' +
            '• Cleans up old alert history automatically',
          inline: false
        },
        {
          name: '💾 Your Data',
          value: '• Your saved city coordinates are remembered permanently\n' +
            '• Latest game coordinates are kept in memory\n' +
            '• Your alert preferences are saved',
          inline: false
        },
        {
          name: '🛡️ Always Running',
          value: '• Handles website security checks automatically\n' +
            '• Reconnects if connection is lost\n' +
            '• Restarts automatically if something goes wrong',
          inline: false
        }
      )
      .setFooter({ text: 'Made with ❤️ for Evony players' })
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  },
};

// Status command - 캐시 상태 확인
const statusCommand: Command = {
  name: 'status',
  description: 'Show cache status and next update time',
  usage: '!status',
  execute: async (message: Message) => {
    const metadata = cache.getMetadata();
    const barbarianCount = cache.get('barbarian').length;
    const aresCount = cache.get('ares').length;
    const pyramidCount = cache.get('pyramid').length;
    const status = scheduler.getCurrentStatus();
    const minutes = Math.floor(status.timeUntilNext / 60);
    const seconds = status.timeUntilNext % 60;

    const embed = new EmbedBuilder()
      .setTitle('📊 Cache Status')
      .setColor(metadata.isUpdating ? 0xffa500 : 0x00ff00)
      .setDescription(`**Crawl Sequence:** ${status.sequence}\n**Rotating every 5 minutes**`)
      .addFields(
        {
          name: '🗡️ Barbarian',
          value: `${barbarianCount} coordinates`,
          inline: true
        },
        {
          name: '⚡ Ares',
          value: `${aresCount} coordinates`,
          inline: true
        },
        {
          name: '🔺 Pyramid',
          value: `${pyramidCount} coordinates`,
          inline: true
        },
        {
          name: '📍 Last Crawled',
          value: status.current,
          inline: true
        },
        {
          name: '🎯 Next Target',
          value: status.next,
          inline: true
        },
        {
          name: '⏰ Next Crawl',
          value: `in ${minutes}m ${seconds}s`,
          inline: true
        },
        {
          name: '🔄 Status',
          value: metadata.isUpdating ? '⏳ Crawling...' : '✅ Ready',
          inline: false
        }
      )
      .setFooter({ text: 'Use !refresh to crawl all types immediately' })
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  },
};

// Set Position command - 사용자 좌표 저장
const setPositionCommand: Command = {
  name: 'setpos',
  description: 'Set your coordinates for distance-based sorting',
  usage: '!setpos <X> <Y>',
  execute: async (message: Message, args: string[]) => {
    try {
      // 인수 검증
      if (args.length !== 2) {
        await message.reply('❌ Usage: `!setpos <X> <Y>`\nExample: `!setpos 500 600`');
        return;
      }

      const x = parseInt(args[0]);
      const y = parseInt(args[1]);

      // 숫자 검증
      if (isNaN(x) || isNaN(y)) {
        await message.reply('❌ X and Y coordinates must be numbers.\nExample: `!setpos 500 600`');
        return;
      }

      // 좌표 범위 검증 (Evony 맵은 0-9999)
      if (x < 0 || x > 9999 || y < 0 || y > 9999) {
        await message.reply('❌ Coordinates must be between 0 and 9999.');
        return;
      }

      // 데이터베이스에 저장
      await db.setUserPosition(
        message.author.id,
        message.author.username,
        x,
        y
      );

      const embed = new EmbedBuilder()
        .setTitle('✅ Position Saved')
        .setDescription(`Your coordinates have been saved successfully!`)
        .setColor(0x00ff00)
        .addFields(
          { name: 'Username', value: message.author.username, inline: true },
          { name: 'X Coordinate', value: x.toString(), inline: true },
          { name: 'Y Coordinate', value: y.toString(), inline: true }
        )
        .setFooter({ text: 'Pyramid coordinates will now be sorted by distance from your position' })
        .setTimestamp();

      await message.reply({ embeds: [embed] });

    } catch (error) {
      console.error('Failed to set user position:', error);
      await message.reply('❌ An error occurred while saving your position.');
    }
  },
};

// Get Position command - 사용자 좌표 조회
const getPositionCommand: Command = {
  name: 'mypos',
  description: 'View your saved coordinates',
  usage: '!mypos',
  execute: async (message: Message, args: string[]) => {
    try {
      const userPosition = await db.getUserPosition(message.author.id);

      if (!userPosition) {
        await message.reply('❌ You haven\'t set your position yet.\nUse `!setpos <X> <Y>` to set your coordinates.');
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('📍 Your Position')
        .setColor(0x0099ff)
        .addFields(
          { name: 'Username', value: userPosition.username, inline: true },
          { name: 'X Coordinate', value: userPosition.x.toString(), inline: true },
          { name: 'Y Coordinate', value: userPosition.y.toString(), inline: true }
        )
        .setFooter({ text: `Last updated: ${userPosition.updatedAt.toLocaleString()}` })
        .setTimestamp();

      await message.reply({ embeds: [embed] });

    } catch (error) {
      console.error('Failed to get user position:', error);
      await message.reply('❌ An error occurred while retrieving your position.');
    }
  },
};

// Alert command - 알림 설정
const alertCommand: Command = {
  name: 'alert',
  description: 'Set up alerts for new coordinates',
  usage: '!alert <type> [level] | !alert off [type]',
  execute: async (message: Message, args: string[]) => {
    try {
      // 인수 확인
      if (args.length === 0) {
        const embed = new EmbedBuilder()
          .setTitle('🔔 Alert Command Usage')
          .setColor(0x0099ff)
          .setDescription('Set up DM alerts when new coordinates are found!')
          .addFields(
            {
              name: '📝 Set Alert',
              value: '`!alert pyramid [level]` - Pyramid alert (e.g., `!alert pyramid 5`)\n' +
                '`!alert barbarian [level]` - Barbarian alert\n' +
                '`!alert ares [level]` - Ares alert',
              inline: false,
            },
            {
              name: '🔕 Remove Alert',
              value: '`!alert off pyramid` - Remove pyramid alert\n' +
                '`!alert off` - Remove all alerts',
              inline: false,
            },
            {
              name: '📋 View Alerts',
              value: '`!alerts` - View your current alert settings',
              inline: false,
            }
          )
          .setFooter({ text: 'Tip: Set your position with !setpos for distance-based filtering' });

        await message.reply({ embeds: [embed] });
        return;
      }

      // !alert off 처리
      if (args[0].toLowerCase() === 'off') {
        if (args.length === 1) {
          // 모든 알림 삭제
          const deletedCount = await db.deleteAllAlerts(message.author.id);
          if (deletedCount > 0) {
            await message.reply(`🔕 Removed ${deletedCount} alert(s).`);
          } else {
            await message.reply('ℹ️ You have no active alerts.');
          }
        } else {
          // 특정 타입 알림 삭제
          const type = args[1].toLowerCase() as AlertType;
          if (!['pyramid', 'barbarian', 'ares'].includes(type)) {
            await message.reply('❌ Invalid type. Use: `pyramid`, `barbarian`, or `ares`');
            return;
          }

          const deleted = await db.deleteAlert(message.author.id, type);
          if (deleted) {
            await message.reply(`🔕 Removed ${type} alert.`);
          } else {
            await message.reply(`ℹ️ You don't have a ${type} alert.`);
          }
        }
        return;
      }

      // 타입 확인
      const type = args[0].toLowerCase() as AlertType;
      if (!['pyramid', 'barbarian', 'ares'].includes(type)) {
        await message.reply('❌ Invalid type. Use: `pyramid`, `barbarian`, or `ares`\nExample: `!alert pyramid 5`');
        return;
      }

      // 레벨 파싱 (옵션)
      let minLevel: number | undefined;
      if (args.length >= 2) {
        minLevel = parseInt(args[1]);
        if (isNaN(minLevel) || minLevel < 1 || minLevel > 10) {
          await message.reply('❌ Level must be a number between 1 and 10.\nExample: `!alert pyramid 5`');
          return;
        }
      }

      // 알림 설정 저장
      await db.setAlert(
        message.author.id,
        message.author.username,
        type,
        minLevel
      );

      const typeEmoji = type === 'pyramid' ? '🔺' : type === 'barbarian' ? '🗡️' : '⚡';
      const levelText = minLevel ? `Level ${minLevel}+` : 'All levels';

      const embed = new EmbedBuilder()
        .setTitle('🔔 Alert Set!')
        .setColor(0x00ff00)
        .setDescription(`You will receive a DM when new ${type} coordinates are found.`)
        .addFields(
          { name: 'Type', value: `${typeEmoji} ${type.charAt(0).toUpperCase() + type.slice(1)}`, inline: true },
          { name: 'Level Filter', value: levelText, inline: true }
        )
        .setFooter({ text: 'Use !alerts to view all your alerts' })
        .setTimestamp();

      await message.reply({ embeds: [embed] });

    } catch (error) {
      console.error('Failed to set alert:', error);
      await message.reply('❌ An error occurred while setting the alert.');
    }
  },
};

// Logs command - 최근 서버 로그 보기 (페이징 지원)
const logsCommand: Command = {
  name: 'logs',
  description: 'View recent server logs with pagination',
  usage: '!logs [filter]  (filter: all, error, warn, info)',
  execute: async (message: Message, args: string[]) => {
    try {
      const logFile = path.join(process.cwd(), 'logs', 'out.log');

      // 로그 파일이 존재하지 않으면
      if (!fs.existsSync(logFile)) {
        await message.reply('ℹ️ No log file found. Logs will be available after first crawl.');
        return;
      }

      // 필터 파라미터 (all, error, warn, info)
      const filter = args[0]?.toLowerCase() || 'all';

      // 로그 파일 읽기
      const logContent = fs.readFileSync(logFile, 'utf-8');
      let allLines = logContent.trim().split('\n').filter(line => line.length > 0);

      if (allLines.length === 0) {
        await message.reply('ℹ️ No logs available yet.');
        return;
      }

      // 민감한 정보 필터링 (비밀번호, 토큰 등)
      allLines = allLines.map(line =>
        line
          .replace(/PASSWORD[^\s]*/gi, 'PASSWORD***')
          .replace(/TOKEN[^\s]*/gi, 'TOKEN***')
          .replace(/email[^\s]*@[^\s]*/gi, 'email***@***')
      );

      // 로그 레벨별 필터링
      let filteredLines = allLines;
      if (filter === 'error') {
        filteredLines = allLines.filter(line => line.includes('❌') || line.includes('ERROR') || line.includes('Failed'));
      } else if (filter === 'warn') {
        filteredLines = allLines.filter(line => line.includes('⚠️') || line.includes('WARN'));
      } else if (filter === 'info') {
        filteredLines = allLines.filter(line => line.includes('✅') || line.includes('🔔') || line.includes('📡'));
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
      await sendLogPage(message, filteredLines, currentPage, totalPages, linesPerPage, filter);

    } catch (error) {
      console.error('Failed to read logs:', error);
      await message.reply('❌ An error occurred while reading logs.');
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
  filter = 'all'
) {
  // 현재 페이지의 로그 라인 추출
  const startIdx = (page - 1) * linesPerPage;
  const endIdx = Math.min(startIdx + linesPerPage, allLines.length);
  const pageLines = allLines.slice(startIdx, endIdx);

  // 로그 가독성 개선: 타임스탬프 단축 + 포맷팅
  const formattedLines = pageLines.map(line => {
    // 타임스탬프 포맷 변경: "2025-12-24 07:24:00 +00:00:" → "07:24:00"
    let formatted = line.replace(/^\d{4}-\d{2}-\d{2}\s+(\d{2}:\d{2}:\d{2})\s+[+\-]\d{2}:\d{2}:\s*/, '$1 │ ');

    // 로그 라인 길이 제한 (너무 긴 라인 잘라내기)
    const maxLineLength = 80;
    if (formatted.length > maxLineLength) {
      formatted = formatted.substring(0, maxLineLength - 3) + '...';
    }

    return formatted;
  });

  // Discord Embed 필드 값 길이 제한 (1024자)
  let logText = formattedLines.join('\n');

  // ANSI 색상 코드 블록 사용 (더 나은 가독성)
  let finalValue = `\`\`\`ansi\n${logText}\n\`\`\``;

  // 1024자 초과 시 점진적으로 줄임
  while (finalValue.length > 1024) {
    const cutLength = Math.min(logText.length - 100, finalValue.length - 1024 + 50);
    logText = '...\n' + logText.slice(cutLength > 0 ? cutLength : 100);
    finalValue = `\`\`\`ansi\n${logText}\n\`\`\``;
  }

  // 필터 이모지
  const filterEmoji = filter === 'error' ? '❌' : filter === 'warn' ? '⚠️' : filter === 'info' ? 'ℹ️' : '📋';
  const filterText = filter === 'all' ? 'All Logs' : `${filterEmoji} ${filter.charAt(0).toUpperCase() + filter.slice(1)} Only`;

  const embed = new EmbedBuilder()
    .setTitle(`📋 Server Logs`)
    .setDescription(`${filterText} | Page ${page}/${totalPages} | Lines ${startIdx + 1}-${endIdx} of ${allLines.length}`)
    .setColor(filter === 'error' ? 0xff0000 : filter === 'warn' ? 0xffa500 : 0x808080)
    .addFields({
      name: 'Logs',
      value: finalValue,
      inline: false
    })
    .setFooter({ text: `Use buttons to navigate | Auto-expires in 15 minutes` })
    .setTimestamp();

  // 페이징 + 필터 버튼 (2줄)
  const row1 = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`logs_first_${filter}`)
        .setLabel('⏮️ First')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 1),
      new ButtonBuilder()
        .setCustomId(`logs_prev_${page}_${filter}`)
        .setLabel('⬅️ Prev')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page === 1),
      new ButtonBuilder()
        .setCustomId(`logs_page_${page}`)
        .setLabel(`📄 ${page}/${totalPages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`logs_next_${page}_${filter}`)
        .setLabel('Next ➡️')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page === totalPages),
      new ButtonBuilder()
        .setCustomId(`logs_last_${totalPages}_${filter}`)
        .setLabel('Last ⏭️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === totalPages),
    );

  const row2 = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`logs_filter_all_${page}`)
        .setLabel('📋 All')
        .setStyle(filter === 'all' ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`logs_filter_info_${page}`)
        .setLabel('ℹ️ Info')
        .setStyle(filter === 'info' ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`logs_filter_warn_${page}`)
        .setLabel('⚠️ Warn')
        .setStyle(filter === 'warn' ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`logs_filter_error_${page}`)
        .setLabel('❌ Error')
        .setStyle(filter === 'error' ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`logs_refresh_${page}_${filter}`)
        .setLabel('🔄 Refresh')
        .setStyle(ButtonStyle.Primary),
    );

  await message.reply({
    embeds: [embed],
    components: [row1, row2],
  });
}

// Alerts command - 알림 목록 보기
const alertsCommand: Command = {
  name: 'alerts',
  description: 'View your current alert settings',
  usage: '!alerts',
  execute: async (message: Message, args: string[]) => {
    try {
      const alerts = await db.getAllAlerts(message.author.id);

      if (alerts.length === 0) {
        await message.reply('ℹ️ You have no active alerts.\nUse `!alert <type> [level]` to set up alerts.');
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('🔔 Your Alert Settings')
        .setColor(0x0099ff)
        .setTimestamp();

      for (const alert of alerts) {
        const typeEmoji = alert.type === 'pyramid' ? '🔺' : alert.type === 'barbarian' ? '🗡️' : '⚡';
        const typeName = alert.type.charAt(0).toUpperCase() + alert.type.slice(1);
        const levelText = alert.minLevel ? `Level ${alert.minLevel}+` : 'All levels';
        const distanceText = alert.maxDistance ? `≤ ${alert.maxDistance}` : 'No limit';
        const statusText = alert.enabled ? '✅ Active' : '⏸️ Paused';

        embed.addFields({
          name: `${typeEmoji} ${typeName}`,
          value: `Level: ${levelText}\nDistance: ${distanceText}\nStatus: ${statusText}`,
          inline: true,
        });
      }

      embed.setFooter({ text: 'Use !alert off <type> to remove an alert' });

      await message.reply({ embeds: [embed] });

    } catch (error) {
      console.error('Failed to get alerts:', error);
      await message.reply('❌ An error occurred while retrieving your alerts.');
    }
  },
};

// Commands array
export const commands: Command[] = [
  helpCommand,
  aboutCommand,
  barbarianCommand,
  aresCommand,
  pyramidCommand,
  statusCommand,
  setPositionCommand,
  getPositionCommand,
  allPositionsCommand,
  alertCommand,
  alertsCommand,
  logsCommand,
];

// Command aliases mapping
export const commandAliases: { [key: string]: string } = {
  'bb': 'barbarian',
  'barb': 'barbarian',

  'ar': 'ares',

  'py': 'pyramid',
  'pyr': 'pyramid',

  'pos': 'setpos',
  'position': 'setpos',

  'getpos': 'mypos',
};
