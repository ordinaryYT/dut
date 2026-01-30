const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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

  // Ping abuse
  if (message.mentions.users.has(process.env.PING_FORBIDDEN_USER_ID)) {
    await warn(message.member, 'Pinged forbidden user');
    const dmMsg = await ai(`You pinged a forbidden user in ${message.guild.name}. Please follow the rules.`);
    await message.member.send(dmMsg);
  }

  // Bad words
  const badWords = ['nsfw', 'porn', 'raid', 'ddos', 'dox'];
  if (badWords.some(w => message.content.toLowerCase().includes(w))) {
    await warn(message.member, 'Inappropriate content');
  }

  // ================= TICKET AI RESPONSE =================
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

  // ================= STICKIED MESSAGES =================
  // Channel 1
  if ([process.env.STICKY_CHANNEL1_ID, process.env.STICKY_CHANNEL2_ID].includes(message.channel.id)) {
    const stickMsg = "__**Stickied Message:**__\n\n# Info\nThis channel is only for sending your brainrots to flex it and see what people think.\n\n**Absolutely no discussions here, use appropriate channels for chatting, suggestions, and so forth.** ⚠️ You will receive <@&1466114901020519> for side chatting.__**Stickied Message:**__";
    const messages = await message.channel.messages.fetch({ limit: 10 });
    messages.filter(m => m.author.id === client.user.id && m.content.includes('Stickied Message')).forEach(m => m.delete());
    await message.channel.send(stickMsg);
  }

  // Channel 2 (Fortnite code)
  if (message.channel.id === process.env.STICKY_CHANNEL3_ID) {
    const stickMsg = "__**Stickied Message:**__\n\n# Info\n⚠️ Use code thebigdutz in the Fortnite item shop.";
    const messages = await message.channel.messages.fetch({ limit: 10 });
    messages.filter(m => m.author.id === client.user.id && m.content.includes('Stickied Message')).forEach(m => m.delete());
    await message.channel.send(stickMsg);
  }
});

/* ================= TICKET BUTTONS ================= */
client.ticketState = {};

client.on('interactionCreate', async interaction => {
  try {
    if (!interaction.isButton() && !interaction.isChatInputCommand()) return;

    // Button: Create Ticket
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

      const greetMsg = await ai(`Hello ${interaction.user.username}, welcome to your ticket! How can I help you today?`);
      await ticketChannel.send(greetMsg);

      client.ticketState[ticketChannel.id] = {
        waitingForUser: true,
        userId: interaction.user.id
      };

      await interaction.deferReply({ flags: 64 });
      await interaction.followUp({ content: 'Ticket created!', flags: 64 });
    }

    // Ticket Buttons
    if (interaction.isButton()) {
      const channel = interaction.channel;
      const state = client.ticketState[channel.id];
      if (!state) return;

      if (interaction.customId === 'continue') {
        await channel.setParent(process.env.TICKET_OPEN_CATEGORY_ID);
        await channel.permissionOverwrites.edit(state.userId, { SendMessages: true });
        state.waitingForUser = true;
        await interaction.deferUpdate();
      }
      if (interaction.customId === 'ping') {
        await channel.send(`<@&${process.env.STAFF_ROLE_ID}>`);
        await interaction.deferUpdate();
      }
      if (interaction.customId === 'close') {
        delete client.ticketState[channel.id];
        await channel.delete();
      }
    }

    // ================= CHAT INPUT COMMANDS =================
    if (interaction.isChatInputCommand()) {
      if (!allowed(interaction.member)) {
        await interaction.deferReply({ flags: 64 });
        return await interaction.followUp({ content: 'You are not allowed to use this command.', flags: 64 });
      }

      const cmd = interaction.commandName;

      // Rules
      if (cmd === 'rules') {
        await interaction.deferReply({ flags: 64 });
        await interaction.followUp({ content: `**Rules**\n\nBe respectful...\nFifth Warning\nPermanent Ban`, flags: 64 });
      }

      // Invite reward
      if (cmd === 'invitereward') {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel('Join Group').setStyle(ButtonStyle.Link).setURL('https://www.roblox.com/share/g/46230128')
        );
        await interaction.deferReply({ flags: 64 });
        await interaction.followUp({ content: `Anyone who you invite gets 10 robux...`, components: [row], flags: 64 });
      }

      // Ban
      if (cmd === 'ban') {
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

        await interaction.deferReply({ flags: 64 });
        await interaction.followUp({ content: `✅ ${member} has been given the perm-ban review role.`, flags: 64 });
      }

      // Unban (remove role)
      if (cmd === 'unban') {
        const user = interaction.options.getUser('user');
        const member = await interaction.guild.members.fetch(user.id);
        await member.roles.remove(process.env.WEEK_BAN_ROLE_ID);
        await interaction.deferReply({ flags: 64 });
        await interaction.followUp({ content: `✅ ${member}'s perm-ban review role removed.`, flags: 64 });
      }

      // Other commands follow same pattern (revoke, nuke, giveaway)
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
