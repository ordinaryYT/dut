const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes
} = require('discord.js');

const express = require('express');
const cookieParser = require('cookie-parser');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { Pool } = require('pg');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser('hardcoded-secret-change-this-to-something-secure-69420abcxyz'));
app.use(express.static(__dirname));

// In-memory recent messages for burst swearing detection
const recentMessages = new Map(); // userId → [{content, timestamp}]
const MAX_HISTORY = 12;
const TIME_WINDOW_MS = 20000; // 20 seconds

/* ================= DATABASE ================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS warnings (
        user_id TEXT PRIMARY KEY,
        count INT DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS mod_apps (
        id SERIAL PRIMARY KEY,
        username TEXT,
        user_id TEXT,
        app_type TEXT DEFAULT 'discord',
        email TEXT,
        age TEXT,
        timezone TEXT,
        tiktok_username TEXT,
        tiktok_url TEXT,
        experience TEXT,
        reason TEXT,
        status TEXT DEFAULT 'Pending',
        submitted_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS giveaways (
        message_id TEXT PRIMARY KEY,
        channel_id TEXT,
        end_time BIGINT,
        prize TEXT,
        winners INT DEFAULT 1,
        min_join INT DEFAULT 0
      );
    `);

    await pool.query(`
      ALTER TABLE mod_apps
      ADD COLUMN IF NOT EXISTS app_type TEXT DEFAULT 'discord',
      ADD COLUMN IF NOT EXISTS email TEXT,
      ADD COLUMN IF NOT EXISTS tiktok_username TEXT,
      ADD COLUMN IF NOT EXISTS tiktok_url TEXT,
      ADD COLUMN IF NOT EXISTS age TEXT,
      ADD COLUMN IF NOT EXISTS timezone TEXT,
      ADD COLUMN IF NOT EXISTS experience TEXT,
      ADD COLUMN IF NOT EXISTS reason TEXT,
      ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'Pending';

      ALTER TABLE giveaways
      ADD COLUMN IF NOT EXISTS winners INT DEFAULT 1,
      ADD COLUMN IF NOT EXISTS min_join INT DEFAULT 0;
    `);

    console.log('Database ready');
  } catch (err) {
    console.error('Database setup failed:', err);
  }
})();

/* ================= DISCORD CLIENT ================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions
  ]
});
client.ticketState = {};

/* ================= AI HELPER ================= */
async function ai(prompt) {
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet',
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error('AI error:', err);
    return null;
  }
}

/* ================= ROLE CHECK ================= */
function allowed(member) {
  return (
    member?.roles.cache.has(process.env.STAFF_ROLE_ID) ||
    member?.roles.cache.has(process.env.MOD_ROLE_ID) ||
    member?.roles.cache.has(process.env.ADMIN_ROLE_ID)
  );
}

/* ================= WARNING HELPER ================= */
async function issueWarning(member, channel, rule, count) {
  try {
    await channel.send(`<@${member.id}> Warning #${count}: ${rule}`);
    console.log(`Warning #${count} to ${member.user.tag}: ${rule}`);
  } catch (err) {
    console.error('Failed to send warning:', err);
  }
}

