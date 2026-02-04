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
app.get('/', (_, res) => {
  res.sendFile(__dirname + '/index.html');
});

app.get('/clips', (_, res) => {
  res.json({
    clips: (process.env.TIKTOK_CLIPS || '').split(',').filter(Boolean),
    gifters: (process.env.GIFTER_CLIPS || '').split(',').filter(Boolean)
  });
});

/* ================= DISCORD OAUTH ================= */
app.get('/auth/discord', (_, res) => {
  res.redirect(
    `https://discord.com/oauth2/authorize` +
    `?client_id=${process.env.CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=identify`
  );
});

app.get('/auth/callback', async (req, res) => {
  if (!req.query.code) return res.send('No code');

  const token = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: req.query.code,
      redirect_uri: process.env.REDIRECT_URI
    })
  }).then(r => r.json());

  const user = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${token.access_token}` }
  }).then(r => r.json());

  await pool.query(
    `INSERT INTO mod_apps(username, user_id, reason)
     VALUES ($1, $2, $3)`,
    [user.username, user.id, 'Website application']
  );

  const channel = await client.channels.fetch(process.env.STAFF_APPS_CHANNEL_ID);
  channel.send(
    `📋 **Staff Application**\n` +
    `User: **${user.username}**\nID: \`${user.id}\``
  );

  res.send('✅ Application submitted. You may close this page.');
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
  if (count >= 4) await member.roles.add(process.env.WEEK_BAN_ROLE_ID);
}

/* ================= AUTOMOD & TICKETS ================= */
client.ticketState = {};

client.on('messageCreate', async message => {
  if (message.author.bot) return;

  if (message.mentions.users.has(process.env.PING_FORBIDDEN_USER_ID)) {
    await warn(message.member, 'Pinged forbidden user');
    await message.member.send(await ai('Do not ping that user.'));
  }

  const badWords = ['nsfw', 'porn', 'raid', 'ddos', 'dox'];
  if (badWords.some(w => message.content.toLowerCase().includes(w))) {
    await warn(message.member, 'Inappropriate content');
  }
});

/* ================= INTERACTIONS ================= */
client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand()) {
    if (!allowed(interaction.member)) {
      return interaction.reply({ content: '❌ Not allowed.', flags: 64 });
    }
  }
});

/* ================= START ================= */
client.login(process.env.DISCORD_TOKEN);
app.listen(process.env.PORT || 3000);
