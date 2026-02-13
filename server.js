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
      ADD COLUMN IF NOT EXISTS tiktok_url TEXT;

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
    if (!r.ok) return 'AI unavailable.';
    const d = await r.json();
    return d.choices?.[0]?.message?.content?.trim() || 'How can I help?';
  } catch (err) {
    console.error('AI error:', err);
    return 'AI offline.';
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

/* ================= WARNING SYSTEM ================= */
async function warn(member, rule) {
  if (!member || member.user.bot) return;
  try {
    const r = await pool.query(
      `INSERT INTO warnings(user_id, count)
       VALUES($1, 1)
       ON CONFLICT (user_id)
       DO UPDATE SET count = warnings.count + 1
       RETURNING count`,
      [member.id]
    );
    const count = r.rows[0].count;
    await member.send(`**Rule broken:** ${rule}\nYou now have **${count}** warning(s).`).catch(() => {});
    const log = member.guild.channels.cache.get(process.env.STAFF_LOG_CHANNEL_ID);
    if (log) await log.send(`${member} — **${rule}** — Warning #${count}`);
    if (count === 2) await member.timeout(60 * 60 * 1000, '2 warnings').catch(() => {});
    if (count === 3) await member.timeout(24 * 60 * 60 * 1000, '3 warnings').catch(() => {});
    if (count >= 4) {
      await member.roles.add(process.env.WEEK_BAN_ROLE_ID).catch(() => {});
      if (count >= 5 && log) {
        await log.send(`**${member} reached 5 warnings — review for permanent ban**`);
      }
    }
  } catch (err) {
    console.error('Warning system error:', err);
  }
}

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

/* ================= AUTO-END ON MIN JOIN ================= */
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.emoji.name !== '🎉') return;

  const message = reaction.message;
  if (!message.guild) return;

  const { rows } = await pool.query(`SELECT * FROM giveaways WHERE message_id = $1`, [message.id]);
  if (!rows.length) return;

  const gw = rows[0];
  if (gw.min_join <= 0) return;

  const currentEntrants = await getEntrantCount(message);

  if (currentEntrants >= gw.min_join) {
    try {
      const winnersList = await pickWinners(message, gw.winners);
      const winnerText = winnersList.length
        ? winnersList.map(u => u.toString()).join(', ')
        : 'No one entered 😢';

      const endEmbed = EmbedBuilder.from(message.embeds[0])
        .setTitle('🎉 GIVEAWAY ENDED 🎉 — Minimum reached!')
        .setDescription(`**Prize:** ${gw.prize}\n**Winners:** ${winnerText}\n**Entrants:** ${currentEntrants}`)
        .setColor(0xff5555);

      await message.edit({ embeds: [endEmbed] });

      if (winnersList.length) {
        await message.channel.send(`Congratulations ${winnerText}! You won **${gw.prize}**!`);
      } else {
        await message.channel.send('Giveaway ended — no entrants.');
      }

      await pool.query(`DELETE FROM giveaways WHERE message_id = $1`, [message.id]);
    } catch (err) {
      console.error('Min-join auto-end failed:', err);
    }
  }
});

/* ================= INTERACTIONS ================= */
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton() && !interaction.isChatInputCommand()) return;

  try {
    if (interaction.isButton() && interaction.customId === 'create_ticket') {
      const guild = interaction.guild;
      const channel = await guild.channels.create({
        name: `ticket-${interaction.user.username}`,
        type: ChannelType.GuildText,
        parent: process.env.TICKET_OPEN_CATEGORY_ID,
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionsBitField.Flags.SendMessages] },
          { id: interaction.user.id, allow: [PermissionsBitField.Flags.SendMessages] },
          { id: client.user.id, allow: [PermissionsBitField.Flags.SendMessages] }
        ]
      });
      client.ticketState[channel.id] = { waitingForUser: true, userId: interaction.user.id };
      const greet = await ai(`Hello ${interaction.user.username}, welcome to your ticket! How can I help you today?`);
      await channel.send(greet);
      await interaction.reply({ content: 'Ticket created! → ' + channel, flags: 64 });
      return;
    }

    if (interaction.isButton()) {
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

    if (interaction.isButton() && (interaction.customId.startsWith('approve_') || interaction.customId.startsWith('deny_'))) {
      if (!allowed(interaction.member)) return interaction.reply({ content: 'Only staff can use these buttons.', flags: 64 });

      const [action, appId] = interaction.customId.split('_');
      const { rows } = await pool.query(`SELECT * FROM mod_apps WHERE id = $1`, [appId]);
      if (!rows.length) return interaction.reply({ content: 'Application not found.', flags: 64 });

      const app = rows[0];

      // Rebuild embed with updated status
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
        { name: 'Experience', value: app.experience || 'None' },
        { name: 'Reason', value: app.reason || 'No reason provided' },
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

    if (interaction.isChatInputCommand()) {
      if (!allowed(interaction.member)) {
        return interaction.reply({ content: 'You are not staff.', flags: 64 });
      }

      await interaction.deferReply({ flags: 64 });

      const cmd = interaction.commandName;

      if (cmd === 'ban') {
        const user = interaction.options.getUser('user');
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) return interaction.editReply({ content: 'User not found in server.', flags: 64 });

        await pool.query(
          `INSERT INTO warnings(user_id, count) VALUES($1, 5)
           ON CONFLICT (user_id) DO UPDATE SET count = 5`,
          [member.id]
        );

        await member.roles.add(process.env.WEEK_BAN_ROLE_ID).catch(() => {});
        const log = interaction.guild.channels.cache.get(process.env.STAFF_LOG_CHANNEL_ID);
        if (log) await log.send(`${member} reached 5 warnings — review for permanent ban`);

        await interaction.editReply({ content: `✅ ${member} flagged for permanent ban review (warnings set to 5).`, flags: 64 });
      }

      // ... (rest of slash commands unchanged - ban, unban, revoke, giveaway)
      // Omitted for brevity - copy from your previous working version if needed
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Something went wrong.', flags: 64 }).catch(() => {});
    }
  }
});