/* ================= MESSAGE SCANNING & AUTO-WARNING ================= */
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const userId = message.author.id;
  const content = message.content.toLowerCase();
  const now = Date.now();
  const channel = message.channel;

  // ===== INSTANT WARN: Pinging protected user =====
  if (content.includes('<@1365755491472379904>') || content.includes('1365755491472379904')) {
    const r = await pool.query(
      `INSERT INTO warnings(user_id, count) VALUES($1, 1) 
       ON CONFLICT (user_id) DO UPDATE SET count = warnings.count + 1 
       RETURNING count`,
      [userId]
    );
    const count = r.rows[0].count;
    await issueWarning(message.member, channel, 'Do not ping protected user ID 1365755491472379904', count);
    return;
  }

  // ===== Track recent messages for burst/swearing spam =====
  let history = recentMessages.get(userId) || [];
  history.push({ content: message.content, timestamp: now });

  history = history.filter(m => now - m.timestamp < TIME_WINDOW_MS);
  if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);

  recentMessages.set(userId, history);

  const hasSwear = /(fuck|shit|damn|cunt|bitch|asshole|nigg|retard|faggot|cock|pussy|porn|nsfw|sex|cum)/gi.test(message.content);
  if (!hasSwear && history.length < 3) return;

  const aiPrompt = `
You are a strict Discord moderator detecting spam swearing / excessive profanity.

Recent messages from this user (most recent at bottom):
${history.map(m => m.content).join('\n')}

Current message: "${message.content}"

Rules:
- Excessive swearing = many curse words in one message or short time (e.g. 4+ curses)
- Profanity spam = repeated cursing across multiple messages quickly
- NSFW / derogatory / threats = any adult, hate, or threatening content

Reply ONLY with:
VIOLATION: [None | Excessive Swearing | Profanity Spam | NSFW | Harassment | Threats | Other]
COUNT: [number of swear words / bad phrases detected]
REASON: [1 short sentence]

No other text.
`;

  const aiResponse = await ai(aiPrompt);
  if (!aiResponse) return;

  const violationMatch = aiResponse.match(/VIOLATION:\s*(.+)/i);
  const countMatch = aiResponse.match(/COUNT:\s*(\d+)/i);
  const reasonMatch = aiResponse.match(/REASON:\s*(.+)/i);

  const violation = violationMatch ? violationMatch[1].trim() : 'None';
  const swearCount = countMatch ? parseInt(countMatch[1], 10) : 0;
  const reason = reasonMatch ? reasonMatch[1].trim() : 'Rule violation';

  if (violation !== 'None' && (swearCount >= 4 || (violation.includes('Spam') && history.length >= 3))) {
    const r = await pool.query(
      `INSERT INTO warnings(user_id, count) VALUES($1, 1) 
       ON CONFLICT (user_id) DO UPDATE SET count = warnings.count + 1 
       RETURNING count`,
      [userId]
    );
    const count = r.rows[0].count;

    let ruleText = violation;
    if (violation === 'Excessive Swearing') ruleText = 'Excessive swearing in short time';
    if (violation === 'Profanity Spam') ruleText = 'Profanity spam / repeated cursing';

    await issueWarning(message.member, channel, `${ruleText} - ${reason}`, count);

    if (count === 2) await message.member.timeout(60 * 60 * 1000, '2 warnings').catch(() => {});
    if (count === 3) await message.member.timeout(24 * 60 * 60 * 1000, '3 warnings').catch(() => {});
    if (count >= 4) {
      await message.member.roles.add(process.env.WEEK_BAN_ROLE_ID).catch(() => {});
    }
  }
});

/* ================= RULES REACTION ================= */
const pendingVerifications = new Map();

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) try { await reaction.fetch(); } catch { return; }

  const data = pendingVerifications.get(reaction.message.id);
  if (!data || data.type !== 'rules') return;

  if (reaction.emoji.name === '✅') {
    try {
      const guild = reaction.message.guild;
      const member = await guild.members.fetch(user.id);

      await member.roles.add(process.env.VERIFIED_ROLE_ID).catch(err => {
        console.error('Failed to add role:', err);
      });

      fetch('https://thebigdutz.qzz.io/ping')
        .then(() => console.log('Pinged Render'))
        .catch(err => console.error('Ping failed:', err));

      await reaction.message.channel.send({
        content: `<@${user.id}> You have been verified!`,
        flags: 64
      });

      console.log(`Verified ${user.tag}`);
    } catch (err) {
      console.error('Verification error:', err);
    }
  }
});

