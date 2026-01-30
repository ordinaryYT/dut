const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType
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
    `
    INSERT INTO warnings(user_id, count)
    VALUES($1, 1)
    ON CONFLICT (user_id)
    DO UPDATE SET count = warnings.count + 1
    RETURNING count
    `,
    [member.id]
  );

  const count = r.rows[0].count;

  await member.send(`Rule broken: ${rule}`);

  const log = member.guild.channels.cache.get(process.env.STAFF_LOG_CHANNEL_ID);
  log?.send(`${member} | ${rule} | Warning ${count}`);

  if (count === 2) await member.timeout(60 * 60 * 1000);
  if (count === 3) await member.timeout(24 * 60 * 60 * 1000);
  if (count === 4) await member.roles.add(process.env.WEEK_BAN_ROLE_ID);
  if (count >= 5) log?.send(`${member} requires perm ban review`);
}

/* ================= AUTOMOD ================= */
client.on('messageCreate', message => {
  if (message.author.bot) return;

  if (
    message.author.id === process.env.PING_FORBIDDEN_USER_ID &&
    message.mentions.users.size > 0
  ) {
    warn(message.member, 'Ping abuse');
  }

  const badWords = ['nsfw', 'porn', 'raid', 'ddos', 'dox'];
  if (badWords.some(w => message.content.toLowerCase().includes(w))) {
    warn(message.member, 'Inappropriate content');
  }
});

/* ================= TICKETS ================= */
client.on('messageCreate', async message => {
  if (message.channel.id !== process.env.TICKETS_CHANNEL_ID) return;
  if (message.author.bot) return;

  const guild = message.guild;

  const ticketChannel = await guild.channels.create({
    name: `ticket-${message.author.username}`,
    type: ChannelType.GuildText,
    parent: process.env.TICKET_LOCKED_CATEGORY_ID,
    permissionOverwrites: [
      {
        id: guild.id,
        deny: [PermissionsBitField.Flags.SendMessages]
      },
      {
        id: message.author.id,
        deny: [PermissionsBitField.Flags.SendMessages]
      },
      {
        id: client.user.id,
        allow: [PermissionsBitField.Flags.SendMessages]
      }
    ]
  });

  const response = await ai(message.content);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('continue')
      .setLabel('Continue')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('ping')
      .setLabel('Ping Staff')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('close')
      .setLabel('Close Ticket')
      .setStyle(ButtonStyle.Danger)
  );

  await ticketChannel.send({ content: response, components: [row] });
});

/* ================= TICKET BUTTONS ================= */
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  const channel = interaction.channel;

  if (interaction.customId === 'continue') {
    await channel.setParent(process.env.TICKET_OPEN_CATEGORY_ID);
    await channel.permissionOverwrites.edit(interaction.user.id, {
      SendMessages: true
    });
    await interaction.deferUpdate();
  }

  if (interaction.customId === 'ping') {
    channel.send(`<@&${process.env.STAFF_ROLE_ID}>`);
    await interaction.deferUpdate();
  }

  if (interaction.customId === 'close') {
    await channel.delete();
  }
});

/* ================= WELCOME AI ================= */
client.on('guildMemberAdd', async member => {
  const channel = member.guild.channels.cache.get(process.env.WELCOME_CHANNEL_ID);
  if (!channel) return;

  const msg = await ai(
    `Welcome ${member.user.username} to Dutz Dungeon community`
  );
  channel.send(msg);
});