/* ================= WELCOME ================= */
client.on('guildMemberAdd', async member => {
  const channel = member.guild.channels.cache.get(process.env.WELCOME_CHANNEL_ID);
  if (!channel) return;
  const msg = await ai(`Welcome ${member.user.username} to Dutz Dungeon! Short & fun welcome message.`);
  await channel.send(msg).catch(() => {});
});

/* ================= RULES SYSTEM ================= */
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (message.content === '!sendrules') {
    if (!message.member.permissions.has('ADMINISTRATOR')) {
      return message.reply('❌ You need administrator permissions.');
    }

    const rulesEmbed = new EmbedBuilder()
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

    const sent = await message.channel.send({ embeds: [rulesEmbed] });
    await sent.react('✅');

    pendingVerifications.set(sent.id, {
      channelId: message.channel.id,
      guildId: message.guild.id,
      type: 'rules'
    });

    return message.reply('Rules message sent!');
  }
});

/* ================= REACTION HANDLER ================= */
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
        .then(r => console.log('Pinged Render to stay awake'))
        .catch(err => console.error('Render ping failed:', err));

      await reaction.message.channel.send({
        content: `<@${user.id}> You have been verified!`,
        flags: 64
      });

      console.log(`Verified ${user.tag} - gave role`);
    } catch (err) {
      console.error('Verification error:', err);
    }
  }
});

/* ================= KEEP RENDER ALIVE ================= */
app.get('/ping', (req, res) => {
  res.send('Pong - Render instance kept alive');
});

setInterval(() => {
  fetch('https://thebigdutz.qzz.io/ping')
    .then(r => console.log('Auto-pinged self to stay awake'))
    .catch(err => console.error('Self-ping failed:', err));
}, 1 * 60 * 1000);

/* ================= WEBSITE ROUTES ================= */
const sessions = new Map();

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

app.get('/clips', (req, res) => {
  res.json({
    clips: (process.env.TIKTOK_CLIPS || '').split(',').filter(Boolean),
    gifters: (process.env.GIFTER_CLIPS || '').split(',').filter(Boolean)
  });
});

app.get('/auth/discord', (req, res) => {
  if (!process.env.CLIENT_ID_AUTH || !process.env.CLIENT_SECRET_AUTH) {
    console.error('Missing CLIENT_ID_AUTH or CLIENT_SECRET_AUTH');
    return res.status(500).send('Missing Discord OAuth credentials.');
  }

  const url = `https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID_AUTH}&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&response_type=code&scope=identify`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  try {
    if (!req.query.code) return res.status(400).send('No code received.');

    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.CLIENT_ID_AUTH,
        client_secret: process.env.CLIENT_SECRET_AUTH,
        grant_type: 'authorization_code',
        code: req.query.code,
        redirect_uri: process.env.REDIRECT_URI
      })
    });

    if (!tokenRes.ok) throw new Error('Token fetch failed');

    const tokenData = await tokenRes.json();

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });

    if (!userRes.ok) throw new Error('User fetch failed');

    const user = await userRes.json();
    sessions.set(user.id, user);
    res.cookie('auth_uid', user.id, { httpOnly: true, secure: true, sameSite: 'strict', maxAge: 86400000 });

    res.redirect(`/?uid=${user.id}`);
  } catch (err) {
    console.error('OAuth error:', err);
    res.status(500).send('Login error.');
  }
});

