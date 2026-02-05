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
    if (!r.ok) return 'AI service unavailable.';
    const d = await r.json();
    return d.choices?.[0]?.message?.content || 'Hello!';
  } catch (err) {
    console.error('AI error:', err);
    return 'AI is currently offline.';
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
  if (!member) return;
  const r = await pool.query(
    `INSERT INTO warnings(user_id, count)
     VALUES($1, 1)
     ON CONFLICT (user_id)
     DO UPDATE SET count = warnings.count + 1
     RETURNING count`,
    [member.id]
  );
  const count = r.rows[0].count;

  await member.send(`Rule broken: ${rule}`).catch(() => {});
  const log = member.guild.channels.cache.get(process.env.STAFF_LOG_CHANNEL_ID);
  log?.send(`${member} | ${rule} | Warning ${count}`);

  if (count === 2) await member.timeout(60 * 60 * 1000).catch(() => {});
  if (count === 3) await member.timeout(24 * 60 * 60 * 1000).catch(() => {});
  if (count === 4) await member.roles.add(process.env.WEEK_BAN_ROLE_ID).catch(() => {});
  if (count >= 5) {
    await member.roles.add(process.env.WEEK_BAN_ROLE_ID).catch(() => {});
    log?.send(`${member} has reached 5 warnings — review for permanent ban`);
  }
}

/* ================= AUTO-MOD + STICKY MESSAGES ================= */
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  // Ping abuse
  if (message.mentions.users.has(process.env.PING_FORBIDDEN_USER_ID)) {
    await warn(message.member, 'Pinged forbidden user');
    const dm = await ai(`You pinged a forbidden user in ${message.guild.name}. Please follow the rules.`);
    await message.member.send(dm).catch(() => {});
  }

  // Bad words
  const badWords = ['nsfw', 'porn', 'raid', 'ddos', 'dox'];
  if (badWords.some(w => message.content.toLowerCase().includes(w))) {
    await warn(message.member, 'Inappropriate content');
  }

  // Sticky messages
  if ([process.env.STICKY_CHANNEL1_ID, process.env.STICKY_CHANNEL2_ID].includes(message.channel.id)) {
    const stickMsg = `__**Stickied Message:**__\n\n# Info\n\n**Absolutely no discussions here, use appropriate channels.**\n⚠️ Side chatting = <@&1466114901020519>`;
    const msgs = await message.channel.messages.fetch({ limit: 10 });
    msgs.filter(m => m.author.id === client.user.id && m.content.includes('Stickied Message'))
      .forEach(m => m.delete().catch(() => {}));
    await message.channel.send(stickMsg).catch(() => {});
  }

  if (message.channel.id === process.env.STICKY_CHANNEL3_ID) {
    const stickMsg = `__**Stickied Message:**__\n\n# Info\n\n⚠️ Use code **thebigdutz** in the Fortnite item shop.`;
    const msgs = await message.channel.messages.fetch({ limit: 10 });
    msgs.filter(m => m.author.id === client.user.id && m.content.includes('Stickied Message'))
      .forEach(m => m.delete().catch(() => {}));
    await message.channel.send(stickMsg).catch(() => {});
  }
});

/* ================= TICKET SYSTEM ================= */
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton() && !interaction.isChatInputCommand()) return;

  try {
    // Create ticket
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

      client.ticketState[channel.id] = {
        waitingForUser: true,
        userId: interaction.user.id
      };

      const greet = await ai(`Hello ${interaction.user.username}, welcome to your ticket! How can I help?`);
      await channel.send(greet);
      await interaction.reply({ content: 'Ticket created!', ephemeral: true });
    }

    // Ticket control buttons
    if (interaction.isButton()) {
      const channel = interaction.channel;
      const state = client.ticketState[channel?.id];
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

    // Slash commands
    if (interaction.isChatInputCommand()) {
      if (!allowed(interaction.member)) {
        return interaction.reply({ content: 'You are not staff.', ephemeral: true });
      }

      const cmd = interaction.commandName;

      if (cmd === 'rules') {
        await interaction.reply({
          content: '**Server Rules**\n\nBe respectful...\n\n5th Warning → Permanent Ban',
          ephemeral: true
        });
      }

      if (cmd === 'invitereward') {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel('Join Group')
            .setStyle(ButtonStyle.Link)
            .setURL('https://www.roblox.com/share/g/46230128')
        );
        await interaction.reply({
          content: 'Anyone you invite gets 10 robux...',
          components: [row],
          ephemeral: true
        });
      }

      if (cmd === 'ban') {
        const user = interaction.options.getUser('user');
        if (!user) return interaction.reply({ content: 'User required', ephemeral: true });

        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) return interaction.reply({ content: 'User not in server', ephemeral: true });

        await pool.query(
          `INSERT INTO warnings(user_id, count) VALUES($1, 5)
           ON CONFLICT (user_id) DO UPDATE SET count = 5`,
          [member.id]
        );

        await member.roles.add(process.env.WEEK_BAN_ROLE_ID).catch(() => {});
        const log = interaction.guild.channels.cache.get(process.env.STAFF_LOG_CHANNEL_ID);
        log?.send(`${member} reached 5 warnings — review for perm ban`);

        await interaction.reply({ content: `✅ ${member} flagged for permanent ban review.`, ephemeral: true });
      }

      if (cmd === 'unban') {
        const user = interaction.options.getUser('user');
        if (!user) return interaction.reply({ content: 'User required', ephemeral: true });

        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) return interaction.reply({ content: 'User not in server', ephemeral: true });

        await member.roles.remove(process.env.WEEK_BAN_ROLE_ID).catch(() => {});
        await interaction.reply({ content: `✅ Removed ban review role from ${member}.`, ephemeral: true });
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Something went wrong.', ephemeral: true }).catch(() => {});
    }
  }
});

