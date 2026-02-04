const { Client, GatewayIntentBits, PermissionsBitField, ChannelType } = require('discord.js');
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

/* ===== DB ===== */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async()=>{
  await pool.query(`
    CREATE TABLE IF NOT EXISTS warnings(user_id TEXT PRIMARY KEY, count INT);
    CREATE TABLE IF NOT EXISTS giveaways(message_id TEXT PRIMARY KEY, channel_id TEXT, end_time BIGINT, prize TEXT);
  `);
})();

/* ===== DISCORD ===== */
const client = new Client({
  intents:[
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

/* ===== WEBSITE ===== */
app.get('/',(_,res)=>res.sendFile(__dirname+'/index.html'));

app.get('/clips',(req,res)=>{
  res.json({
    clips:(process.env.TIKTOK_CLIPS||'').split(',').filter(Boolean),
    gifters:(process.env.GIFTER_CLIPS||'').split(',').filter(Boolean)
  });
});

/* ===== DISCORD OAUTH (REAL ROUTE) ===== */
app.get('/auth/discord',(req,res)=>{
  res.redirect(
    `https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&response_type=code&scope=identify`
  );
});

/* ===== WARN SYSTEM ===== */
async function warn(member,reason){
  const r=await pool.query(`
    INSERT INTO warnings(user_id,count)
    VALUES($1,1)
    ON CONFLICT(user_id) DO UPDATE SET count=warnings.count+1
    RETURNING count`,[member.id]);

  const c=r.rows[0].count;
  await member.send(`⚠ Warning ${c}: ${reason}`);
  if(c>=3) await member.timeout(60*60*1000);
}

async function revoke(member){
  await pool.query(`UPDATE warnings SET count=GREATEST(count-1,0) WHERE user_id=$1`,[member.id]);
}

/* ===== AUTOMOD ===== */
client.on('messageCreate',async m=>{
  if(m.author.bot) return;
  if(['raid','ddos','nsfw'].some(w=>m.content.toLowerCase().includes(w))){
    await warn(m.member,'Bad language');
    await m.delete().catch(()=>{});
  }
});

/* ===== GIVEAWAY END LOOP ===== */
setInterval(async()=>{
  const now=Date.now();
  const r=await pool.query(`SELECT * FROM giveaways WHERE end_time<$1`,[now]);
  for(const g of r.rows){
    const ch=await client.channels.fetch(g.channel_id).catch(()=>null);
    if(!ch) continue;
    const msg=await ch.messages.fetch(g.message_id).catch(()=>null);
    if(!msg) continue;
    const users=(await msg.reactions.cache.first()?.users.fetch())?.filter(u=>!u.bot);
    const win=users?.random();
    ch.send(`🎉 Winner: ${win||'No one'} | ${g.prize}`);
    await pool.query(`DELETE FROM giveaways WHERE message_id=$1`,[g.message_id]);
  }
},10000);

/* ===== READY ===== */
client.login(process.env.DISCORD_TOKEN);
app.listen(process.env.PORT||3000);
