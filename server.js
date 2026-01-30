const {
  Client, GatewayIntentBits, PermissionsBitField,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  REST, Routes, SlashCommandBuilder, ChannelType
} = require('discord.js');

const express = require('express');
const fetch = require('node-fetch');
const { Pool } = require('pg');

const app = express();
app.use(express.urlencoded({ extended: true }));

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

/* ================= DISCORD ================= */
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
  return d.choices?.[0]?.message?.content || "Hello!";
}

/* ================= ROLE CHECK ================= */
function allowed(member) {
  return member.roles.cache.has(process.env.STAFF_ROLE_ID) ||
         member.roles.cache.has(process.env.MOD_ROLE_ID) ||
         member.roles.cache.has(process.env.ADMIN_ROLE_ID);
}

/* ================= WARNINGS ================= */
async function warn(member, rule) {
  const r = await pool.query(`
    INSERT INTO warnings(user_id,count)
    VALUES($1,1)
    ON CONFLICT (user_id)
    DO UPDATE SET count = warnings.count + 1
    RETURNING count`, [member.id]);

  const c = r.rows[0].count;

  await member.send(`Rule broken: ${rule}`);

  const log = member.guild.channels.cache.get(process.env.STAFF_LOG_CHANNEL_ID);
  log?.send(`${member} | ${rule} | Warning ${c}`);

  if (c === 2) member.timeout(3600000);
  if (c === 3) member.timeout(86400000);
  if (c === 4) member.roles.add(process.env.WEEK_BAN_ROLE_ID);
  if (c >= 5) log.send(`${member} requires perm ban review`);
}

/* ================= AUTOMOD ================= */
client.on('messageCreate', m => {
  if (m.author.bot) return;

  if (m.author.id === process.env.PING_FORBIDDEN_USER_ID && m.mentions.users.size)
    warn(m.member, "Ping abuse");

  const bad = ["nsfw", "porn", "raid", "ddos", "dox"];
  if (bad.some(w => m.content.toLowerCase().includes(w)))
    warn(m.member, "Inappropriate content");
});

/* ================= TICKET SYSTEM ================= */
client.on('messageCreate', async m => {
  if (m.channel.id !== process.env.TICKETS_CHANNEL_ID) return;
  if (m.author.bot) return;

  const guild = m.guild;

  const channel = await guild.channels.create({
    name: `ticket-${m.author.username}`,
    type: ChannelType.GuildText,
    parent: process.env.TICKET_LOCKED_CATEGORY_ID,
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionsBitField.Flags.SendMessages] },
      { id: m.author.id, deny: [PermissionsBitField.Flags.SendMessages] },
      { id: client.user.id, allow: [PermissionsBitField.Flags.SendMessages] }
    ]
  });

  const response = await ai(m.content);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('continue').setLabel('Continue').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('ping').setLabel('Ping Staff').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
  );

  channel.send({ content: response, components: [row] });
});

/* ================= TICKET BUTTONS ================= */
client.on('interactionCreate', async i => {
  if (!i.isButton()) return;

  const channel = i.channel;

  if (i.customId === 'continue') {
    await channel.setParent(process.env.TICKET_OPEN_CATEGORY_ID);
    await channel.permissionOverwrites.edit(i.user.id, {
      SendMessages: true
    });
    await i.deferUpdate();
  }

  if (i.customId === 'ping') {
    channel.send(`<@&${process.env.STAFF_ROLE_ID}>`);
    await i.deferUpdate();
  }

  if (i.customId === 'close') {
    await channel.delete();
  }
});

/* ================= WELCOME AI ================= */
client.on('guildMemberAdd', async member => {
  const ch = member.guild.channels.cache.get(process.env.WELCOME_CHANNEL_ID);
  if (!ch) return;

  const msg = await ai(`Welcome ${member.user.username} to Dutz Dungeon community`);
  ch.send(msg);
});

