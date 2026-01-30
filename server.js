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
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
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
  if (count === 4) await member.roles.add(process.env.WEEK_BAN_ROLE_ID); // 1 week review
  if (count >= 5) {
    await member.roles.add(process.env.WEEK_BAN_ROLE_ID); // perm ban review role
    log?.send(`${member} has reached 5th warning — review for permanent ban`);
  }
}

/* ================= AUTOMOD ================= */
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  // Ping abuse only triggers if the forbidden user is mentioned
  if (message.mentions.users.has(process.env.PING_FORBIDDEN_USER_ID)) {
    await warn(message.member, 'Pinged forbidden user');
    const dmMsg = await ai(`You pinged a forbidden user in ${message.guild.name}. Please follow the rules.`);
    await message.member.send(dmMsg);
  }

  // Optional: simple bad word detection
  const badWords = ['nsfw', 'porn', 'raid', 'ddos', 'dox'];
  if (badWords.some(w => message.content.toLowerCase().includes(w))) {
    await warn(message.member, 'Inappropriate content');
  }

  // ================= TICKET AI RESPONSE =================
  const ticketState = client.ticketState || {};
  const state = ticketState[message.channel.id];

  // Only respond if it's a ticket channel and user sent the message while waiting for AI
  if (state && state.waitingForUser && state.userId === message.author.id) {
    // Lock the channel for user
    await message.channel.setParent(process.env.TICKET_LOCKED_CATEGORY_ID);
    await message.channel.permissionOverwrites.edit(message.author.id, { SendMessages: false });
    state.waitingForUser = false;

    // AI responds
    const aiMsg = await ai(`User says: ${message.content}`);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('continue').setLabel('Continue').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('ping').setLabel('Ping Staff').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
    );

    await message.channel.send({ content: aiMsg, components: [row] });
  }
});

/* ================= TICKET BUTTONS ================= */
client.ticketState = {};

client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  // Create ticket
  if (interaction.customId === 'create_ticket') {
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

    // Greeting message from AI (no buttons)
    const greetMsg = await ai(`Hello ${interaction.user.username}, welcome to your ticket! How can I help you today?`);
    await ticketChannel.send(greetMsg);

    // Set ticket state
    client.ticketState[ticketChannel.id] = {
      waitingForUser: true,
      userId: interaction.user.id
    };

    await interaction.reply({ content: 'Ticket created!', ephemeral: true });
  }

  // Continue button
  if (interaction.customId === 'continue') {
    const channel = interaction.channel;
    const state = client.ticketState[channel.id];
    if (!state) return;
    await channel.setParent(process.env.TICKET_OPEN_CATEGORY_ID);
    await channel.permissionOverwrites.edit(state.userId, { SendMessages: true });
    state.waitingForUser = true;
    await interaction.deferUpdate();
  }

  // Ping staff
  if (interaction.customId === 'ping') {
    interaction.channel.send(`<@&${process.env.STAFF_ROLE_ID}>`);
    await interaction.deferUpdate();
  }

  // Close ticket
  if (interaction.customId === 'close') {
    delete client.ticketState[interaction.channel.id];
    await interaction.channel.delete();
  }
});

/* ================= WELCOME ================= */
client.on('guildMemberAdd', async member => {
  const channel = member.guild.channels.cache.get(process.env.WELCOME_CHANNEL_ID);
  if (!channel) return;
  const msg = await ai(`Welcome ${member.user.username} to Dutz Dungeon community`);
  channel.send(msg);
});

/* ================= SLASH COMMANDS ================= */
const commands = [
  new SlashCommandBuilder().setName('rules').setDescription('Send the server rules'),
  new SlashCommandBuilder().setName('invitereward').setDescription('Send invite reward info'),
  new SlashCommandBuilder().setName('ban')
    .setDescription('Give perm-ban review role')
    .addUserOption(o => o.setName('user').setDescription('User to ban').setRequired(true)),
  new SlashCommandBuilder().setName('unban')
    .setDescription('Remove perm-ban review role')
    .addUserOption(o => o.setName('user').setDescription('User to unban').setRequired(true)),
  new SlashCommandBuilder().setName('revoke')
    .setDescription('Revoke warnings from user')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Number of warnings to remove').setRequired(true)),
  new SlashCommandBuilder().setName('nuke').setDescription('Nuke channel'),
  new SlashCommandBuilder().setName('giveaway')
    .setDescription('Start a giveaway')
    .addStringOption(o => o.setName('prize').setDescription('Prize name').setRequired(true))
    .addIntegerOption(o => o.setName('minutes').setDescription('Duration in minutes').setRequired(true))
].map(c => c.toJSON());

