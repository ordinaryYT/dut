const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  ChannelType,
  SlashCommandBuilder,
  Routes,
  REST
} = require('discord.js');

const express = require('express');
const fetch = (...a)=>import('node-fetch').then(({default:f})=>f(...a));
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

/* ================= DB ================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async()=>{
  await pool.query(`
    CREATE TABLE IF NOT EXISTS warnings(user_id TEXT PRIMARY KEY,count INT DEFAULT 0);
    CREATE TABLE IF NOT EXISTS giveaways(message_id TEXT PRIMARY KEY,channel_id TEXT,end_time BIGINT,prize TEXT);
  `);
})();

/* ================= DISCORD ================= */
const client = new Client({
  intents:[
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

/* ================= WEBSITE ================= */
app.get('/',(_,res)=>res.sendFile(__dirname+'/index.html'));

app.get('/clips',(req,res)=>{
  res.json({
    clips:(process.env.TIKTOK_CLIPS||'').split(',').filter(Boolean),
    gifters:(process.env.GIFTER_CLIPS||'').split(',').filter(Boolean)
  });
});

/* ================= DISCORD OAUTH ================= */
app.get('/auth/discord',(req,res)=>{
  res.redirect(
    `https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&response_type=code&scope=identify`
  );
});

app.get('/auth/callback', async (req,res)=>{
  if(!req.query.code) return res.send('No code');

  const tokenRes = await fetch('https://discord.com/api/oauth2/token',{
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({
      client_id:process.env.CLIENT_ID,
      client_secret:process.env.CLIENT_SECRET,
      grant_type:'authorization_code',
      code:req.query.code,
      redirect_uri:process.env.REDIRECT_URI
    })
  }).then(r=>r.json());

  const user = await fetch('https://discord.com/api/users/@me',{
    headers:{Authorization:`Bearer ${tokenRes.access_token}`}
  }).then(r=>r.json());

  const channel = await client.channels.fetch(process.env.STAFF_APPS_CHANNEL_ID);
  channel.send(`📋 **Staff Application**\n${user.username} (${user.id})`);

  res.send('Application submitted. You can close this.');
});

/* ================= WARNINGS ================= */
async function warn(member,reason){
  const r=await pool.query(`
    INSERT INTO warnings(user_id,count)
    VALUES($1,1)
    ON CONFLICT(user_id) DO UPDATE SET count=warnings.count+1
    RETURNING count`,[member.id]);

  if(r.rows[0].count>=3)
    await member.timeout(60*60*1000);
}

async function revoke(member){
  await pool.query(`UPDATE warnings SET count=GREATEST(count-1,0) WHERE user_id=$1`,[member.id]);
}

/* ================= SLASH COMMANDS ================= */
client.once('ready', async ()=>{
  const cmds=[
    new SlashCommandBuilder()
      .setName('giveaway')
      .setDescription('Start giveaway')
      .addStringOption(o=>o.setName('prize').setRequired(true))
      .addIntegerOption(o=>o.setName('minutes').setRequired(true)),
    new SlashCommandBuilder()
      .setName('revoke')
      .setDescription('Revoke warning')
      .addUserOption(o=>o.setName('user').setRequired(true))
  ];

  const rest=new REST({version:'10'}).setToken(process.env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationCommands(process.env.CLIENT_ID),
    {body:cmds.map(c=>c.toJSON())}
  );
});

/* ================= INTERACTIONS ================= */
client.on('interactionCreate', async i=>{
  if(!i.isChatInputCommand()) return;

  if(i.commandName==='giveaway'){
    const prize=i.options.getString('prize');
    const min=i.options.getInteger('minutes');
    const msg=await i.channel.send(`🎉 **Giveaway:** ${prize}\nReact 🎉`);
    await msg.react('🎉');
    await pool.query(
      `INSERT INTO giveaways VALUES($1,$2,$3,$4)`,
      [msg.id,i.channel.id,Date.now()+min*60000,prize]
    );
    i.reply({content:'Giveaway started',ephemeral:true});
  }

  if(i.commandName==='revoke'){
    const u=i.options.getUser('user');
    const m=await i.guild.members.fetch(u.id);
    await revoke(m);
    i.reply({content:'Warning revoked',ephemeral:true});
  }
});

/* ================= GIVEAWAY END ================= */
setInterval(async()=>{
  const r=await pool.query(`SELECT * FROM giveaways WHERE end_time<$1`,[Date.now()]);
  for(const g of r.rows){
    const ch=await client.channels.fetch(g.channel_id);
    const msg=await ch.messages.fetch(g.message_id);
    const users=(await msg.reactions.cache.first().users.fetch()).filter(u=>!u.bot);
    ch.send(`🎉 Winner: ${users.random()||'No one'} | ${g.prize}`);
    await pool.query(`DELETE FROM giveaways WHERE message_id=$1`,[g.message_id]);
  }
},10000);

/* ================= START ================= */
client.login(process.env.DISCORD_TOKEN);
app.listen(process.env.PORT||3000);
