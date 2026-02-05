const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder
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
      age TEXT,
      timezone TEXT,
      experience TEXT,
      reason TEXT,
      status TEXT DEFAULT 'Pending',
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

/* ================= AUTOMOD ================= */
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  if (message.mentions.users.has(process.env.PING_FORBIDDEN_USER_ID)) {
    await warn(message.member, 'Pinged forbidden user');
    const dmMsg = await ai(`You pinged a forbidden user in ${message.guild.name}.`);
    await message.member.send(dmMsg);
  }

  const badWords = ['nsfw', 'porn', 'raid', 'ddos', 'dox'];
  if (badWords.some(w => message.content.toLowerCase().includes(w))) {
    await warn(message.member, 'Inappropriate content');
  }
});

/* ================= TICKET BUTTONS ================= */
client.ticketState = {};

client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  if (interaction.customId === 'create_ticket') {
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

    client.ticketState[channel.id] = {
      waitingForUser: true,
      userId: interaction.user.id
    };

    await channel.send(await ai(`Hello ${interaction.user.username}, how can I help?`));
    await interaction.reply({ content: 'Ticket created!', ephemeral: true });
  }
});

/* ================= WELCOME ================= */
client.on('guildMemberAdd', async member => {
  const channel = member.guild.channels.cache.get(process.env.WELCOME_CHANNEL_ID);
  if (!channel) return;
  channel.send(await ai(`Welcome ${member.user.username} to Dutz Dungeon!`));
});
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

/* ================= DISCORD OAUTH ================= */

const sessions = new Map();

app.get('/auth/discord', (req, res) => {
  res.redirect(
    `https://discord.com/oauth2/authorize` +
    `?client_id=${process.env.CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}` +
    `&response_type=code&scope=identify`
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

  sessions.set(user.id, user);
  res.redirect(`/?uid=${user.id}`);
});

/* ================= STAFF APPLICATION ================= */

app.post('/apply', async (req, res) => {
  const { uid, age, timezone, experience, reason } = req.body;
  const user = sessions.get(uid);
  if (!user) return res.sendStatus(401);

  const r = await pool.query(
    `INSERT INTO mod_apps(username,user_id,age,timezone,experience,reason)
     VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
    [user.username, user.id, age, timezone, experience, reason]
  );

  const embed = new EmbedBuilder()
    .setTitle('📋 Staff Application')
    .setColor(0x5865F2)
    .addFields(
      { name: 'User', value: `${user.username} (${user.id})` },
      { name: 'Age', value: age, inline: true },
      { name: 'Timezone', value: timezone, inline: true },
      { name: 'Experience', value: experience },
      { name: 'Reason', value: reason },
      { name: 'Status', value: '⏳ Pending' }
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve_${r.rows[0].id}`)
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`deny_${r.rows[0].id}`)
      .setLabel('Deny')
      .setStyle(ButtonStyle.Danger)
  );

  const ch = await client.channels.fetch(process.env.STAFF_APPS_CHANNEL_ID);
  await ch.send({ embeds: [embed], components: [row] });

  res.sendStatus(200);
});

/* ================= APPROVE / DENY ================= */

client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('approve_') &&
      !interaction.customId.startsWith('deny_')) return;

  const [action, id] = interaction.customId.split('_');
  const r = await pool.query(`SELECT * FROM mod_apps WHERE id=$1`, [id]);
  if (!r.rows.length) return;

  const appData = r.rows[0];
  const embed = EmbedBuilder.from(interaction.message.embeds[0]);

  embed.spliceFields(5, 1, {
    name: 'Status',
    value: action === 'approve' ? '✅ Approved' : '❌ Denied'
  });

  if (action === 'approve') {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const member = await guild.members.fetch(appData.user_id);
    await member.roles.add(process.env.STAFF_ROLE_ID);
  }

  await pool.query(
    `UPDATE mod_apps SET status=$1 WHERE id=$2`,
    [action === 'approve' ? 'Approved' : 'Denied', id]
  );

  await interaction.update({ embeds: [embed], components: [] });
});

/* ================= START ================= */

client.login(process.env.DISCORD_TOKEN);
app.listen(process.env.PORT || 3000);