/* ================= SLASH COMMANDS ================= */
const commands = [
  new SlashCommandBuilder().setName('rules').setDescription('Send rules'),
  new SlashCommandBuilder().setName('invitereward').setDescription('Send invite reward'),
  new SlashCommandBuilder().setName('ban')
    .addUserOption(o => o.setName('user').setRequired(true)),
  new SlashCommandBuilder().setName('unban')
    .addUserOption(o => o.setName('user').setRequired(true)),
  new SlashCommandBuilder().setName('revoke')
    .addUserOption(o => o.setName('user').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setRequired(true)),
  new SlashCommandBuilder().setName('nuke').setDescription('Nuke channel'),
  new SlashCommandBuilder().setName('giveaway')
    .addStringOption(o => o.setName('prize').setRequired(true))
    .addIntegerOption(o => o.setName('minutes').setRequired(true))
].map(c => c.toJSON());

client.once('ready', async () => {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
  console.log(`Logged in as ${client.user.tag}`);
});

/* ================= COMMAND HANDLER ================= */
client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand()) return;
  if (!allowed(i.member)) return i.deferReply({ ephemeral: true });

  if (i.commandName === 'rules') {
    i.channel.send(`Rules:
Be respectful
No NSFW
No spam
No ads
No threats`);
  }

  if (i.commandName === 'invitereward') {
    i.channel.send(`Anyone who you invite gets 10 robux...

Join group:
https://www.roblox.com/share/g/46230128`);
  }

  if (i.commandName === 'ban') {
    const u = i.options.getUser('user');
    const m = await i.guild.members.fetch(u.id);
    await warn(m, "Manual ban command");
  }

  if (i.commandName === 'unban') {
    await i.guild.members.unban(i.options.getUser('user').id);
  }

  if (i.commandName === 'revoke') {
    await pool.query(
      `UPDATE warnings SET count = GREATEST(count - $1,0) WHERE user_id=$2`,
      [i.options.getInteger('amount'), i.options.getUser('user').id]
    );
  }

  if (i.commandName === 'nuke') {
    const c = i.channel;
    const clone = await c.clone();
    await c.delete();
    clone.setPosition(c.position);
  }

  if (i.commandName === 'giveaway') {
    const prize = i.options.getString('prize');
    const minutes = i.options.getInteger('minutes');
    const msg = await i.channel.send(`🎉 Giveaway: **${prize}**
React with 🎉 to enter!
Ends in ${minutes} minutes`);

    await msg.react('🎉');

    await pool.query(
      `INSERT INTO giveaways VALUES($1,$2,$3,$4)`,
      [msg.id, msg.channel.id, Date.now() + minutes * 60000, prize]
    );
  }

  await i.deferReply({ ephemeral: true });
});

/* ================= GIVEAWAY CHECK ================= */
setInterval(async () => {
  const r = await pool.query(`SELECT * FROM giveaways WHERE end_time <= $1`, [Date.now()]);
  for (const g of r.rows) {
    const ch = await client.channels.fetch(g.channel_id);
    const msg = await ch.messages.fetch(g.message_id);
    const users = (await msg.reactions.cache.get('🎉').users.fetch()).filter(u => !u.bot);

    if (users.size > 0) {
      const winner = users.random();
      ch.send(`🎉 Winner: ${winner} | Prize: **${g.prize}**`);
    }

    await pool.query(`DELETE FROM giveaways WHERE message_id=$1`, [g.message_id]);
  }
}, 15000);

/* ================= WEBSITE ================= */
app.get('/', (_, r) => r.sendFile(__dirname + '/index.html'));

app.post('/apply', async (req, res) => {
  const { username, userid, reason } = req.body;
  await pool.query(
    `INSERT INTO mod_apps(username,user_id,reason) VALUES($1,$2,$3)`,
    [username, userid, reason]
  );
  res.send("Application submitted.");
});

/* ================= START ================= */
client.login(process.env.DISCORD_TOKEN);
app.listen(process.env.PORT || 3000);
