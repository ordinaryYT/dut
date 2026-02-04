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

/* ================= DATABASE (UNCHANGED) ================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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

/* ================= WEBSITE ROUTES ================= */
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
app.get('/auth/discord', (req, res) => {
  const url =
    `https://discord.com/oauth2/authorize` +
    `?client_id=${process.env.CLIENT_ID}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}` +
    `&scope=identify`;

  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;

  const data = new URLSearchParams({
    client_id: process.env.CLIENT_ID,
    client_secret: process.env.CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.REDIRECT_URI
  });

  const token = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: data
  }).then(r => r.json());

  const user = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${token.access_token}` }
  }).then(r => r.json());

  res.send(`
    <h2>Staff Application</h2>
    <form method="POST" action="/apply">
      <input type="hidden" name="id" value="${user.id}">
      <p>Logged in as <b>${user.username}#${user.discriminator}</b></p>
      <textarea name="reason" placeholder="Why should we pick you?" required></textarea><br><br>
      <button type="submit">Submit</button>
    </form>
  `);
});

/* ================= STAFF APPLICATION ================= */
app.post('/apply', async (req, res) => {
  const { id, reason } = req.body;

  const user = await client.users.fetch(id);
  const channel = await client.channels.fetch(process.env.STAFF_APP_CHANNEL_ID);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve_${id}`)
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`deny_${id}`)
      .setLabel('Deny')
      .setStyle(ButtonStyle.Danger)
  );

  await channel.send({
    content:
      `🧑‍💼 **Staff Application**\n\n` +
      `User: ${user.tag} (${user.id})\n\n` +
      `**Reason:**\n${reason}`,
    components: [row]
  });

  res.send('Application submitted! You can close this page.');
});

/* ================= BUTTON HANDLING ================= */
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  const [action, userId] = interaction.customId.split('_');
  const member = await interaction.guild.members.fetch(userId).catch(() => null);

  if (action === 'approve' && member) {
    await member.roles.add(process.env.STAFF_ROLE_ID);
    await interaction.update({
      content: interaction.message.content + '\n\n✅ **Approved**',
      components: []
    });
  }

  if (action === 'deny') {
    await interaction.update({
      content: interaction.message.content + '\n\n❌ **Denied**',
      components: []
    });
  }
});

/* ================= START ================= */
client.login(process.env.DISCORD_TOKEN);
app.listen(process.env.PORT || 3000);
