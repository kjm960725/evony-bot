import { Client, GatewayIntentBits, Events, ActivityType, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { commands, commandAliases } from './commands';
import { scheduler } from './services/scheduler';
import { scraper } from './services/scraper';
import { notification } from './services/notification';

// 환경 변수 로드 (프로젝트 루트의 .env 파일 명시)
const envPath = path.join(__dirname, '../.env');
console.log(`📋 Loading .env from: ${envPath}`);
dotenv.config({ path: envPath });
console.log(`✅ DISCORD_TOKEN loaded: ${process.env.DISCORD_TOKEN ? 'Yes' : 'No'}`);
console.log(`✅ ISCOUT_EMAIL loaded: ${process.env.ISCOUT_EMAIL ? 'Yes' : 'No'}`);
console.log(`✅ ISCOUT_PASSWORD loaded: ${process.env.ISCOUT_PASSWORD ? 'Yes' : 'No'}`);

// 디스코드 클라이언트 생성
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// 명령어 접두사
const PREFIX = '!';

// Bot ready event
client.once(Events.ClientReady, async (c: Client<true>) => {
  console.log(`✅ Bot is ready! Logged in as ${c.user.tag}`);
  console.log(`📊 Connected to ${c.guilds.cache.size} server(s)`);
  console.log(`📝 Loaded ${commands.length} command(s)`);

  // Set bot status
  c.user.setPresence({
    activities: [{ 
      name: `${PREFIX}help | Evony Coordinates`, 
      type: ActivityType.Playing 
    }],
    status: 'online',
  });

  // Initialize notification service with Discord client
  notification.setClient(c);

  // Start auto-update scheduler
  console.log('🚀 Starting services...');
  scheduler.start();
});

// Message receive event
client.on(Events.MessageCreate, async (message: any) => {
  // Ignore bot messages
  if (message.author.bot) return;
  
  // Ignore messages without prefix
  if (!message.content.startsWith(PREFIX)) return;

  // Parse command and arguments
  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  let commandName = args.shift()?.toLowerCase();

  if (!commandName) return;

  // Check for aliases
  if (commandAliases[commandName]) {
    commandName = commandAliases[commandName];
  }

  // Find command
  const command = commands.find(cmd => cmd.name === commandName);

  if (!command) {
    return; // Ignore unknown commands
  }

  try {
    console.log(`⚡ ${message.author.tag} executed ${PREFIX}${commandName} command`);
    await command.execute(message, args);
  } catch (error) {
    console.error(`❌ Error executing ${commandName} command:`, error);
    await message.reply({
      content: '⚠️ An error occurred while executing the command!',
      ephemeral: true,
    }).catch(() => {});
  }
});

// Guild join event
client.on(Events.GuildCreate, (guild: any) => {
  console.log(`✨ Joined new server: ${guild.name} (ID: ${guild.id})`);
  console.log(`   Members: ${guild.memberCount}`);
});

// Guild leave event
client.on(Events.GuildDelete, (guild: any) => {
  console.log(`👋 Removed from server: ${guild.name} (ID: ${guild.id})`);
});

// Button interaction event - 로그 페이징
client.on(Events.InteractionCreate, async (interaction: any) => {
  if (!interaction.isButton()) return;

  const customId = interaction.customId;

  // logs 페이징 버튼 처리
  if (customId.startsWith('logs_')) {
    try {
      await interaction.deferUpdate(); // 로딩 표시

      const logFile = path.join(process.cwd(), 'logs', 'out.log');

      // 로그 파일 읽기
      const logContent = fs.readFileSync(logFile, 'utf-8');
      let allLines = logContent.trim().split('\n').filter((line: string) => line.length > 0);

      // 민감한 정보 필터링
      allLines = allLines.map((line: string) =>
        line
          .replace(/PASSWORD[^\s]*/gi, 'PASSWORD***')
          .replace(/TOKEN[^\s]*/gi, 'TOKEN***')
          .replace(/email[^\s]*@[^\s]*/gi, 'email***@***')
      );

      // customId 파싱
      const parts = customId.split('_');
      const action = parts[1];
      let currentFilter = 'all';
      let targetPage = 1;

      // 필터 버튼 클릭
      if (action === 'filter') {
        currentFilter = parts[2];
        targetPage = parseInt(parts[3]) || 1;
      } 
      // 리프레시 버튼
      else if (action === 'refresh') {
        targetPage = parseInt(parts[2]);
        currentFilter = parts[3] || 'all';
      }
      // 페이징 버튼
      else {
        currentFilter = parts[parts.length - 1] || 'all';
        
        if (action === 'first') {
          targetPage = 1;
        } else if (action === 'last') {
          targetPage = parseInt(parts[2]);
        } else if (action === 'prev') {
          const currentPage = parseInt(parts[2]);
          targetPage = Math.max(1, currentPage - 1);
        } else if (action === 'next') {
          const currentPage = parseInt(parts[2]);
          targetPage = currentPage + 1;
        }
      }

      // 로그 레벨별 필터링
      let filteredLines = allLines;
      if (currentFilter === 'error') {
        filteredLines = allLines.filter((line: string) => 
          line.includes('❌') || line.includes('ERROR') || line.includes('Failed')
        );
      } else if (currentFilter === 'warn') {
        filteredLines = allLines.filter((line: string) => 
          line.includes('⚠️') || line.includes('WARN')
        );
      } else if (currentFilter === 'info') {
        filteredLines = allLines.filter((line: string) => 
          line.includes('✅') || line.includes('🔔') || line.includes('📡')
        );
      }

      const linesPerPage = 12;
      const totalPages = Math.ceil(filteredLines.length / linesPerPage);
      
      // 페이지 범위 조정
      targetPage = Math.max(1, Math.min(targetPage, totalPages));

      // 페이지 로그 추출
      const startIdx = (targetPage - 1) * linesPerPage;
      const endIdx = Math.min(startIdx + linesPerPage, filteredLines.length);
      const pageLines = filteredLines.slice(startIdx, endIdx);

      // 로그 가독성 개선
      const formattedLines = pageLines.map((line: string) => {
        // 타임스탬프 단축
        let formatted = line.replace(/^\d{4}-\d{2}-\d{2}\s+(\d{2}:\d{2}:\d{2})\s+[+\-]\d{2}:\d{2}:\s*/, '$1 │ ');
        
        // 로그 라인 길이 제한
        const maxLineLength = 80;
        if (formatted.length > maxLineLength) {
          formatted = formatted.substring(0, maxLineLength - 3) + '...';
        }
        
        return formatted;
      });

      let logText = formattedLines.join('\n');
      let finalValue = `\`\`\`ansi\n${logText}\n\`\`\``;

      // 1024자 초과 시 점진적으로 줄임
      while (finalValue.length > 1024) {
        const cutLength = Math.min(logText.length - 100, finalValue.length - 1024 + 50);
        logText = '...\n' + logText.slice(cutLength > 0 ? cutLength : 100);
        finalValue = `\`\`\`ansi\n${logText}\n\`\`\``;
      }

      // 필터 표시
      const filterEmoji = currentFilter === 'error' ? '❌' : currentFilter === 'warn' ? '⚠️' : currentFilter === 'info' ? 'ℹ️' : '📋';
      const filterText = currentFilter === 'all' ? 'All Logs' : `${filterEmoji} ${currentFilter.charAt(0).toUpperCase() + currentFilter.slice(1)} Only`;

      // 업데이트된 임베드
      const embed = new EmbedBuilder()
        .setTitle('📋 Server Logs')
        .setDescription(`${filterText} | Page ${targetPage}/${totalPages} | Lines ${startIdx + 1}-${endIdx} of ${filteredLines.length}`)
        .setColor(currentFilter === 'error' ? 0xff0000 : currentFilter === 'warn' ? 0xffa500 : 0x808080)
        .addFields({
          name: 'Logs',
          value: finalValue,
          inline: false
        })
        .setFooter({ text: `Use buttons to navigate | Auto-expires in 15 minutes` })
        .setTimestamp();

      // 페이징 버튼
      const row1 = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`logs_first_${currentFilter}`)
            .setLabel('⏮️ First')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(targetPage === 1),
          new ButtonBuilder()
            .setCustomId(`logs_prev_${targetPage}_${currentFilter}`)
            .setLabel('⬅️ Prev')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(targetPage === 1),
          new ButtonBuilder()
            .setCustomId(`logs_page_${targetPage}`)
            .setLabel(`📄 ${targetPage}/${totalPages}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
          new ButtonBuilder()
            .setCustomId(`logs_next_${targetPage}_${currentFilter}`)
            .setLabel('Next ➡️')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(targetPage === totalPages),
          new ButtonBuilder()
            .setCustomId(`logs_last_${totalPages}_${currentFilter}`)
            .setLabel('Last ⏭️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(targetPage === totalPages),
        );

      // 필터 버튼
      const row2 = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`logs_filter_all_${targetPage}`)
            .setLabel('📋 All')
            .setStyle(currentFilter === 'all' ? ButtonStyle.Success : ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(`logs_filter_info_${targetPage}`)
            .setLabel('ℹ️ Info')
            .setStyle(currentFilter === 'info' ? ButtonStyle.Success : ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(`logs_filter_warn_${targetPage}`)
            .setLabel('⚠️ Warn')
            .setStyle(currentFilter === 'warn' ? ButtonStyle.Success : ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(`logs_filter_error_${targetPage}`)
            .setLabel('❌ Error')
            .setStyle(currentFilter === 'error' ? ButtonStyle.Success : ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(`logs_refresh_${targetPage}_${currentFilter}`)
            .setLabel('🔄 Refresh')
            .setStyle(ButtonStyle.Primary),
        );

      // 메시지 업데이트
      await interaction.editReply({
        embeds: [embed],
        components: [row1, row2],
      });

      console.log(`🔘 ${interaction.user.tag} navigated to logs page ${targetPage}/${totalPages} (filter: ${currentFilter})`);

    } catch (error) {
      console.error('Failed to handle logs pagination:', error);
      try {
        await interaction.followUp({
          content: '❌ An error occurred while loading the page.',
          ephemeral: true,
        });
      } catch (e) {
        // Interaction already expired
      }
    }
  }
});

// Error handling
client.on(Events.Error, (error: Error) => {
  console.error('❌ Discord client error:', error);
});

// Warning handling
client.on(Events.Warn, (warning: string) => {
  console.warn('⚠️ Discord client warning:', warning);
});

// Process error handling
process.on('unhandledRejection', (error: any) => {
  console.error('❌ Unhandled Promise rejection:', error);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  scheduler.stop();
  await scraper.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  scheduler.stop();
  await scraper.close();
  process.exit(0);
});

// Bot login
const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('❌ DISCORD_TOKEN is not set in .env file!');
  console.error('   Please create .env file using env.example as reference.');
  process.exit(1);
}

client.login(token).catch((error: Error) => {
  console.error('❌ Bot login failed:', error);
  console.error('   Please check if your Discord token is valid.');
  process.exit(1);
});