/* ================= SEND RULES ================= */
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (message.content === '!sendrules') {
    if (!message.member.permissions.has('ADMINISTRATOR')) {
      return message.reply('❌ Admin only.');
    }

    const embed = new EmbedBuilder()
      .setTitle('📜 Server Rules')
      .setDescription(`**Rules**
Be respectful  
You must respect all users, regardless of your liking towards them. Treat others the way you want to be treated.

No Inappropriate Language  
The use of profanity should be kept to a minimum. However, any derogatory language towards any user is prohibited.

No spamming  
Don't send a lot of small messages right after each other. Do not disrupt chat by spamming.

No pornographic/adult/other NSFW material  
This is a community server and not meant to share this kind of material.

No advertisements  
We do not tolerate any kind of advertisements, whether it be for other communities or streams. You can post your content in the media channel if it is relevant and provides actual value (Video/Art)

No offensive names and profile pictures  
You will be asked to change your name or picture if the staff deems them inappropriate.

Server Raiding  
Raiding or mentions of raiding are not allowed.

Direct & Indirect Threats  
Threats to other users of DDoS, Death, DoX, abuse, and other malicious threats are absolutely prohibited and disallowed.

Follow the Discord Community Guidelines  
You can find them here: https://discordapp.com/guidelines

**Warning System**  
First Warning — No action will be taken.  
Second Warning — 1 Hour Mute  
Third Warning — 1 Day Mute  
Fourth Warning — 1 Week Ban  
Fifth Warning — Permanent Ban

**If you agree to these rules, react with ✅ below**`)
      .setColor(0x00ff00)
      .setFooter({ text: 'React to get Verified role' });

    const sent = await message.channel.send({ embeds: [embed] });
    await sent.react('✅');

    pendingVerifications.set(sent.id, { type: 'rules' });

    return message.reply('Rules posted!');
  }
});