client.once('ready', async () => {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
  console.log(`Logged in as ${client.user.tag}`);
});

/* ================= COMMAND HANDLER ================= */
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (!allowed(interaction.member)) return interaction.deferReply({ ephemeral: true });

  /* RULES */
  if (interaction.commandName === 'rules') {
    interaction.channel.send({
      content: `**Rules**

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

First Warning
No action will be taken.

Second Warning
1 Hour Mute

Third Warning
1 Day Mute

Fourth Warning
1 Week Ban

Fifth Warning
Permanent Ban`
    });
  }

  /* INVITE REWARD */
  if (interaction.commandName === 'invitereward') {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Join Group')
        .setStyle(ButtonStyle.Link)
        .setURL('https://www.roblox.com/share/g/46230128')
    );

    interaction.channel.send({
      content: `Anyone who you invite gets 10 robux for joining this discord. For me to send you robux, you must be in this group for 2 weeks.  
It's up to you if you want to split it between the both of you, for example 5 to you and 5 to your friend, as long as I get proof of you both saying it's ok 🙂.  
I will keep logs of people who have claimed, and invites will get reset after claim so you can't claim twice.`,
      components: [row]
    });
  }

  /* MANUAL BAN */
  if (interaction.commandName === 'ban') {
    const user = interaction.options.getUser('user');
    const member = await interaction.guild.members.fetch(user.id);

    await pool.query(
      `INSERT INTO warnings(user_id, count)
       VALUES($1, 5)
       ON CONFLICT (user_id) DO UPDATE SET count = 5`,
      [member.id]
    );

    await member.roles.add(process.env.WEEK_BAN_ROLE_ID);

    const log = interaction.guild.channels.cache.get(process.env.STAFF_LOG_CHANNEL_ID);
    log?.send(`${member} has reached 5th warning — review for permanent ban`);

    await interaction.reply({ content: `✅ ${member} has been given the perm-ban review role.`, ephemeral: true });
  }

  /* UNBAN (remove perm-ban role) */
  if (interaction.commandName === 'unban') {
    const user = interaction.options.getUser('user');
    const member = await interaction.guild.members.fetch(user.id);
    await member.roles.remove(process.env.WEEK_BAN_ROLE_ID);
    await interaction.reply({ content: `✅ ${member}'s perm-ban review role removed.`, ephemeral: true });
  }

  /* REVOKE WARNINGS */
  if (interaction.commandName === 'revoke') {
    await pool.query(
      `UPDATE warnings SET count = GREATEST(count - $1, 0) WHERE user_id=$2`,
      [interaction.options.getInteger('amount'), interaction.options.getUser('user').id]
    );
  }

  /* NUKE */
  if (interaction.commandName === 'nuke') {
    const c = interaction.channel;
    const clone = await c.clone();
    await c.delete();
    clone.setPosition(c.position);
  }

  /* GIVEAWAY */
  if (interaction.commandName === 'giveaway') {
    const prize = interaction.options.getString('prize');
    const minutes = interaction.options.getInteger('minutes');
    const msg = await interaction.channel.send(`🎉 Giveaway: **${prize}**
React with 🎉 to enter!
Ends in ${minutes} minutes`);
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
  const r = await pool.query(`SELECT * FROM giveaways WHERE end_time <= $1`, [Date.now()]);
  for (const g of r.rows) {
    const ch = await client.channels.fetch(g.channel_id);
    const msg = await ch.messages.fetch(g.message_id);
    const users = (await msg.reactions.cache.get('🎉')?.users.fetch())?.filter(u => !u.bot);
    if (users?.size > 0) {
      const winner = users.random();
      ch.send(`🎉 Winner: ${winner} | Prize: **${g.prize}**`);
    }
    await pool.query(`DELETE FROM giveaways WHERE message_id=$1`, [g.message_id]);
  }
}, 15000);

/* ================= WEBSITE ================= */
app.get('/', (_, res) => res.sendFile(__dirname + '/index.html'));
app.post('/apply', async (req, res) => {
  const { username, userid, reason } = req.body;
  await pool.query(
    `INSERT INTO mod_apps(username,user_id,reason) VALUES($1,$2,$3)`,
    [username, userid, reason]
  );
  res.send('Application submitted.');
});

/* ================= START ================= */
client.login(process.env.DISCORD_TOKEN);
app.listen(process.env.PORT || 3000);