/* ================= SLASH COMMANDS (FIXED) ================= */
const commands = [
  new SlashCommandBuilder()
    .setName('rules')
    .setDescription('Send the server rules'),

  new SlashCommandBuilder()
    .setName('invitereward')
    .setDescription('Send invite reward information'),

  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Issue final warning (manual perm ban review)')
    .addUserOption(o =>
      o
        .setName('user')
        .setDescription('User to ban')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Unban a user')
    .addUserOption(o =>
      o
        .setName('user')
        .setDescription('User to unban')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('revoke')
    .setDescription('Revoke warnings from a user')
    .addUserOption(o =>
      o
        .setName('user')
        .setDescription('User to revoke warnings from')
        .setRequired(true)
    )
    .addIntegerOption(o =>
      o
        .setName('amount')
        .setDescription('Number of warnings to remove')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('nuke')
    .setDescription('Delete and recreate the current channel'),

  new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Start a giveaway')
    .addStringOption(o =>
      o
        .setName('prize')
        .setDescription('Prize name')
        .setRequired(true)
    )
    .addIntegerOption(o =>
      o
        .setName('minutes')
        .setDescription('Duration in minutes')
        .setRequired(true)
    )
].map(cmd => cmd.toJSON());

client.once('ready', async () => {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationCommands(process.env.CLIENT_ID),
    { body: commands }
  );
  console.log(`Logged in as ${client.user.tag}`);
});

/* ================= COMMAND HANDLER ================= */
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (!allowed(interaction.member)) {
    await interaction.deferReply({ ephemeral: true });
    return;
  }

  if (interaction.commandName === 'rules') {
    interaction.channel.send(
`Rules:
Be respectful
No NSFW
No spam
No ads
No threats`
    );
  }

  if (interaction.commandName === 'invitereward') {
    interaction.channel.send(
`Anyone who you invite gets 10 robux.

Join group:
https://www.roblox.com/share/g/46230128`
    );
  }

  if (interaction.commandName === 'ban') {
    const user = interaction.options.getUser('user');
    const member = await interaction.guild.members.fetch(user.id);
    await warn(member, 'Manual ban command');
  }

  if (interaction.commandName === 'unban') {
    await interaction.guild.members.unban(
      interaction.options.getUser('user').id
    );
  }

  if (interaction.commandName === 'revoke') {
    await pool.query(
      `UPDATE warnings SET count = GREATEST(count - $1, 0) WHERE user_id = $2`,
      [
        interaction.options.getInteger('amount'),
        interaction.options.getUser('user').id
      ]
    );
  }

  if (interaction.commandName === 'nuke') {
    const c = interaction.channel;
    const clone = await c.clone();
    await c.delete();
    clone.setPosition(c.position);
  }

  if (interaction.commandName === 'giveaway') {
    const prize = interaction.options.getString('prize');
    const minutes = interaction.options.getInteger('minutes');

    const msg = await interaction.channel.send(
      `🎉 Giveaway: **${prize}**
React with 🎉 to enter!
Ends in ${minutes} minutes`
    );

    await msg.react('🎉');

    await pool.query(
      `INSERT INTO giveaways VALUES($1,$2,$3,$4)`,
      [msg.id, msg.channel.id, Date.now() + minutes * 60000, prize]
    );
  }

  await interaction.deferReply({ ephemeral: true });
});

/* ================= GIVEAWAY CHECK ================= */
setInterval(async () => {
  const r = await pool.query(
    `SELECT * FROM giveaways WHERE end_time <= $1`,
    [Date.now()]
  );

  for (const g of r.rows) {
    const channel = await client.channels.fetch(g.channel_id);
    const message = await channel.messages.fetch(g.message_id);
    const users = (
      await message.reactions.cache.get('🎉').users.fetch()
    ).filter(u => !u.bot);

    if (users.size > 0) {
      const winner = users.random();
      channel.send(`🎉 Winner: ${winner} | Prize: **${g.prize}**`);
    }

    await pool.query(`DELETE FROM giveaways WHERE message_id = $1`, [
      g.message_id
    ]);
  }
}, 15000);

/* ================= WEBSITE ================= */
app.get('/', (_, res) => {
  res.sendFile(__dirname + '/index.html');
});

app.post('/apply', async (req, res) => {
  const { username, userid, reason } = req.body;

  await pool.query(
    `INSERT INTO mod_apps(username, user_id, reason)
     VALUES($1,$2,$3)`,
    [username, userid, reason]
  );

  res.send('Application submitted.');
});

/* ================= START ================= */
client.login(process.env.DISCORD_TOKEN);
app.listen(process.env.PORT || 3000);