/* ================= WELCOME ================= */
client.on('guildMemberAdd', async member => {
  const channel = member.guild.channels.cache.get(process.env.WELCOME_CHANNEL_ID);
  if (!channel) return;
  const msg = await ai(`Welcome ${member.user.username} to Dutz Dungeon!`);
  channel.send(msg).catch(() => {});
});

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
const sessions = new Map();

app.get('/auth/discord', (req, res) => {
  const redirect = `https://discord.com/oauth2/authorize?` +
    `client_id=${process.env.CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}` +
    `&response_type=code&scope=identify`;
  res.redirect(redirect);
});

app.get('/auth/callback', async (req, res) => {
  try {
    if (!req.query.code) {
      console.log('No code in callback');
      return res.status(400).send('No authorization code received');
    }

    console.log('Callback hit | code:', req.query.code);
    console.log('Using redirect_uri:', process.env.REDIRECT_URI);

    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: req.query.code,
        redirect_uri: process.env.REDIRECT_URI
      })
    });

    console.log('Token response status:', tokenRes.status);

    if (!tokenRes.ok) {
      const errorText = await tokenRes.text();
      console.error('Discord OAuth error:', errorText);
      return res.status(500).send(`Discord error: ${tokenRes.status} - ${errorText.slice(0, 300)}`);
    }

    const token = await tokenRes.json();

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });

    const user = await userRes.json();

    sessions.set(user.id, user);
    res.redirect(`/?uid=${user.id}`);
  } catch (err) {
    console.error('Callback crash:', err);
    res.status(500).send('OAuth callback failed – check logs');
  }
});

/* ================= STAFF APPLICATION ================= */
app.post('/apply', async (req, res) => {
  const { uid, age, timezone, experience, reason } = req.body;
  const user = sessions.get(uid);
  if (!user) return res.sendStatus(401);

  const r = await pool.query(
    `INSERT INTO mod_apps(username, user_id, age, timezone, experience, reason)
     VALUES($1, $2, $3, $4, $5, $6) RETURNING id`,
    [user.username, user.id, age, timezone, experience, reason]
  );

  const embed = new EmbedBuilder()
    .setTitle('📋 Staff Application')
    .setColor(0x5865F2)
    .addFields(
      { name: 'User', value: `${user.username} (${user.id})` },
      { name: 'Age', value: age || 'Not provided', inline: true },
      { name: 'Timezone', value: timezone || 'Not provided', inline: true },
      { name: 'Experience', value: experience || 'None' },
      { name: 'Reason', value: reason || 'No reason given' },
      { name: 'Status', value: '⏳ Pending' }
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`approve_${r.rows[0].id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`deny_${r.rows[0].id}`).setLabel('Deny').setStyle(ButtonStyle.Danger)
  );

  const channel = await client.channels.fetch(process.env.STAFF_APPS_CHANNEL_ID).catch(() => null);
  if (channel) await channel.send({ embeds: [embed], components: [row] });

  res.sendStatus(200);
});

/* ================= APPROVE/DENY BUTTONS ================= */
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('approve_') && !interaction.customId.startsWith('deny_')) return;

  const [action, id] = interaction.customId.split('_');
  const { rows } = await pool.query(`SELECT * FROM mod_apps WHERE id = $1`, [id]);
  if (!rows.length) return;

  const app = rows[0];
  const embed = EmbedBuilder.from(interaction.message.embeds[0]);
  embed.spliceFields(5, 1, { name: 'Status', value: action === 'approve' ? '✅ Approved' : '❌ Denied' });

  if (action === 'approve') {
    const guild = await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
    if (guild) {
      const member = await guild.members.fetch(app.user_id).catch(() => null);
      if (member) await member.roles.add(process.env.STAFF_ROLE_ID).catch(() => {});
    }
  }

  await pool.query(`UPDATE mod_apps SET status = $1 WHERE id = $2`, [action === 'approve' ? 'Approved' : 'Denied', id]);

  await interaction.update({ embeds: [embed], components: [] });
});

/* ================= REGISTER SLASH COMMANDS ================= */
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder().setName('rules').setDescription('View server rules'),
    new SlashCommandBuilder().setName('invitereward').setDescription('Show invite reward info'),
    new SlashCommandBuilder()
      .setName('ban')
      .setDescription('Mark user for perm ban review (sets 5 warnings)')
      .addUserOption(opt => opt.setName('user').setDescription('The user').setRequired(true)),
    new SlashCommandBuilder()
      .setName('unban')
      .setDescription('Remove perm ban review role')
      .addUserOption(opt => opt.setName('user').setDescription('The user').setRequired(true))
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID), { body: commands });
    console.log('Slash commands registered successfully');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
});

/* ================= START ================= */
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('Discord login failed:', err);
});

app.listen(process.env.PORT || 3000, '0.0.0.0', () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});