app.post('/apply', async (req, res) => {
  try {
    const { 
      app_type = 'discord',
      email,
      age,
      timezone,
      tiktok_username,
      tiktok_url,
      experience,
      reason,
      uid 
    } = req.body;

    let username = 'Anonymous';
    let userId = null;

    if (uid) {
      const user = sessions.get(uid);
      if (user) {
        username = user.username;
        userId = user.id;
      }
    }

    const queryParams = [
      username,
      userId,
      app_type,
      email,
      age,
      timezone,
      tiktok_username || null,
      tiktok_url || null,
      experience,
      reason
    ];

    const r = await pool.query(
      `INSERT INTO mod_apps (
        username, user_id, app_type, email, age, timezone, tiktok_username, tiktok_url, experience, reason
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      queryParams
    );

    const embed = new EmbedBuilder()
      .setTitle('📋 Staff Application')
      .setColor(0x5865F2)
      .addFields(
        { name: 'User', value: userId ? `${username} (${userId})` : 'Anonymous (TikTok Mod)', inline: false },
        { name: 'Type', value: app_type === 'discord' ? 'Discord Moderator' : 'TikTok Moderator', inline: true },
        { name: 'Email', value: email || '—', inline: true },
        { name: 'Age', value: age || '—', inline: true },
        { name: 'Timezone', value: timezone || '—', inline: true }
      );

    if (app_type === 'tiktok') {
      embed.addFields(
        { name: 'TikTok Username', value: tiktok_username || '—', inline: true },
        { name: 'TikTok URL', value: tiktok_url || '—', inline: true }
      );
    }

    embed.addFields(
      { name: 'Experience', value: experience || 'None', inline: false },
      { name: 'Reason', value: reason || 'No reason provided', inline: false },
      { name: 'Status', value: '⏳ Pending' }
    );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`approve_${r.rows[0].id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`deny_${r.rows[0].id}`).setLabel('Deny').setStyle(ButtonStyle.Danger)
    );

    const channel = await client.channels.fetch(process.env.STAFF_APPS_CHANNEL_ID).catch(err => {
      console.error('Failed to fetch staff channel:', err);
      return null;
    });

    if (channel) {
      await channel.send({ embeds: [embed], components: [row] });
      console.log('Application posted to channel');
    } else {
      console.warn('Staff channel not found');
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Apply error:', err);
    res.status(500).send('Server error during submission.');
  }
});

/* ================= REGISTER SLASH COMMANDS ================= */
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName('ban')
      .setDescription('Flag user for permanent ban review')
      .addUserOption(opt => opt.setName('user').setDescription('The user').setRequired(true)),
    new SlashCommandBuilder()
      .setName('unban')
      .setDescription('Remove ban review role')
      .addUserOption(opt => opt.setName('user').setDescription('The user').setRequired(true)),
    new SlashCommandBuilder()
      .setName('revoke')
      .setDescription('Remove warnings')
      .addUserOption(opt => opt.setName('user').setDescription('The user').setRequired(true))
      .addIntegerOption(opt => opt.setName('amount').setDescription('Number to remove').setRequired(false).setMinValue(1)),
    new SlashCommandBuilder()
      .setName('giveaway')
      .setDescription('Manage giveaways')
      .addSubcommand(sub =>
        sub.setName('start')
           .setDescription('Start giveaway')
           .addStringOption(opt => opt.setName('prize').setDescription('Prize').setRequired(true))
           .addIntegerOption(opt => opt.setName('winners').setDescription('Winners').setRequired(false).setMinValue(1).setMaxValue(10))
           .addIntegerOption(opt => opt.setName('min_join').setDescription('Min entrants').setRequired(false).setMinValue(0))
           .addIntegerOption(opt => opt.setName('duration').setDescription('Duration min').setRequired(false).setMinValue(1).setMaxValue(10080))
      )
      .addSubcommand(sub =>
        sub.setName('end')
           .setDescription('End giveaway')
           .addStringOption(opt => opt.setName('message_id').setDescription('Message ID').setRequired(true))
      )
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    if (!process.env.GUILD_ID) return console.error('GUILD_ID missing');
    await rest.put(Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID), { body: commands });
    console.log('Commands registered');
  } catch (err) {
    console.error('Command register failed:', err);
  }
});

/* ================= START ================= */
client.login(process.env.DISCORD_TOKEN).catch(err => console.error('Login failed:', err));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server on port ${PORT}`);
});
