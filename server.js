const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType
} = require('discord.js');

const express = require('express');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { Pool } = require('pg');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(__dirname));

/* ================= DATABASE ================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS warnings (
      user_id TEXT PRIMARY KEY,
      count INT DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS mod_apps (
      id SERIAL PRIMARY KEY,
      username TEXT,
      user_id TEXT,
      reason TEXT,
      submitted_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS giveaways (
      message_id TEXT PRIMARY KEY,
      channel_id TEXT,
      end_time BIGINT,
      prize TEXT
    );
  `);
})();

/* ================= DISCORD CLIENT ================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

/* ================= AI ================= */
async function ai(prompt) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const d = await r.json();
  return d.choices?.[0]?.message?.content || 'Hello!';
}

/* ================= WEBSITE ================= */
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

app.get('/clips', (req, res) => {
  res.json({
    clips: (process.env.TIKTOK_CLIPS || '').split(',').filter(Boolean),
    gifters: (process.env.GIFTER_CLIPS || '').split(',').filter(Boolean)
  });
});

/* ================= ROLE CHECK ================= */
function allowed(member) {
  return (
    member.roles.cache.has(process.env.STAFF_ROLE_ID) ||
    member.roles.cache.has(process.env.MOD_ROLE_ID) ||
    member.roles.cache.has(process.env.ADMIN_ROLE_ID)
  );
}

/* ================= WARNINGS ================= */
async function warn(member, rule) {
  const r = await pool.query(
    `INSERT INTO warnings(user_id, count)
     VALUES($1, 1)
     ON CONFLICT (user_id)
     DO UPDATE SET count = warnings.count + 1
     RETURNING count`,
    [member.id]
  );

  const count = r.rows[0].count;

  await member.send(`Rule broken: ${rule}`);

  const log = member.guild.channels.cache.get(process.env.STAFF_LOG_CHANNEL_ID);
  log?.send(`${member} | ${rule} | Warning ${count}`);

  if (count === 2) await member.timeout(60 * 60 * 1000);
  if (count === 3) await member.timeout(24 * 60 * 60 * 1000);
  if (count === 4) await member.roles.add(process.env.WEEK_BAN_ROLE_ID);
  if (count >= 5) {
    await member.roles.add(process.env.WEEK_BAN_ROLE_ID);
    log?.send(`${member} has reached 5th warning — review for permanent ban`);
  }
}

/* ================= AUTOMOD & TICKETS ================= */
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  if (message.mentions.users.has(process.env.PING_FORBIDDEN_USER_ID)) {
    await warn(message.member, 'Pinged forbidden user');
    const dmMsg = await ai(`You pinged a forbidden user in ${message.guild.name}. Please follow the rules.`);
    await message.member.send(dmMsg);
  }

  const badWords = ['nsfw', 'porn', 'raid', 'ddos', 'dox'];
  if (badWords.some(w => message.content.toLowerCase().includes(w))) {
    await warn(message.member, 'Inappropriate content');
  }

  const ticketState = client.ticketState || {};
  const state = ticketState[message.channel.id];

  if (state && state.waitingForUser && state.userId === message.author.id) {
    await message.channel.setParent(process.env.TICKET_LOCKED_CATEGORY_ID);
    await message.channel.permissionOverwrites.edit(message.author.id, { SendMessages: false });
    state.waitingForUser = false;

    const aiMsg = await ai(`User says: ${message.content}`);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('continue').setLabel('Continue').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('ping').setLabel('Ping Staff').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
    );

    await message.channel.send({ content: aiMsg, components: [row] });
  }
});

/* ================= INTERACTIONS (ONLY ONE) ================= */
client.ticketState = {};

client.on('interactionCreate', async interaction => {
  try {
    if (!interaction.isButton() && !interaction.isChatInputCommand()) return;

    /* ===== STAFF APPROVE / DENY ===== */
    if (interaction.isButton() && interaction.customId.startsWith('approve_')) {
      const userId = interaction.customId.split('_')[1];
      const member = await interaction.guild.members.fetch(userId).catch(() => null);

      if (member) {
        await member.roles.add(process.env.STAFF_ROLE_ID);
        await interaction.update({
          content: interaction.message.content + '\n\n✅ **Approved**',
          components: []
        });
      }
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('deny_')) {
      await interaction.update({
        content: interaction.message.content + '\n\n❌ **Denied**',
        components: []
      });
      return;
    }

    /* ===== TICKET CREATE ===== */
    if (interaction.isButton() && interaction.customId === 'create_ticket') {
      const guild = interaction.guild;

      const ticketChannel = await guild.channels.create({
        name: `ticket-${interaction.user.username}`,
        type: ChannelType.GuildText,
        parent: process.env.TICKET_OPEN_CATEGORY_ID,
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionsBitField.Flags.SendMessages] },
          { id: interaction.user.id, allow: [PermissionsBitField.Flags.SendMessages] },
          { id: client.user.id, allow: [PermissionsBitField.Flags.SendMessages] }
        ]
      });

      const greetMsg = await ai(`Hello ${interaction.user.username}, welcome to your ticket!`);
      await ticketChannel.send(greetMsg);

      client.ticketState[ticketChannel.id] = {
        waitingForUser: true,
        userId: interaction.user.id
      };

      await interaction.deferReply({ flags: 64 });
      await interaction.followUp({ content: 'Ticket created!', flags: 64 });
      return;
    }

    /* ===== SLASH COMMANDS ===== */
    if (interaction.isChatInputCommand()) {
      if (!allowed(interaction.member)) {
        await interaction.deferReply({ flags: 64 });
        return interaction.followUp({ content: 'You are not allowed.', flags: 64 });
      }

      const cmd = interaction.commandName;

      if (cmd === 'rules') {
        await interaction.reply({ content: '**Rules**\nBe respectful.', flags: 64 });
      }

      if (cmd === 'ban') {
        const user = interaction.options.getUser('user');
        const member = await interaction.guild.members.fetch(user.id);
        await member.roles.add(process.env.WEEK_BAN_ROLE_ID);
        await interaction.reply({ content: `✅ ${member} banned.`, flags: 64 });
      }

      if (cmd === 'unban') {
        const user = interaction.options.getUser('user');
        const member = await interaction.guild.members.fetch(user.id);
        await member.roles.remove(process.env.WEEK_BAN_ROLE_ID);
        await interaction.reply({ content: `✅ ${member} unbanned.`, flags: 64 });
      }
    }
  } catch (err) {
    console.error(err);
  }
});

/* ================= WELCOME ================= */
client.on('guildMemberAdd', async member => {
  const channel = member.guild.channels.cache.get(process.env.WELCOME_CHANNEL_ID);
  if (!channel) return;
  const msg = await ai(`Welcome ${member.user.username} to Dutz Dungeon community`);
  channel.send(msg);
});

/* ================= START ================= */
client.login(process.env.DISCORD_TOKEN);
app.listen(process.env.PORT || 3000);