/* ================= INTERACTIONS ================= */
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton() && !interaction.isChatInputCommand()) return;

  try {
    // Ticket buttons
    if (interaction.isButton() && ['create_ticket', 'continue', 'ping', 'close'].includes(interaction.customId)) {
      const channel = interaction.channel;
      const state = client.ticketState[channel?.id];
      if (state) {
        if (interaction.customId === 'continue') {
          await channel.setParent(process.env.TICKET_OPEN_CATEGORY_ID).catch(() => {});
          await channel.permissionOverwrites.edit(state.userId, { SendMessages: true }).catch(() => {});
          state.waitingForUser = true;
          await interaction.deferUpdate();
        }
        if (interaction.customId === 'ping') {
          await channel.send(`<@&${process.env.STAFF_ROLE_ID}> Need assistance!`).catch(() => {});
          await interaction.deferUpdate();
        }
        if (interaction.customId === 'close') {
          delete client.ticketState[channel.id];
          await channel.delete().catch(() => {});
        }
      }
      return;
    }

    // Approve/Deny buttons
    if (interaction.isButton() && (interaction.customId.startsWith('approve_') || interaction.customId.startsWith('deny_'))) {
      if (!allowed(interaction.member)) {
        return interaction.reply({ content: 'Only staff can use these buttons.', ephemeral: true });
      }

      const [action, appId] = interaction.customId.split('_');
      const { rows } = await pool.query(`SELECT * FROM mod_apps WHERE id = $1`, [appId]);

      if (!rows.length) {
        console.warn(`Approve/Deny failed: App ID ${appId} not found`);
        return interaction.reply({ content: 'Application not found.', ephemeral: true });
      }

      const app = rows[0];

      const embed = new EmbedBuilder()
        .setTitle('📋 Staff Application')
        .setColor(0x5865F2)
        .addFields(
          { name: 'User', value: app.user_id ? `${app.username} (${app.user_id})` : 'Anonymous (TikTok Mod)', inline: false },
          { name: 'Type', value: app.app_type === 'discord' ? 'Discord Moderator' : 'TikTok Moderator', inline: true },
          { name: 'Email', value: app.email || '—', inline: true },
          { name: 'Age', value: app.age || '—', inline: true },
          { name: 'Timezone', value: app.timezone || '—', inline: true }
        );

      if (app.app_type === 'tiktok') {
        embed.addFields(
          { name: 'TikTok Username', value: app.tiktok_username || '—', inline: true },
          { name: 'TikTok URL', value: app.tiktok_url || '—', inline: true }
        );
      }

      embed.addFields(
        { name: 'Experience', value: app.experience || 'None', inline: false },
        { name: 'Reason', value: app.reason || 'No reason provided', inline: false },
        { name: 'Status', value: action === 'approve' ? '✅ Approved' : '❌ Denied' }
      );

      if (action === 'approve') {
        const guild = await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
        if (guild && app.user_id) {
          const member = await guild.members.fetch(app.user_id).catch(() => null);
          if (member) {
            await member.roles.add(process.env.STAFF_ROLE_ID).catch(err => console.error('Role add failed:', err));
          }
        }
      }

      await pool.query(`UPDATE mod_apps SET status = $1 WHERE id = $2`, [
        action === 'approve' ? 'Approved' : 'Denied',
        appId
      ]);

      await interaction.update({ embeds: [embed], components: [] });
      return;
    }

    // Slash commands
    if (interaction.isChatInputCommand()) {
      if (!allowed(interaction.member)) {
        return interaction.reply({ content: 'You are not staff.', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });

      const cmd = interaction.commandName;

      if (cmd === 'ban') {
        const user = interaction.options.getUser('user');
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) return interaction.editReply({ content: 'User not found in server.' });

        await pool.query(
          `INSERT INTO warnings(user_id, count) VALUES($1, 5)
           ON CONFLICT (user_id) DO UPDATE SET count = 5`,
          [user.id]
        );

        await member.roles.add(process.env.WEEK_BAN_ROLE_ID).catch(() => {});
        const log = interaction.guild.channels.cache.get(process.env.STAFF_LOG_CHANNEL_ID);
        if (log) await log.send(`${member} reached 5 warnings — review for permanent ban`);

        await interaction.editReply({ content: `✅ ${member} flagged for permanent ban review (warnings set to 5).` });
      }

      else if (cmd === 'unban') {
        const user = interaction.options.getUser('user');
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) return interaction.editReply({ content: 'User not found in server.' });

        await member.roles.remove(process.env.WEEK_BAN_ROLE_ID).catch(() => {});
        await interaction.editReply({ content: `✅ Removed ban review role from ${member}. Warnings unchanged.` });
      }

      else if (cmd === 'revoke') {
        const user = interaction.options.getUser('user');
        const amount = interaction.options.getInteger('amount') ?? 1;

        if (amount < 1) return interaction.editReply({ content: 'Amount must be at least 1.' });

        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) return interaction.editReply({ content: 'User not found in server.' });

        const res = await pool.query(
          `UPDATE warnings SET count = GREATEST(count - $1, 0) WHERE user_id = $2 RETURNING count`,
          [amount, user.id]
        );

        const newCount = res.rows[0] ? res.rows[0].count : 0;

        const log = interaction.guild.channels.cache.get(process.env.STAFF_LOG_CHANNEL_ID);
        if (log) await log.send(`${interaction.user} removed **${amount}** warning(s) from ${member} → now at ${newCount}`);

        await interaction.editReply({ content: `✅ Removed **${amount}** warning(s) from ${member}. New total: **${newCount}**` });
      }

      else if (cmd === 'giveaway') {
        const sub = interaction.options.getSubcommand(false);

        if (!sub) {
          return interaction.editReply({ content: 'Use subcommand: start or end.' });
        }

        if (sub === 'start') {
          const prize = interaction.options.getString('prize', true);
          const winners = interaction.options.getInteger('winners') ?? 1;
          const minJoin = interaction.options.getInteger('min_join') ?? 0;

          if (winners < 1 || winners > 10) return interaction.editReply({ content: 'Winners must be 1–10.' });
          if (minJoin < 0 || minJoin > 1000) return interaction.editReply({ content: 'Min join must be 0–1000.' });

          let description = `**Prize:** ${prize}\n**Winners:** ${winners}\n\n**React with 🎉 to enter!**\nGood luck!`;

          let endTime = null;
          if (minJoin === 0) {
            const duration = interaction.options.getInteger('duration', true);
            if (!duration || duration < 1 || duration > 10080) return interaction.editReply({ content: 'Duration (1–10080 min) required when min_join = 0.' });
            endTime = Date.now() + duration * 60 * 1000;
            description += `\n**Ends:** <t:${Math.floor(endTime/1000)}:R>`;
          } else {
            description += `\n**Ends when ${minJoin} people join**`;
          }

          const embed = new EmbedBuilder()
            .setTitle('🎉 GIVEAWAY 🎉')
            .setDescription(description)
            .setColor(0x00ff88)
            .setFooter({ text: `Hosted by ${interaction.user.tag}` });

          const msg = await interaction.channel.send({ embeds: [embed] });
          await msg.react('🎉').catch(() => {});

          await pool.query(
            `INSERT INTO giveaways (message_id, channel_id, end_time, prize, winners, min_join)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [msg.id, interaction.channel.id, endTime, prize, winners, minJoin]
          );

          await interaction.editReply({ content: `Giveaway started → ${msg.url}` });
        }

        else if (sub === 'end') {
          const msgId = interaction.options.getString('message_id', true);

          const { rows } = await pool.query(`SELECT * FROM giveaways WHERE message_id = $1`, [msgId]);
          if (!rows.length) return interaction.editReply({ content: 'No active giveaway with that message ID.' });

          const gw = rows[0];
          const ch = await client.channels.fetch(gw.channel_id).catch(() => null);
          if (!ch) return interaction.editReply({ content: 'Channel not found.' });

          const msg = await ch.messages.fetch(msgId).catch(() => null);
          if (!msg) return interaction.editReply({ content: 'Giveaway message not found.' });

          const entrants = await getEntrantCount(msg);
          const winnersList = await pickWinners(msg, gw.winners);
          const winnerText = winnersList.length ? winnersList.map(u => u.toString()).join(', ') : 'No one entered 😢';

          const endEmbed = EmbedBuilder.from(msg.embeds[0])
            .setTitle('🎉 GIVEAWAY FORCE ENDED 🎉')
            .setDescription(`**Prize:** ${gw.prize}\n**Winners:** ${winnerText}\n**Entrants:** ${entrants}`)
            .setColor(0xff5555);

          await msg.edit({ embeds: [endEmbed] });

          if (winnersList.length) {
            await ch.send(`Congratulations ${winnerText}! You won **${gw.prize}** (force ended)!`);
          } else {
            await ch.send(`Giveaway force ended — no winners.`);
          }

          await pool.query(`DELETE FROM giveaways WHERE message_id = $1`, [msgId]);
          await interaction.editReply({ content: 'Giveaway ended early.' });
        }
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Something went wrong.', ephemeral: true }).catch(() => {});
    }
  }
});

/* ================= GIVEAWAY HELPERS ================= */
async function getEntrantCount(message) {
  const reaction = message.reactions.cache.get('🎉');
  if (!reaction) return 0;
  const users = await reaction.users.fetch();
  return users.filter(u => !u.bot && !u.system).size;
}

async function pickWinners(message, count = 1) {
  const reaction = message.reactions.cache.get('🎉');
  if (!reaction) return [];

  const users = await reaction.users.fetch();
  const entrants = users.filter(u => !u.bot && !u.system).map(u => u);

  if (entrants.length === 0) return [];

  const shuffled = entrants.sort(() => 0.5 - Math.random());
  return shuffled.slice(0, Math.min(count, entrants.length));
}

/* ================= START ================= */
client.login(process.env.DISCORD_TOKEN).catch(err => console.error('Login failed:', err));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
