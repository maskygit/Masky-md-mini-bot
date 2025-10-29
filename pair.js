const axios = require('axios');
const ytSearch = require('yt-search');
const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const FormData = require('form-data');
const { Octokit } = require('@octokit/rest');
const moment = require('moment-timezone');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser
} = require('baileys');
const  getImage  = require('./masky.js');
// Default config structure
const defaultConfig = {
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'true',
    AUTO_LIKE_EMOJI: ['💥', '👍', '😍', '💗', '🎈', '🎉', '🥳', '😎', '🚀', '🔥'],
    PREFIX: '.',
    MAX_RETRIES: 3,
    ADMIN_LIST_PATH: './admin.json',
    IMAGE_PATH: getImage(),
    OWNER_NUMBER: '',
    BOT_MODE: true
};
console.log(getImage())
const config = require('./config.json');
// GitHub Octokit initialization
let octokit;
if (process.env.GITHUB_TOKEN) {
    octokit = new Octokit({
        auth: process.env.GITHUB_TOKEN
    });
}
const owner = process.env.GITHUB_REPO_OWNER || "";
const repo = process.env.GITHUB_REPO_NAME || "";

// Memory optimization: Use weak references for sockets
const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const NUMBER_LIST_PATH = './numbers.json';

// Memory optimization: Cache frequently used data
let adminCache = null;
let adminCacheTime = 0;
const ADMIN_CACHE_TTL = 300000; // 5 minutes

// Initialize directories
if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}
// 💠 Masky Channel Context (Global)
let maskyContext = {
  forwardingScore: 1,
  isForwarded: true,
  forwardedNewsletterMessageInfo: {
    newsletterJid: '120363420740680510@newsletter',
    newsletterName: '𝐌𝐚𝐬𝐤𝐲_𝐌𝐃',
    serverMessageId: -1
  }
};
const maskyLink = 'https://masky-md-mini-bot.onrender.com';

// Memory optimization: Improved admin loading with caching
function loadAdmins() {
    try {
        const now = Date.now();
        if (adminCache && now - adminCacheTime < ADMIN_CACHE_TTL) {
            return adminCache;
        }
        
        if (fs.existsSync(defaultConfig.ADMIN_LIST_PATH)) {
            adminCache = JSON.parse(fs.readFileSync(defaultConfig.ADMIN_LIST_PATH, 'utf8'));
            adminCacheTime = now;
            return adminCache;
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}

// Memory optimization: Use template literals efficiently
function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function getSriLankaTimestamp() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

// Memory optimization: Clean up unused variables and optimize loops
async function cleanDuplicateFiles(number) {
    try {
        if (!octokit) return;
        
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file => 
            file.name.startsWith(`creds_${sanitizedNumber}_`) && file.name.endsWith('.json')
        ).sort((a, b) => {
            const timeA = parseInt(a.name.match(/creds_\d+_(\d+)\.json/)?.[1] || 0);
            const timeB = parseInt(b.name.match(/creds_\d+_(\d+)\.json/)?.[1] || 0);
            return timeB - timeA;
        });

        // Keep only the first (newest) file, delete the rest
        if (sessionFiles.length > 1) {
            for (let i = 1; i < sessionFiles.length; i++) {
                await octokit.repos.deleteFile({
                    owner,
                    repo,
                    path: `session/${sessionFiles[i].name}`,
                    message: `Delete duplicate session file for ${sanitizedNumber}`,
                    sha: sessionFiles[i].sha
                });
                console.log(`Deleted duplicate session file: ${sessionFiles[i].name}`);
            }
        }
    } catch (error) {
        console.error(`Failed to clean duplicate files for ${number}:`, error);
    }
}

// Memory optimization: Reduce memory usage in message sending
async function sendAdminConnectMessage(socket, number) {
    const admins = loadAdmins();
    const caption = formatMessage(
        'Bot Connected',
        `📞 Number: ${number}\nBots: Connected`,
        '*ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ* you can join our Channel below \nhttps://whatsapp.com/channel/0029Vb6jJTU3AzNT67eSIG2L'
        
    );

    // Send messages sequentially to avoid memory spikes
    for (const admin of admins) {
        try {
            await socket.sendMessage(
                `${admin}@s.whatsapp.net`,
                {
                    image: { url: defaultConfig.IMAGE_PATH },
                    caption,
                    contextInfo: maskyContext
                }
            );
            // Add a small delay to prevent rate limiting and memory buildup
            await delay(100);
        } catch (error) {
            console.error(`Failed to send connect message to admin ${admin}:`, error);
        }
    }
}

// Memory optimization: Cache the about status to avoid repeated updates
let lastAboutUpdate = 0;
const ABOUT_UPDATE_INTERVAL = 3600000; // 1 hour

async function updateAboutStatus(socket) {
    const now = Date.now();
    if (now - lastAboutUpdate < ABOUT_UPDATE_INTERVAL) {
        return; // Skip update if it was done recently
    }
    
    const aboutStatus = '𝐌𝐀𝐒𝐊𝐘 𝐌𝐃 🚀-𝐌𝐢𝐧𝐢 𝐁𝐨𝐭 𝐢𝐬 𝐀𝐜𝐭𝐢𝐯𝐞 🚀';
    try {
        await socket.updateProfileStatus(aboutStatus);
        lastAboutUpdate = now;
        console.log(`Updated About status to: ${aboutStatus}`);
    } catch (error) {
        console.error('Failed to update About status:', error);
    }
}

// Memory optimization: Limit story updates
let lastStoryUpdate = 0;
const STORY_UPDATE_INTERVAL = 86400000; // 24 hours

async function updateStoryStatus(socket) {
    const now = Date.now();
    if (now - lastStoryUpdate < STORY_UPDATE_INTERVAL) {
        return; // Skip update if it was done recently
    }
    
    const statusMessage = `Connected! 🚀\nConnected at: ${getSriLankaTimestamp()}`;
    try {
        await socket.sendMessage('status@broadcast', { text: statusMessage });
        lastStoryUpdate = now;
        console.log(`Posted story status: ${statusMessage}`);
    } catch (error) {
        console.error('Failed to post story status:', error);
    }
}

// Memory optimization: Throttle status handlers
function setupStatusHandlers(socket, userConfig) {
    let lastStatusInteraction = 0;
    const STATUS_INTERACTION_COOLDOWN = 10000; // 10 seconds
    
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant) return;
        
        // Throttle status interactions to prevent spam
        const now = Date.now();
        if (now - lastStatusInteraction < STATUS_INTERACTION_COOLDOWN) {
            return;
        }

        try {
            if (userConfig.AUTO_RECORDING === 'true' && message.key.remoteJid) {
                await socket.sendPresenceUpdate("recording", message.key.remoteJid);
            }

            if (userConfig.AUTO_VIEW_STATUS === 'true') {
                let retries = parseInt(userConfig.MAX_RETRIES) || 3;
                while (retries > 0) {
                    try {
                        await socket.readMessages([message.key]);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to read status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (parseInt(userConfig.MAX_RETRIES) || 3 - retries));
                    }
                }
            }
            if (userConfig.AUTO_LIKE_STATUS === 'true') {
                const emojis = Array.isArray(userConfig.AUTO_LIKE_EMOJI) ? 
                    userConfig.AUTO_LIKE_EMOJI : defaultConfig.AUTO_LIKE_EMOJI;
                const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                let retries = parseInt(userConfig.MAX_RETRIES) || 3;
                while (retries > 0) {
                    try {
                        await socket.sendMessage(
                            message.key.remoteJid,
                            { react: { text: randomEmoji, key: message.key } },
                            { statusJidList: [message.key.participant] }
                        );
                        lastStatusInteraction = now;
                        console.log(`Reacted to status with ${randomEmoji}`);
                        // 📨 Send confirmation message after reacting
if (userConfig.AUTO_VIEW_STATUS === 'true') {
    await socket.sendMessage(message.key.remoteJid, {
        text: `👑 *MASKY MD MINI*\n\n✅ Successfully *VIEWED* 👀 and *LIKED* ❤️ your status!\n\n> _“Consistency builds trust — even bots prove it.”_\n\n🚀 Keep shining! The bot’s always watching over your updates 😎`,
        contextInfo: maskyContext
    });
} else {
    await socket.sendMessage(message.key.remoteJid, {
        text: `👑 *MASKY MD MINI*\n\n❤️ Bot *LIKED* your status!\n\n💡 Want the bot to also *view* your statuses?\n👉 Type *${config.prefix}autostatus on*\n\nTo stop auto-likes or silence reactions, use *${config.prefix}autolike off*\n\n> _“Small gestures make big impacts — even digital ones.”_ 💫`,
        contextInfo: maskyContext
    });
}
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to react to status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (parseInt(userConfig.MAX_RETRIES) || 3 - retries));
                    }
                }
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}

// Memory optimization: Streamline command handlers with rate limiting
function setupCommandHandlers(socket, number, userConfig) {
    const commandCooldowns = new Map();
    const COMMAND_COOLDOWN = 1000; // 1 second per user
    
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        const newsletterJids = ["120363420740680510@newsletter", "120363420806873674@newsletter", "120363404068762193@newsletter"];
  const emojis = ["🫡", "💪"];

  if (msg.key && newsletterJids.includes(msg.key.remoteJid)) {
    try {
      const serverId = msg.newsletterServerId;
      if (serverId) {
      const emoji = emojis[Math.floor(Math.random() * emojis.length)];
        await conn.newsletterReactMessage(msg.key.remoteJid, serverId.toString(), emoji);
      }
    } catch (e) {
    
    }
  }	  
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

        // Extract text from different message types
        let text = '';
        if (msg.message.conversation) {
            text = msg.message.conversation.trim();
        } else if (msg.message.extendedTextMessage?.text) {
            text = msg.message.extendedTextMessage.text.trim();
        } else if (msg.message.buttonsResponseMessage?.selectedButtonId) {
            text = msg.message.buttonsResponseMessage.selectedButtonId.trim();
        } else if (msg.message.imageMessage?.caption) {
            text = msg.message.imageMessage.caption.trim();
        } else if (msg.message.videoMessage?.caption) {
            text = msg.message.videoMessage.caption.trim();
        }

        // Check if it's a command
        const prefix = userConfig.PREFIX || '.';
        if (!text.startsWith(prefix)) return;
        
        // Rate limiting
        const sender = msg.key.remoteJid;
        const now = Date.now();
        if (commandCooldowns.has(sender) && now - commandCooldowns.get(sender) < COMMAND_COOLDOWN) {
            return;
        }
        commandCooldowns.set(sender, now);

        const parts = text.slice(prefix.length).trim().split(/\s+/);
        const command = parts[0].toLowerCase();
        const args = parts.slice(1);

        try {
            switch (command) {
                case 'alive': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);

                   const caption = `
⎯⎯⎯⎯👺 𝙈𝘼𝙎𝙆𝙔 𝙈𝘿 👺⎯⎯⎯⎯
│ 🤖 *ʙᴏᴛ sᴛᴀᴛᴜs:* ᴀᴄᴛɪᴠᴇ ✅
│ ⏰ *ᴜᴘᴛɪᴍᴇ:* ${hours}h ${minutes}m ${seconds}s
│ 🟢 *ᴀᴄᴛɪᴠᴇ sᴇssɪᴏɴs:* ${activeSockets.size}
│ 📱 *ʏᴏᴜʀ ɴᴜᴍʙᴇʀ:* ${number}
│ 
[===[ 💻 𝐒𝐘𝐒𝐓𝐄𝐌 𝐒𝐓𝐀𝐓𝐔𝐒 💻 ]===]
> ⚡ *ᴘᴏᴡᴇʀᴇᴅ ʙʏ 👉 ɪsʀᴀᴇʟ ᴛᴇᴄʜ ᴅᴇᴠ* 👺
`;
                    await socket.sendMessage(sender, {
                        image: { url: userConfig.IMAGE_PATH || defaultConfig.IMAGE_PATH},
                        caption: caption.trim(),
                        contextInfo: maskyContext
                    });
                    break;
                }
                
                case 'help':
                case 'allmenu':
                case 'menu': {
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    const os = require('os');
    const ramUsage = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const totalRam = Math.round(os.totalmem() / 1024 / 1024);

    const menuCaption = `
⫷⫷⫷👺 𝐌𝐀𝐒𝐊𝐘 𝐌𝐃 🚀 • 𝐌𝐄𝐍𝐔 👺⫸⫸⫸
💀 ʜᴇʏ ${number}  •  ᴜᴘᴛɪᴍᴇ: ${hours}h ${minutes}m ${seconds}s  •  ʀᴀᴍ: ${ramUsage}MB/${totalRam}MB

⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺

⚙️ 𝐂𝐨𝐫𝐞
${config.PREFIX}alive
${config.PREFIX}setting
${config.PREFIX}set
${config.PREFIX}config
${config.PREFIX}help
${config.PREFIX}menu
${config.PREFIX}allmenu
${config.PREFIX}ping
${config.PREFIX}uptime
${config.PREFIX}tagall
${config.PREFIX}deleteme

⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺

⚡ 𝐀𝐮𝐭𝐨 𝐅𝐞𝐚𝐭𝐮𝐫𝐞𝐬
${config.PREFIX}autostatus on/off
${config.PREFIX}autolike on/off
${config.PREFIX}autorecord on/off

⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺

🎬 𝐌𝐞𝐝𝐢𝐚 & 𝐃𝐨𝐰𝐧𝐥𝐨𝐚𝐝
${config.PREFIX}fb
${config.PREFIX}facebook <url>
${config.PREFIX}ig
${config.PREFIX}insta
${config.PREFIX}instagram
${config.PREFIX}tiktok
${config.PREFIX}ytmp4
${config.PREFIX}song <query>
${config.PREFIX}ytaudio <url>
${config.PREFIX}removebg
${config.PREFIX}nobg
${config.PREFIX}rmbg

⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺

☪️✝️ 𝐑𝐞𝐥𝐢𝐠𝐢𝐨𝐮𝐬 𝐂𝐨𝐦𝐦𝐚𝐧𝐝𝐬
${config.PREFIX}biblelist
${config.PREFIX}bible <verse>
${config.PREFIX}quranlist
${config.PREFIX}quran <chapter>

⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺

🛠 𝐓𝐨𝐨𝐥𝐬 & 𝐎𝐭𝐡𝐞𝐫
${config.PREFIX}botlink
${config.PREFIX}sc
${config.PREFIX}script
${config.PREFIX}repo
${config.PREFIX}vv
${config.PREFIX}vv2
${config.PREFIX}vvtoyu
${config.PREFIX}vv2

⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺⩺

💡 𝐔𝐬𝐞𝐟𝐮𝐥 𝐂𝐨𝐦𝐦𝐚𝐧𝐝𝐬
${config.PREFIX}idch

⫷⫷⫷👺 𝐈𝐒𝐑𝐀𝐄𝐋 𝐓𝐄𝐂𝐇 𝐃𝐄𝐕 👺⫸⫸⫸
`;

    await socket.sendMessage(sender, {
        image: { url: config.IMAGE_PATH || defaultConfig.IMAGE_PATH },
        caption: menuCaption.trim(),
        contextInfo: maskyContext
    });
    break;
}

                case 'ping': {
                    const start = Date.now();
                    await socket.sendMessage(sender, { text: '🏓 Pong!' });
                    const latency = Date.now() - start;
                    await socket.sendMessage(sender, { 
                       text: `⎯⎯⎯⎯👺 𝐌𝐀𝐒𝐊𝐘 𝐌𝐃 🚀 👺⎯⎯⎯⎯\n⚡ *Latency:* ${latency}ms\n📶 *Connection:* ${latency < 500 ? 'Excellent' : latency < 1000 ? 'Good' : 'Poor'}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴀᴇʟ ᴛᴇᴄʜ ᴅᴇᴠ*\n⎯⎯⎯⎯👺 𝐈𝐒𝐑𝐀𝐄𝐋 𝐓𝐄𝐂𝐇 𝐃𝐄𝐕 👺⎯⎯⎯⎯`,
                        contextInfo: maskyContext
                    });
                    break;
                }
                
                case 'uptime': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);
                    
                    await socket.sendMessage(sender, {
                     text: `⎯⎯⎯⎯👺 𝙈𝘼𝙎𝙆𝙔 𝙈𝘿 👺⎯⎯⎯⎯\n[===[ 💻 𝐒𝐘𝐒𝐓𝐄𝐌 𝐒𝐓𝐀𝐓𝐔𝐒 💻 ]===]\n│ ⏰ *Uptime:* ${hours}h ${minutes}m ${seconds}s\n│ 📊 *Active Sessions:* ${activeSockets.size}\n[==============================]\n│ ⚙️ *Bot:* 𝐌𝐀𝐒𝐊𝐘 𝐌𝐃 🚀-𝐌𝐢𝐧𝐢\n│ 🧑‍💻 *Owner:* 𝐌𝐀𝐒𝐊𝐘 𝐌𝐃 🚀\n╰────────────────────────────╯\n\n> ⚡ *ᴘᴏᴡᴇʀᴇᴅ ʙʏ 👉 ɪsʀᴀᴇʟ ᴛᴇᴄʜ ᴅᴇᴠ* 👺`,
                        contextInfo: maskyContext
                    });
                    break;
                }

                case 'tagall': {
                    if (!msg.key.remoteJid.endsWith('@g.us')) {
                        await socket.sendMessage(sender, { text: '❌ This command can only be used in groups.',
                        contextInfo: maskyContext
                        });
                        return;
                    }
                    const groupMetadata = await socket.groupMetadata(sender);
                    const participants = groupMetadata.participants.map(p => p.id);
                    const tagMessage = `📢 *Tagging all members:*\n\n${participants.map(p => `@${p.split('@')[0]}`).join(' ')}`;
                    
                    await socket.sendMessage(sender, {
                        text: tagMessage,
                        mentions: participants
                    });
                    break;
                }

                case 'fb': {
                    if (args.length === 0) {
                        await socket.sendMessage(sender, { 
                            text: `❌ Please provide a Facebook video URL.\nUsage: ${config.PREFIX}fb <facebook-video-url>\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*` ,
                            contextInfo: maskyContext
                        });
                        return;
                    }
                    
                    const fbUrl = args[0];
                    if (!fbUrl.includes('facebook.com') && !fbUrl.includes('fb.watch')) {
                        await socket.sendMessage(sender, { 
                            text: `❌ Please provide a valid Facebook video URL.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*` ,
                            contextInfo: maskyContext
                        });
                        return;
                    }
                    
                    await socket.sendMessage(sender, { 
                        text: `⏳ Downloading Facebook video, please wait...\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*` ,
                        contextInfo: maskyContext
                    });
                    
                    try {
                        const apiUrl = `https://www.dark-yasiya-api.site/download/fbdl2?url=${encodeURIComponent(fbUrl)}`;
                        const response = await axios.get(apiUrl);

                        if (!response.data || response.data.status !== true) {
                            await socket.sendMessage(sender, { 
                                text: `❌ Unable to fetch the video. Please check the URL and try again.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*` ,
                                contextInfo: maskyContext
                            });
                            return;
                        }

                        // Extract links from the response
                        const sdLink = response.data.result.sdLink;
                        const hdLink = response.data.result.hdLink;
                        const downloadLink = hdLink || sdLink; // Prefer HD if available
                        const quality = hdLink ? "HD" : "SD";
                        
                        if (!downloadLink) {
                            await socket.sendMessage(sender, { 
                                text: `❌ No downloadable video found. The video might be private or restricted.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*` ,
                                contextInfo: maskyContext
                            });
                            return;
                        }
                        
                        // Send the video
                        await socket.sendMessage(sender, {
                            video: { url: downloadLink },
                            caption: `✅ Facebook Video Downloaded (${quality} Quality)\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`,
                            contextInfo: maskyContext
                        });
                        
                    } catch (error) {
                        console.error('Facebook download error:', error);
                        await socket.sendMessage(sender, { 
                            text: `❌ Error downloading video. Please try again later.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*` ,
                            contextInfo: maskyContext
                        });
                    }
                    break;
                }

                case 'song': {
                    if (args.length === 0) {
                        await socket.sendMessage(sender, { 
                            text: `❌ Please provide a song name to search.\nUsage: ${config.PREFIX}song <song name>\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*` ,
                            contextInfo: maskyContext
                        });
                        return;
                    }
                    
                    const query = args.join(' ');
                    await socket.sendMessage(sender, { 
                        text: `🔍 Searching for "${query}"...\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*` ,
                        contextInfo: maskyContext
                    });
                    
                    try {
                        // Search for videos using yt-search
                        const searchResults = await ytSearch(query);
                        
                        if (!searchResults.videos || searchResults.videos.length === 0) {
                            await socket.sendMessage(sender, { 
                                text: `❌ No results found for "${query}"\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*` ,
                                contextInfo: maskyContext
                            });
                            return;
                        }
                        
                        // Get the first result
                        const video = searchResults.videos[0];
                        const videoUrl = video.url;
                        
                        await socket.sendMessage(sender, { 
                            text: `🎵 Found: ${video.title}\n⏱ Duration: ${video.timestamp}\n⬇️ Downloading audio...\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*` ,
                            contextInfo: maskyContext
                        });
                        
                        // Download using the audio API
                        const apiUrl = `https://api.nexoracle.com/downloader/yt-audio2?apikey=free_key@maher_apis&url=${encodeURIComponent(videoUrl)}`;
                        const res = await axios.get(apiUrl);
                        const data = res.data;

                        if (!data?.status || !data.result?.audio) {
                            await socket.sendMessage(sender, { 
                                text: `❌ Failed to download audio!\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`,
                                contextInfo: maskyContext
                            });
                            return;
                        }

                        const { title, audio } = data.result;

                        await socket.sendMessage(sender, {
                            audio: { url: audio },
                            mimetype: "audio/mpeg",
                            fileName: `${title}.mp3`.replace(/[^\w\s.-]/gi, ''),
                            caption: `🎵 ${title}\n\n✅ Downloaded successfully!\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`,
                            contextInfo: maskyContext
                        });
                        
                    } catch (error) {
                        console.error('Song download error:', error);
                        await socket.sendMessage(sender, { 
                            text: `❌ Error downloading song. Please try again later.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*` ,
                            contextInfo: maskyContext
                        });
                    }
                    break;
                }

                case 'ytaudio': {
                    if (args.length === 0) {
                        await socket.sendMessage(sender, { 
                            text: `❌ Please provide a YouTube URL.\nUsage: ${config.PREFIX}ytaudio <youtube-url>\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*` ,
                            contextInfo: maskyContext
                        });
                        return;
                    }
                    
                    const url = args[0];
                    if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
                        await socket.sendMessage(sender, { 
                            text: `❌ Please provide a valid YouTube URL.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*` ,
                            contextInfo: maskyContext
                        });
                        return;
                    }
                    
                    await socket.sendMessage(sender, { 
                        text: `⏳ Downloading YouTube audio, please wait...\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*` ,
                        contextInfo: maskyContext
                    });
                    
                    try {
                        const apiUrl = `https://api.nexoracle.com/downloader/yt-audio2?apikey=free_key@maher_apis&url=${encodeURIComponent(url)}`;
                        const res = await axios.get(apiUrl);
                        const data = res.data;

                        if (!data?.status || !data.result?.audio) {
                            await socket.sendMessage(sender, { 
                                text: `❌ Failed to download audio!\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`,
                                contextInfo: maskyContext
                            });
                            return;
                        }

                        const { title, audio } = data.result;

                        await socket.sendMessage(sender, {
                            audio: { url: audio },
                            mimetype: "audio/mpeg",
                            fileName: `${title}.mp3`.replace(/[^\w\s.-]/gi, ''),
                            caption: `🎵 ${title}\n\n✅ YouTube audio downloaded successfully!\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`
                        });
                        
                    } catch (error) {
                        console.error('YouTube audio download error:', error);
                        await socket.sendMessage(sender, { 
                            text: `❌ Error downloading audio. Please try again later.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`,
                            contextInfo: maskyContext
                        });
                    }
                    break;
                }

                case 'getpp': {
                    if (args.length === 0) {
                        await socket.sendMessage(sender, { 
                            text: `❌ Please provide a phone number.\nUsage: ${config.PREFIX}getpp <number>\nExample: ${config.PREFIX}getpp 923237045919\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*` ,
                            contextInfo: maskyContext
                        });
                        return;
                    }
                    
                    let targetNumber = args[0].replace(/[^0-9]/g, '');
                    
                    // Add country code if not provided
                    if (!targetNumber.startsWith('92') && targetNumber.length === 10) {
                        targetNumber = '92' + targetNumber;
                    }
                    
                    // Ensure it has @s.whatsapp.net
                    const targetJid = targetNumber.includes('@') ? targetNumber : `${targetNumber}@s.whatsapp.net`;
                    
                    await socket.sendMessage(sender, { 
                        text: `🕵️ Stealing profile picture for ${targetNumber}...\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*` ,
                        contextInfo: maskyContext
                    });
                    
                    try {
                        // Get profile picture URL
                        const profilePictureUrl = await socket.profilePictureUrl(targetJid, 'image');
                        
                        if (profilePictureUrl) {
                            await socket.sendMessage(sender, {
                                image: { url: profilePictureUrl },
                                caption: `✅ Successfully stole profile picture!\n📱 Number: ${targetNumber}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`
                            });
                        } else {
                            await socket.sendMessage(sender, { 
                                text: `❌ No profile picture found for ${targetNumber}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*` ,
                                contextInfo: maskyContext
                            });
                        }
                        
                    } catch (error) {
                        console.error('Profile picture steal error:', error);
                        
                        if (error.message.includes('404') || error.message.includes('not found')) {
                            await socket.sendMessage(sender, { 
                                text: `❌ No profile picture found for ${targetNumber}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`,
                                contextInfo: maskyContext
                            });
                        } else {
                            await socket.sendMessage(sender, { 
                                text: `❌ Error stealing profile picture: ${error.message}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*` ,
                                contextInfo: maskyContext
                            });
                        }
                    }
                    break;
                }

                case 'deleteme': {
                    const confirmationMessage = `If y9u wanna delete masky md is simple watvh the video below t9 see ho to delete masky md mini bot`;
                    
                    await socket.sendMessage(sender, {
                        image: { url: config.IMAGE_PATH || defaultConfig.IMAGE_PATH},
                        caption: confirmationMessage + '\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*'
                    });
                    break;
                }
                
                case 'autostatus': {
    const input = args[0]?.toLowerCase();

    if (!input || !['on', 'off'].includes(input)) {
        await socket.sendMessage(sender, {
            text: `⚙️ Usage: *autostatus on* or *autostatus off*`,
            contextInfo: maskyContext
        });
        break;
    }

    if (typeof userConfig.AUTO_VIEW_STATUS === 'undefined') {
        userConfig.AUTO_VIEW_STATUS = 'false';
    }

    if (input === 'on') {
        if (userConfig.AUTO_VIEW_STATUS === 'true') {
            await socket.sendMessage(sender, {
                text: `✅ Auto Status is already *ON!* 👀\n> Bot is already viewing statuses automatically.`,
                contextInfo: maskyContext
            });
        } else {
            userConfig.AUTO_VIEW_STATUS = 'true';
            await socket.sendMessage(sender, {
                text: `✅✔️ Auto Status turned *ON!*\n> Now bot will begin to view statuses 👀`,
                contextInfo: maskyContext
            });
        }
    } else if (input === 'off') {
        if (userConfig.AUTO_VIEW_STATUS === 'false') {
            await socket.sendMessage(sender, {
                text: `❌ Auto Status is already *OFF!* 😴`,
                contextInfo: maskyContext
            });
        } else {
            userConfig.AUTO_VIEW_STATUS = 'false';
            await socket.sendMessage(sender, {
                text: `❌ Auto Status turned *OFF!*\n> Bot will stop viewing statuses.`,
                contextInfo: maskyContext
            });
        }
    }
    break;
}


case 'autolike': {
    const input = args[0]?.toLowerCase();

    if (!input || !['on', 'off'].includes(input)) {
        await socket.sendMessage(sender, {
            text: `⚙️ Usage: *autolike on* or *autolike off*`,
            contextInfo: maskyContext
        });
        break;
    }

    if (typeof userConfig.AUTO_LIKE_STATUS === 'undefined') {
        userConfig.AUTO_LIKE_STATUS = 'false';
    }

    if (input === 'on') {
        if (userConfig.AUTO_LIKE_STATUS === 'true') {
            await socket.sendMessage(sender, {
                text: `👍 Auto Like is already *ON!* ❤️\n> Bot is already liking statuses automatically.`,
                contextInfo: maskyContext
            });
        } else {
            userConfig.AUTO_LIKE_STATUS = 'true';
            await socket.sendMessage(sender, {
                text: `✅✔️ Auto Like turned *ON!*\n> Bot will begin to like statuses ❤️`,
                contextInfo: maskyContext
            });
        }
    } else if (input === 'off') {
        if (userConfig.AUTO_LIKE_STATUS === 'false') {
            await socket.sendMessage(sender, {
                text: `❌ Auto Like is already *OFF!* 😴`,
                contextInfo: maskyContext
            });
        } else {
            userConfig.AUTO_LIKE_STATUS = 'false';
            await socket.sendMessage(sender, {
                text: `❌ Auto Like turned *OFF!*\n> Bot will stop liking statuses.`,
                contextInfo: maskyContext
            });
        }
    }
    break;
}
case 'autorecord': {
    const input = args[0]?.toLowerCase();

    if (!input || !['on', 'off'].includes(input)) {
        await socket.sendMessage(sender, {
            text: `⚙️ Usage: *autorecord on* or *autorecord off*`,
            contextInfo: maskyContext
        });
        break;
    }

    if (typeof userConfig.AUTO_RECORDING === 'undefined') {
        userConfig.AUTO_RECORDING = 'false';
    }

    if (input === 'on') {
        if (userConfig.AUTO_RECORDING === 'true') {
            await socket.sendMessage(sender, {
                text: `🎙️ Auto Recording is already *ON!* 🟢\n> Bot is already simulating voice recording automatically.`,
                contextInfo: maskyContext
            });
        } else {
            userConfig.AUTO_RECORDING = 'true';
            await socket.sendMessage(sender, {
                text: `✅✔️ Auto Recording turned *ON!*\n> Bot will now start auto recording simulation 🎙️`,
                contextInfo: maskyContext
            });
        }
    } else if (input === 'off') {
        if (userConfig.AUTO_RECORDING === 'false') {
            await socket.sendMessage(sender, {
                text: `❌ Auto Recording is already *OFF!* 😴`,
                contextInfo: maskyContext
            });
        } else {
            userConfig.AUTO_RECORDING = 'false';
            await socket.sendMessage(sender, {
                text: `❌ Auto Recording turned *OFF!*\n> Bot will stop simulating voice recording.`,
                contextInfo: maskyContext
            });
        }
    }
    break;
}
case 'vv': {
    try {
        // Check if the user replied to a message
        if (!m.quoted) {
            await socket.sendMessage(sender, {
                text: `📸 Reply to a *view-once* image, video, or file with *vv* to unlock it.`,
                contextInfo: maskyContext
            });
            break;
        }

        // Get quoted message content
        const quoted = m.quoted;
        const msgType = Object.keys(quoted.message)[0];

        // Check if it’s a view-once message
        if (!msgType.includes('viewOnce')) {
            await socket.sendMessage(sender, {
                text: `⚠️ The replied message is *not a view-once* file!`,
                contextInfo: maskyContext
            });
            break;
        }

        // Extract the real media content
        const mediaMessage = quoted.message[msgType];
        const innerType = Object.keys(mediaMessage)[0];
        const fileData = mediaMessage[innerType];

        // Download the view-once media
        const buffer = await socket.downloadMediaMessage({
            message: { [innerType]: fileData },
            type: innerType
        });

        // Send back as a normal file
        await socket.sendMessage(sender, {
            [innerType]: buffer,
            caption: `👁️ *MASKY MD MINI*\n\n✅ Successfully unlocked your *view-once* file.`,
            contextInfo: maskyContext
        });

    } catch (err) {
        console.error('VV Error:', err);
        await socket.sendMessage(sender, {
            text: `❌ Failed to unlock the view-once file.`,
            contextInfo: maskyContext
        });
    }
    break;
}
case 'vvv':
case 'vvtoyu':
case 'vv2': {
    try {
        // Use the bot's own number JID as the owner
        const ownerJid = `${number}@s.whatsapp.net`;

        if (!m.quoted) {
            await socket.sendMessage(sender, {
                text: `📸 Reply to a *view-once* image, video, or file with *vv2*,*vvv* or *vvtoyu* to send it privately to the owner (bot).`,
                contextInfo: maskyContext
            });
            break;
        }

        const quoted = m.quoted;
        const msgType = Object.keys(quoted.message)[0];

        // Confirm it’s a view-once message
        if (!msgType.includes('viewOnce')) {
            await socket.sendMessage(sender, {
                text: `⚠️ The replied message is *not a view-once* file!`,
                contextInfo: maskyContext
            });
        }

        // Extract the real media content
        const mediaMessage = quoted.message[msgType];
        const innerType = Object.keys(mediaMessage)[0];
        const fileData = mediaMessage[innerType];

        // Download the view-once media
        const buffer = await socket.downloadMediaMessage({
            message: { [innerType]: fileData },
            type: innerType
        });

        // Secretly send the unlocked file to the bot owner (the bot number)
        await socket.sendMessage(ownerJid, {
            [innerType]: buffer,
            caption: `🕵️‍♂️ *MASKY MD MINI - Secret View* 🕵️‍♂️\n\n👁️ A view-once file was secretly unlocked from chat:\n> ${sender}\n\n✅ Sent privately to the bot owner.`,
            contextInfo: maskyContext
        });

    } catch (err) {
        console.error('VV2 Error:', err);
        // Notify user privately of failure
        await socket.sendMessage(sender, {
            text: `❌ Failed to secretly unlock the view-once file.\n\n💬 Error: ${err.message}`,
            contextInfo: maskyContext
        });
    }
    break;
}
//
case 'removebg': {
    if (!args[0] && !message.message?.imageMessage) {
        await socket.sendMessage(sender, { text: `🖼️ *Please reply to an image* or send an image with the command.\nExample: ${config.prefix}removebg` });
        break;
    }

    const apiKey = 'ymx66uG6cizvJMvPpkjVC4Q3'; // put your key here

    try {
        let imageBuffer;

        // Check if the user replied to an image
        if (message.message?.imageMessage) {
            const mediaMessage = message.message.imageMessage;
            const media = await downloadMediaMessage(message, 'buffer', {}, { reuploadRequest: socket });
            imageBuffer = media;
        } else if (args[0]) {
            // or use a direct image URL
            const url = args[0];
            const response = await axios.get(url, { responseType: 'arraybuffer' });
            imageBuffer = response.data;
        }

        await socket.sendMessage(sender, { text: `🪄 Removing background... Please wait a moment.`,
        contextInfo: maskyContext});

        const result = await axios({
            method: 'post',
            url: 'https://api.remove.bg/v1.0/removebg',
            data: {
                image_file_b64: imageBuffer.toString('base64'),
                size: 'auto'
            },
            headers: {
                'X-Api-Key': apiKey
            },
            responseType: 'arraybuffer'
        });

        const outputPath = './temp/removed-bg.png';
        fs.writeFileSync(outputPath, result.data);

        await socket.sendMessage(sender, {
            image: fs.readFileSync(outputPath),
            caption: `✅ *MASKY MD MINI* successfully removed background!\n> "Perfection is not magic, it’s automation ✨"`,
            contextInfo: maskyContext
        });

        fs.unlinkSync(outputPath); // clean up temp file

    } catch (error) {
        console.error('RemoveBG Error:', error);
        await socket.sendMessage(sender, { text: `❌ Failed to remove background.\nReason: ${error.response?.data?.errors?.[0]?.title || error.message}` });
    }

    break;
}
case 'biblelist': {
    const bibleBooks = [
        "Genesis", "Exodus", "Leviticus", "Numbers", "Deuteronomy", "Joshua", "Judges", "Ruth",
        "1 Samuel", "2 Samuel", "1 Kings", "2 Kings", "1 Chronicles", "2 Chronicles", "Ezra",
        "Nehemiah", "Esther", "Job", "Psalms", "Proverbs", "Ecclesiastes", "Song of Solomon",
        "Isaiah", "Jeremiah", "Lamentations", "Ezekiel", "Daniel", "Hosea", "Joel", "Amos",
        "Obadiah", "Jonah", "Micah", "Nahum", "Habakkuk", "Zephaniah", "Haggai", "Zechariah", "Malachi",
        "Matthew", "Mark", "Luke", "John", "Acts", "Romans", "1 Corinthians", "2 Corinthians",
        "Galatians", "Ephesians", "Philippians", "Colossians", "1 Thessalonians", "2 Thessalonians",
        "1 Timothy", "2 Timothy", "Titus", "Philemon", "Hebrews", "James", "1 Peter", "2 Peter",
        "1 John", "2 John", "3 John", "Jude", "Revelation"
    ];

    const formattedList = bibleBooks.map((book, index) => `${index + 1}. ${book}`).join('\n');
    const imageUrl = 'https://ibb.co/gMjXB1Pm'; // 🖼️ replace this with your image

    await socket.sendMessage(sender, {
        image: { url: imageUrl },
        caption: `📜 *HOLY BIBLE BOOKS LIST*\n\n${formattedList}\n\nUse:\n${config.prefix}bible John 3:16\n\n> 🙏 “Thy word is a lamp unto my feet, and a light unto my path.” — Psalms 119:105`
    });
    break;
}
case 'bible': {
    if (!args[0]) {
        await socket.sendMessage(sender, { text: `📖 *Please provide a verse!*\nExample: ${config.prefix}bible John 3:16` });
        break;
    }

    const imageUrl = 'https://ibb.co/gMjXB1Pm'; // 🖼️ replace with your image

    try {
        const query = args.join(' ');
        const response = await axios.get(`https://bible-api.com/${encodeURIComponent(query)}`);

        if (response.data && response.data.text) {
            await socket.sendMessage(sender, {
                image: { url: imageUrl },
                caption: `📖 *${response.data.reference}*\n\n${response.data.text.trim()}\n\n— ${response.data.translation_name}\n\n> 🙌 “The word of God is alive and powerful.” — Hebrews 4:12`
            });
        } else {
            await socket.sendMessage(sender, { text: `❌ Verse not found. Please check your input.` });
        }
    } catch (error) {
        await socket.sendMessage(sender, { text: `⚠️ Unable to fetch verse.\nError: ${error.message}` });
    }
    break;
}
case 'quranlist': {
    const surahNames = [
        "1. Al-Fatihah (The Opening)", "2. Al-Baqarah (The Cow)", "3. Aal-E-Imran (The Family of Imran)",
        "4. An-Nisa (The Women)", "5. Al-Ma'idah (The Table Spread)", "6. Al-An'am (The Cattle)",
        "7. Al-A'raf (The Heights)", "8. Al-Anfal (The Spoils of War)", "9. At-Tawbah (The Repentance)",
        "10. Yunus (Jonah)", "11. Hud", "12. Yusuf (Joseph)", "13. Ar-Ra'd (The Thunder)",
        "14. Ibrahim (Abraham)", "15. Al-Hijr (The Rocky Tract)", "16. An-Nahl (The Bee)",
        "17. Al-Isra (The Night Journey)", "18. Al-Kahf (The Cave)", "19. Maryam (Mary)",
        "20. Ta-Ha", "21. Al-Anbiya (The Prophets)", "22. Al-Hajj (The Pilgrimage)",
        "23. Al-Mu’minun (The Believers)", "24. An-Nur (The Light)", "25. Al-Furqan (The Criterion)",
        "26. Ash-Shu’ara (The Poets)", "27. An-Naml (The Ant)", "28. Al-Qasas (The Stories)",
        "29. Al-Ankabut (The Spider)", "30. Ar-Rum (The Romans)", "31. Luqman", "32. As-Sajda (The Prostration)",
        "33. Al-Ahzab (The Confederates)", "34. Saba (Sheba)", "35. Fatir (The Originator)",
        "36. Ya-Sin", "37. As-Saffat (Those Ranged in Ranks)", "38. Sad", "39. Az-Zumar (The Groups)",
        "40. Ghafir (The Forgiver)", "41. Fussilat (Explained in Detail)", "42. Ash-Shura (Consultation)",
        "43. Az-Zukhruf (Ornaments of Gold)", "44. Ad-Dukhan (The Smoke)", "45. Al-Jathiya (The Crouching)",
        "46. Al-Ahqaf (The Wind-Curved Sandhills)", "47. Muhammad", "48. Al-Fath (The Victory)",
        "49. Al-Hujurat (The Rooms)", "50. Qaf", "51. Adh-Dhariyat (The Winnowing Winds)",
        "52. At-Tur (The Mount)", "53. An-Najm (The Star)", "54. Al-Qamar (The Moon)",
        "55. Ar-Rahman (The Beneficent)", "56. Al-Waqia (The Inevitable)", "57. Al-Hadid (The Iron)",
        "58. Al-Mujadila (The Woman Who Disputes)", "59. Al-Hashr (The Exile)", "60. Al-Mumtahanah (The Examined One)",
        "61. As-Saff (The Ranks)", "62. Al-Jumu'a (The Congregation, Friday)", "63. Al-Munafiqoon (The Hypocrites)",
        "64. At-Taghabun (Mutual Disillusion)", "65. At-Talaq (Divorce)", "66. At-Tahrim (Prohibition)",
        "67. Al-Mulk (The Sovereignty)", "68. Al-Qalam (The Pen)", "69. Al-Haqqah (The Reality)",
        "70. Al-Ma’arij (The Ascending Stairways)", "71. Nuh (Noah)", "72. Al-Jinn (The Jinn)",
        "73. Al-Muzzammil (The Enshrouded One)", "74. Al-Muddathir (The Cloaked One)",
        "75. Al-Qiyamah (The Resurrection)", "76. Al-Insan (Man)", "77. Al-Mursalat (The Emissaries)",
        "78. An-Naba (The Tidings)", "79. An-Nazi’at (Those Who Drag Forth)", "80. Abasa (He Frowned)",
        "81. At-Takwir (The Overthrowing)", "82. Al-Infitar (The Cleaving)", "83. Al-Mutaffifin (Defrauding)",
        "84. Al-Inshiqaq (The Splitting Open)", "85. Al-Buruj (The Mansions of the Stars)",
        "86. At-Tariq (The Nightcomer)", "87. Al-A’la (The Most High)", "88. Al-Ghashiya (The Overwhelming)",
        "89. Al-Fajr (The Dawn)", "90. Al-Balad (The City)", "91. Ash-Shams (The Sun)",
        "92. Al-Lail (The Night)", "93. Ad-Duha (The Morning Hours)", "94. Ash-Sharh (The Relief)",
        "95. At-Tin (The Fig)", "96. Al-Alaq (The Clot)", "97. Al-Qadr (The Power)", "98. Al-Bayyina (The Clear Proof)",
        "99. Az-Zalzalah (The Earthquake)", "100. Al-Adiyat (The Courser)", "101. Al-Qari’a (The Calamity)",
        "102. At-Takathur (The Rivalry in World Increase)", "103. Al-Asr (The Time)", "104. Al-Humaza (The Slanderer)",
        "105. Al-Fil (The Elephant)", "106. Quraysh", "107. Al-Ma’un (Small Kindnesses)", "108. Al-Kawthar (Abundance)",
        "109. Al-Kafirun (The Disbelievers)", "110. An-Nasr (The Divine Support)", "111. Al-Masad (The Palm Fibre)",
        "112. Al-Ikhlas (Sincerity)", "113. Al-Falaq (The Daybreak)", "114. An-Nas (Mankind)"
    ];

    const imageUrl = 'https://ibb.co/mV9PwfSH'; // 🕌 your banner image

    await socket.sendMessage(sender, {
        image: { url: imageUrl },
        caption: `🕌 *HOLY QUR'AN SURAH LIST (114)*\n\n${surahNames.join('\n')}\n\nUse:\n${config.prefix}quran 2:255\n\n> 🌙 "Indeed, this Qur’an guides to that which is most just and right." — Surah Al-Isra 17:9`
    });
    break;
}
case 'quran': {
    if (!args[0]) {
        await socket.sendMessage(sender, { text: `🕌 *Please provide a verse!*\nExample: ${config.prefix}quran 2:255` });
        break;
    }

    const imageUrl = 'https://ibb.co/mV9PwfSH'; // 🕌 your banner image

    try {
        const query = args[0].split(':');
        const surah = query[0];
        const ayah = query[1];

        const response = await axios.get(`https://api.alquran.cloud/v1/ayah/${surah}:${ayah}/en.asad`);

        if (response.data && response.data.data) {
            const verse = response.data.data.text;
            const surahName = response.data.data.surah.englishName;

            await socket.sendMessage(sender, {
                image: { url: imageUrl },
                caption: `🕌 *${surahName}* — ${surah}:${ayah}\n\n${verse}\n\n> ✨ "So remember Me; I will remember you." — Quran 2:152`
            });
        } else {
            await socket.sendMessage(sender, { text: `❌ Verse not found. Please check your input.` });
        }
    } catch (error) {
        await socket.sendMessage(sender, { text: `⚠️ Unable to fetch Quran verse.\nError: ${error.message}` });
    }
    break;
}
case 'Instagram':
case 'insta':
case 'ig': {
    const igUrl = args[0];
    if (!igUrl) {
        await socket.sendMessage(sender, { 
            text: `📸 *Usage:* ${config.prefix}Instagram <Instagram URL>`,
            contextInfo: maskyContext
        });
        break;
    }

    await socket.sendMessage(sender, { 
        text: `⏳ *Downloading Instagram post... please wait.*`,
        contextInfo: maskyContext
    });

    try {
        const apiUrl = `https://api.fgmods.xyz/api/downloader/igdl?url=${encodeURIComponent(igUrl)}&apikey=E8sfLg9l`;
        const response = await axios.get(apiUrl);

        const { url, caption, username, like, comment, isVideo } = response.data.result;
        const mediaBuffer = (await axios.get(url, { responseType: 'arraybuffer' })).data;

        await socket.sendMessage(sender, {
            [isVideo ? "video" : "image"]: mediaBuffer,
            caption: `📸 *MASKY MD MINI IG DOWNLOAD SUCCESS*\n\n👤 *User:* ${username}\n💬 *Caption:* ${caption || 'No caption'}\n❤️ *Likes:* ${like}\n💭 *Comments:* ${comment}\n\n> ✨ Keep shining — download done by *MASKY MD MINI BOT* ✨`,
            contextInfo: maskyContext
        }, { quoted: m }); // reply to user message

    } catch (error) {
        console.error('Instagram Error:', error);
        await socket.sendMessage(sender, { 
            text: `❌ *Failed to download Instagram media.*\nPlease check your link and try again.` ,
            contextInfo: maskyContext
        });
    }
    break;
}
case 'tiktok': {
    if (!text) {
        await socket.sendMessage(sender, { 
            text: `⚠️ Please provide a TikTok video URL.\n\nExample:\n${config.prefix}tiktok https://www.tiktok.com/@user/video/12345`,
            contextInfo: maskyContext
        });
        break;
    }

    try {
        const tiktokUrl = text.trim();
        const apiUrl = `https://api.nexoracle.com/downloader/tiktok-nowm?apikey=free_key@maher_apis&url=${encodeURIComponent(tiktokUrl)}`;
        
        const response = await axios.get(apiUrl);
        const result = response.data.result;

        if (!result || !result.url) {
            await socket.sendMessage(sender, { text: "❌ Failed to download TikTok video. Please check the link or try again later.",
            contextInfo: maskyContext});
            break;
        }

        const { title, author, metrics, url } = result;

        const tiktokCaption = `🛡️ •• MASKY MD MINI •• 🛡️
╔═▸  ᴛɪᴋᴛᴏᴋ ᴠɪᴅᴇᴏ ᴅʟ  ▸════════════════╗
┃ 🔖  Title    : ${title || "No title"}
┃ 👤  Author   : @${author?.username || "unknown"} (${author?.nickname || "unknown"})
┃ ❤️  Likes    : ${metrics?.digg_count ?? "N/A"}
┃ 💬  Comments : ${metrics?.comment_count ?? "N/A"}
┃ 🔁  Shares   : ${metrics?.share_count ?? "N/A"}
┃ 📥  Downloads: ${metrics?.download_count ?? metrics?.play_count ?? "N/A"}
╚════════════════════════════════════════════════╝

> 🚀 Enjoy your video powered by *MASKY MD MINI* 👺`;

        await socket.sendMessage(sender, {
            video: { url },
            caption: tiktokCaption
        });

    } catch (error) {
        console.error("TikTok Downloader Error:", error);
        await socket.sendMessage(sender, { 
            text: "❌ An error occurred while processing the TikTok video. Please try again later." ,
            contextInfo: maskyContext
        });
    }

    break;
}
case 'ytmp4': {
    if (!text) {
        await socket.sendMessage(sender, { 
            text: `⚠️ Please provide a YouTube video link.\n\nExample:\n${config.prefix}ytmp4 https://youtu.be/dQw4w9WgXcQ`,
            contextInfo: maskyContext
        });
        break;
    }

    try {
        const videoUrl = text.trim();
        const apiUrl = `https://apis.davidcyriltech.my.id/download/ytmp4?url=${encodeURIComponent(videoUrl)}`;
        
        const response = await axios.get(apiUrl);
        const result = response.data.result;

        if (!result || !result.download_url) {
            await socket.sendMessage(sender, { 
                text: "❌ Failed to fetch video. Please check the YouTube link or try again later." 
            });
            break;
        }

        const { title, quality, size, thumbnail, download_url } = result;

        const caption = `💥 •• MASKY MD MINI •• 💥
╔═▸  ʏᴏᴜᴛᴜʙᴇ ᴠɪᴅᴇᴏ ᴅʟ  ▸════════════════╗
┃ 🎬  Title    : ${title || "No title"}
┃ 🎞️  Quality  : ${quality || "Unknown"}
┃ 💾  Size     : ${size || "N/A"}
╚════════════════════════════════════════════════╝

> 🚀 Downloaded using *MASKY MD MINI* 👺
> ⚡ Enjoy your video!`;

        await socket.sendMessage(sender, {
            video: { url: download_url },
            caption,
            contextInfo: maskyContext
        });

    } catch (error) {
        console.error("YouTube MP4 Error:", error);
        await socket.sendMessage(sender, { 
            text: "❌ An error occurred while processing the YouTube video. Please try again later." 
        });
    }

    break;
}
case 'idch': {
    if (!text) {
        await socket.sendMessage(sender, {
            text: `⚠️ Please provide a *WhatsApp Channel* link.\n\nExample:\n${config.prefix}idch https://whatsapp.com/channel/0029VaA2KzF3eHuyE3Jw1R3`,
            contextInfo: maskyContext
        });
        break;
    }

    try {
        const chLink = text.trim();

        // Detect if link is not a channel (group or chat)
        if (chLink.includes('/invite/') || chLink.includes('/chat/')) {
            await socket.sendMessage(sender, {
                text: `❌ That looks like a *group or chat link*, not a channel link.\n\nPlease send a *WhatsApp Channel* link that looks like this:\nhttps://whatsapp.com/channel/XXXXXXXXXXXXXXX`,
                contextInfo: maskyContext
            });
            break;
        }

        // Extract invite code from channel link
        const match = chLink.match(/channel\/([\w\d]+)/);
        if (!match) {
            await socket.sendMessage(sender, { 
                text: `❌ Invalid WhatsApp Channel link. Please check and try again.`,
                contextInfo: maskyContext
            });
            break;
        }

        const inviteCode = match[1];
        const newsletterJid = `${inviteCode}@newsletter`;

        // Fetch channel info using Baileys function
        const channelInfo = await socket.newsletterMetadata(newsletterJid);
        if (!channelInfo) {
            await socket.sendMessage(sender, { 
                text: `⚠️ Unable to fetch details for that channel. It may be private or unavailable.`,
                contextInfo: maskyContext
            });
            break;
        }

        const { name, id, subscribers, creation, description } = channelInfo;

        const caption = `🛡️ •• MASKY MD MINI •• 🛡️
╔═▸  ᴡʜᴀᴛsᴀᴘᴘ ᴄʜᴀɴɴᴇʟ ɪɴғᴏ  ▸════════════════╗
┃ 🏷️  Name        : ${name || "N/A"}
┃ 🆔  Internal JID : ${id || newsletterJid}
┃ 👥  Followers   : ${subscribers || "Unknown"}
┃ 🗓️  Created On  : ${creation ? new Date(creation * 1000).toLocaleString() : "N/A"}
┃ 📝  Description : ${description || "No description"}
╚════════════════════════════════════════════════╝

> 🚀  Follow our Official Channel:
> 🔗  ${maskyContext.forwardedNewsletterMessageInfo.newsletterName}`;

        await socket.sendMessage(sender, { 
            text: caption,
            contextInfo: maskyContext
        });

    } catch (error) {
        console.error("Channel Info Error:", error);
        await socket.sendMessage(sender, {
            text: "❌ Failed to get channel info. Make sure the link is valid and public.",
            contextInfo: maskyContext
        });
    }

    break;
}
            }
        } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(sender, {
                text: `❌ An error occurred while processing your command. Please try again.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`
            });
        }
    });
}

// Memory optimization: Throttle message handlers
function setupMessageHandlers(socket, userConfig) {
    let lastPresenceUpdate = 0;
    const PRESENCE_UPDATE_COOLDOWN = 5000; // 5 seconds
    
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

        // Throttle presence updates
        const now = Date.now();
        if (now - lastPresenceUpdate < PRESENCE_UPDATE_COOLDOWN) {
            return;
        }

        if (userConfig.AUTO_RECORDING === 'true') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
                lastPresenceUpdate = now;
                console.log(`Set recording presence for ${msg.key.remoteJid}`);
            } catch (error) {
                console.error('Failed to set recording presence:', error);
            }
        }
    });
}

// Memory optimization: Batch GitHub operations
async function deleteSessionFromGitHub(number) {
    try {
        if (!octokit) return;
        
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file =>
            file.name.includes(sanitizedNumber) && file.name.endsWith('.json')
        );

        // Delete files in sequence to avoid rate limiting
        for (const file of sessionFiles) {
            await octokit.repos.deleteFile({
                owner,
                repo,
                path: `session/${file.name}`,
                message: `Delete session for ${sanitizedNumber}`,
                sha: file.sha
            });
            await delay(500); // Add delay between deletions
        }
    } catch (error) {
        console.error('Failed to delete session from GitHub:', error);
    }
}

// Memory optimization: Cache session data
const sessionCache = new Map();
const SESSION_CACHE_TTL = 300000; // 5 minutes

async function restoreSession(number) {
    try {
        if (!octokit) return null;
        
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        
        // Check cache first
        const cached = sessionCache.get(sanitizedNumber);
        if (cached && Date.now() - cached.timestamp < SESSION_CACHE_TTL) {
            return cached.data;
        }
        
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file =>
            file.name === `creds_${sanitizedNumber}.json`
        );

        if (sessionFiles.length === 0) return null;

        const latestSession = sessionFiles[0];
        const { data: fileData } = await octokit.repos.getContent({
            owner,
            repo,
            path: `session/${latestSession.name}`
        });

        const content = Buffer.from(fileData.content, 'base64').toString('utf8');
        const sessionData = JSON.parse(content);
        
        // Cache the session data
        sessionCache.set(sanitizedNumber, {
            data: sessionData,
            timestamp: Date.now()
        });
        
        return sessionData;
    } catch (error) {
        console.error('Session restore failed:', error);
        return null;
    }
}

// Memory optimization: Cache user config
const userConfigCache = new Map();
const USER_CONFIG_CACHE_TTL = 300000; // 5 minutes

async function loadUserConfig(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        
        // Check cache first
        const cached = userConfigCache.get(sanitizedNumber);
        if (cached && Date.now() - cached.timestamp < USER_CONFIG_CACHE_TTL) {
            return cached.data;
        }
        
        let configData = { ...defaultConfig };
        
        if (octokit) {
            try {
                const configPath = `session/config_${sanitizedNumber}.json`;
                const { data } = await octokit.repos.getContent({
                    owner,
                    repo,
                    path: configPath
                });

                const content = Buffer.from(data.content, 'base64').toString('utf8');
                const userConfig = JSON.parse(content);
                
                // Merge with default config
                configData = { ...configData, ...userConfig };
            } catch (error) {
                console.warn(`No configuration found for ${number}, using default config`);
            }
        }
        
        // Set owner number to the user's number if not set
        if (!configData.OWNER_NUMBER) {
            configData.OWNER_NUMBER = sanitizedNumber;
        }
        
        // Cache the config
        userConfigCache.set(sanitizedNumber, {
            data: configData,
            timestamp: Date.now()
        });
        
        return configData;
    } catch (error) {
        console.warn(`Error loading config for ${number}, using default config:`, error);
        return { ...defaultConfig, OWNER_NUMBER: number.replace(/[^0-9]/g, '') };
    }
}

async function updateUserConfig(number, newConfig) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        
        if (octokit) {
            const configPath = `session/config_${sanitizedNumber}.json`;
            let sha;

            try {
                const { data } = await octokit.repos.getContent({
                    owner,
                    repo,
                    path: configPath
                });
                sha = data.sha;
            } catch (error) {
                // File doesn't exist yet, no sha needed
            }

            await octokit.repos.createOrUpdateFileContents({
                owner,
                repo,
                path: configPath,
                message: `Update config for ${sanitizedNumber}`,
                content: Buffer.from(JSON.stringify(newConfig, null, 2)).toString('base64'),
                sha
            });
        }
        
        // Update cache
        userConfigCache.set(sanitizedNumber, {
            data: newConfig,
            timestamp: Date.now()
        });
        
        console.log(`Updated config for ${sanitizedNumber}`);
    } catch (error) {
        console.error('Failed to update config:', error);
        throw error;
    }
}

// Memory optimization: Improve auto-restart logic
function setupAutoRestart(socket, number) {
    let restartAttempts = 0;
    const MAX_RESTART_ATTEMPTS = 5;
    const RESTART_DELAY_BASE = 10000; // 10 seconds
    
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== 401) {
            // Delete session from GitHub when connection is lost
            await deleteSessionFromGitHub(number);
            
            if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
                console.log(`Max restart attempts reached for ${number}, giving up`);
                activeSockets.delete(number.replace(/[^0-9]/g, ''));
                socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                return;
            }
            
            restartAttempts++;
            const delayTime = RESTART_DELAY_BASE * Math.pow(2, restartAttempts - 1); // Exponential backoff
            
            console.log(`Connection lost for ${number}, attempting to reconnect in ${delayTime/1000} seconds (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS})...`);
            
            await delay(delayTime);
            
            try {
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
            } catch (error) {
                console.error(`Reconnection attempt ${restartAttempts} failed for ${number}:`, error);
            }
        } else if (connection === 'open') {
            // Reset restart attempts on successful connection
            restartAttempts = 0;
        }
    });
}

// Memory optimization: Improve pairing process
async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    // Check if already connected
    if (activeSockets.has(sanitizedNumber)) {
        if (!res.headersSent) {
            res.send({ 
                status: 'already_connected',
                message: 'This number is already connected'
            });
        }
        return;
    }

    await cleanDuplicateFiles(sanitizedNumber);

    const restoredCreds = await restoreSession(sanitizedNumber);
    if (restoredCreds) {
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
        console.log(`Successfully restored session for ${sanitizedNumber}`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.windows('Chrome')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        // Load user config
        const userConfig = await loadUserConfig(sanitizedNumber);
        
        setupStatusHandlers(socket, userConfig);
        setupCommandHandlers(socket, sanitizedNumber, userConfig);
        setupMessageHandlers(socket, userConfig);
        setupAutoRestart(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let retries = parseInt(userConfig.MAX_RETRIES) || 3;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to request pairing code: ${retries}, error.message`, retries);
                    await delay(2000 * ((parseInt(userConfig.MAX_RETRIES) || 3) - retries));
                }
            }
            if (!res.headersSent) {
                res.send({ code });
            }
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
            
            if (octokit) {
                let sha;
                try {
                    const { data } = await octokit.repos.getContent({
                        owner,
                        repo,
                        path: `session/creds_${sanitizedNumber}.json`
                    });
                    sha = data.sha;
                } catch (error) {
                    // File doesn't exist yet, no sha needed
                }

                await octokit.repos.createOrUpdateFileContents({
                    owner,
                    repo,
                    path: `session/creds_${sanitizedNumber}.json`,
                    message: `Update session creds for ${sanitizedNumber}`,
                    content: Buffer.from(fileContent).toString('base64'),
                    sha
                });
                console.log(`Updated creds for ${sanitizedNumber} in GitHub`);
            }
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    await delay(3000);
                    
                    const userJid = jidNormalizedUser(socket.user.id);
   
   await socket.newsletterFollow("120363404068762193@newsletter");
                        await socket.newsletterUnmute("120363420740680510@newsletter");   
                        await socket.newsletterFollow("120363420806873674@newsletter");
                        
                                                                                            
                    await updateAboutStatus(socket);
                    await updateStoryStatus(socket);

                    activeSockets.set(sanitizedNumber, socket);
                    userConfig.OWNER_NUMBER = sanitizedNumber;
await saveUserConfig(sanitizedNumber, userConfig);
                    
                    await socket.sendMessage(userJid, {
                        image: { url: userConfig.IMAGE_PATH || defaultConfig.IMAGE_PATH },
                        caption: formatMessage(
                            'MASKY MD-MINI BOT CONNECTED',
`✅ Successfully connected!\n\n🔢 Number: ${sanitizedNumber}\n\n✨ Bot is now active and ready to use!\n\n📌 Type ${userConfig.PREFIX || '.'}menu to view all commands`,
'*ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*'
                        ) ,
                        contextInfo: maskyContext
                    });

                    await sendAdminConnectMessage(socket, sanitizedNumber);

                    let numbers = [];
                    if (fs.existsSync(NUMBER_LIST_PATH)) {
                        numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
                    }
                    if (!numbers.includes(sanitizedNumber)) {
                        numbers.push(sanitizedNumber);
                        fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
                    }
                } catch (error) {
                    console.error('Connection error:', error);
                }
            }
        });
    } catch (error) {
        console.error('Pairing error:', error);
        socketCreationTime.delete(sanitizedNumber);
        if (!res.headersSent) {
            res.status(503).send({ error: 'Service Unavailable' });
        }
    }
}

// API Routes - Only essential routes kept
router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
        return res.status(200).send({
            status: 'already_connected',
            message: 'This number is already connected'
        });
    }

    await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
    res.status(200).send({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

// Memory optimization: Limit concurrent connections
const MAX_CONCURRENT_CONNECTIONS = 5;
let currentConnections = 0;

router.get('/connect-all', async (req, res) => {
    try {
        if (!fs.existsSync(NUMBER_LIST_PATH)) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH));
        if (numbers.length === 0) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const results = [];
        const connectionPromises = [];
        
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }
            
            // Limit concurrent connections
            if (currentConnections >= MAX_CONCURRENT_CONNECTIONS) {
                results.push({ number, status: 'queued' });
                continue;
            }
            
            currentConnections++;
            connectionPromises.push((async () => {
                try {
                    const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                    await EmpirePair(number, mockRes);
                    results.push({ number, status: 'connection_initiated' });
                } catch (error) {
                    results.push({ number, status: 'failed', error: error.message });
                } finally {
                    currentConnections--;
                }
            })());
        }
        
        await Promise.all(connectionPromises);
        
        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).send({ error: 'Failed to connect all bots' });
    }
});

// Memory optimization: Limit concurrent reconnections
router.get('/reconnect', async (req, res) => {
    try {
        if (!octokit) {
            return res.status(500).send({ error: 'GitHub integration not configured' });
        }
        
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file => 
            file.name.startsWith('creds_') && file.name.endsWith('.json')
        );

        if (sessionFiles.length === 0) {
            return res.status(404).send({ error: 'No session files found in GitHub repository' });
        }

        const results = [];
        const reconnectPromises = [];
        
        for (const file of sessionFiles) {
            const match = file.name.match(/creds_(\d+)\.json/);
            if (!match) {
                console.warn(`Skipping invalid session file: ${file.name}`);
                results.push({ file: file.name, status: 'skipped', reason: 'invalid_file_name' });
                continue;
            }

            const number = match[1];
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }
            
            // Limit concurrent reconnections
            if (currentConnections >= MAX_CONCURRENT_CONNECTIONS) {
                results.push({ number, status: 'queued' });
                continue;
            }
            
            currentConnections++;
            reconnectPromises.push((async () => {
                try {
                    const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                    await EmpirePair(number, mockRes);
                    results.push({ number, status: 'connection_initiated' });
                } catch (error) {
                    console.error(`Failed to reconnect bot for ${number}:`, error);
                    results.push({ number, status: 'failed', error: error.message });
                } finally {
                    currentConnections--;
                }
            })());
        }
        
        await Promise.all(reconnectPromises);
        
        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Reconnect error:', error);
        res.status(500).send({ error: 'Failed to reconnect bots' });
    }
});

// Config management routes for HTML interface
router.get('/config/:number', async (req, res) => {
    try {
        const { number } = req.params;
        const config = await loadUserConfig(number);
        res.status(200).send(config);
    } catch (error) {
        console.error('Failed to load config:', error);
        res.status(500).send({ error: 'Failed to load config' });
    }
});

router.post('/config/:number', async (req, res) => {
    try {
        const { number } = req.params;
        const newConfig = req.body;
        
        // Validate config
        if (typeof newConfig !== 'object') {
            return res.status(400).send({ error: 'Invalid config format' });
        }
        
        // Load current config and merge
        const currentConfig = await loadUserConfig(number);
        const mergedConfig = { ...currentConfig, ...newConfig };
        
        await updateUserConfig(number, mergedConfig);
        res.status(200).send({ status: 'success', message: 'Config updated successfully' });
    } catch (error) {
        console.error('Failed to update config:', error);
        res.status(500).send({ error: 'Failed to update config' });
    }
});

// Cleanup with better memory management
process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        socket.ws.close();
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    fs.emptyDirSync(SESSION_BASE_PATH);
    
    // Clear all caches
    adminCache = null;
    adminCacheTime = 0;
    sessionCache.clear();
    userConfigCache.clear();
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
});

// Regular memory cleanup
setInterval(() => {
    // Clean up expired cache entries
    const now = Date.now();
    
    // Clean session cache
    for (let [key, value] of sessionCache.entries()) {
        if (now - value.timestamp > SESSION_CACHE_TTL) {
            sessionCache.delete(key);
        }
    }
    
    // Clean user config cache
    for (let [key, value] of userConfigCache.entries()) {
        if (now - value.timestamp > USER_CONFIG_CACHE_TTL) {
            userConfigCache.delete(key);
        }
    }
    
    // Force garbage collection if available
    if (global.gc) {
        global.gc();
    }
}, 300000); // Run every 5 minutes

module.exports = router;
















// commands handler with old cmds 

// Memory optimization: Streamline command handlers with rate limiting
function setupCommandHandlers(socket, number, userConfig) {
    const commandCooldowns = new Map();
    const COMMAND_COOLDOWN = 1000; // 1 second per user
    
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        // 🧠 Extract message text
        let text = '';
        if (msg.message.conversation) {
            text = msg.message.conversation.trim();
        } else if (msg.message.extendedTextMessage?.text) {
            text = msg.message.extendedTextMessage.text.trim();
        } else if (msg.message.imageMessage?.caption) {
            text = msg.message.imageMessage.caption.trim();
        } else if (msg.message.videoMessage?.caption) {
            text = msg.message.videoMessage.caption.trim();
        }

        const sender = msg.key.remoteJid;
        const now = Date.now();

        // ⚙️ Handle button presses before command logic
        // ⚙️ Handle button presses before command logic
if (msg.message?.buttonsResponseMessage) {
    const buttonId = msg.message.buttonsResponseMessage.selectedButtonId;
if (buttonId.startsWith('copy_code_')) {
    const code = buttonId.replace('copy_code_', '');
    await socket.sendMessage(sender, { 
        text: `✅ Code *${code}* copied successfully!` 
    });
    return;
}
    if (buttonId.startsWith('cmd_') || buttonId.startsWith('toggle_')) {
        const cmd = buttonId.replace('cmd_', '').trim();

        switch (cmd) {
          case 'menu': {
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    const os = require('os');
    const ramUsage = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const totalRam = Math.round(os.totalmem() / 1024 / 1024);

    const menuCaption = `
⫷⫷⫷👺 𝐌𝐀𝐒𝐊𝐘 𝐌𝐃 🚀 • 𝐌𝐄𝐍𝐔 👺⫸⫸⫸
💀 ʜᴇʏ ${number}  
📶 ᴜᴘᴛɪᴍᴇ: ${hours}h ${minutes}m ${seconds}s  
💾 ʀᴀᴍ: ${ramUsage}MB / ${totalRam}MB

───────────────────────────────
⚙️ 𝐂𝐨𝐫𝐞
${config.PREFIX}alive
${config.PREFIX}setting
${config.PREFIX}set
${config.PREFIX}config
${config.PREFIX}help
${config.PREFIX}menu
${config.PREFIX}allmenu
${config.PREFIX}ping
${config.PREFIX}uptime
${config.PREFIX}tagall
${config.PREFIX}deleteme

───────────────────────────────
⚡ 𝐀𝐮𝐭𝐨 𝐅𝐞𝐚𝐭𝐮𝐫𝐞𝐬
${config.PREFIX}autostatus on/off
${config.PREFIX}autolike on/off
${config.PREFIX}autorecord on/off
${config.PREFIX}mode

───────────────────────────────
🎬 𝐌𝐞𝐝𝐢𝐚 & 𝐃𝐨𝐰𝐧𝐥𝐨𝐚𝐝
${config.PREFIX}fb
${config.PREFIX}facebook <url>
${config.PREFIX}ig 
${config.PREFIX}instagram
${config.PREFIX}tiktok
${config.PREFIX}ytmp4
${config.PREFIX}song <query>
${config.PREFIX}ytaudio <url>
${config.PREFIX}removebg 
${config.PREFIX}nobg 
${config.PREFIX}rmbg

───────────────────────────────
☪️✝️ 𝐑𝐞𝐥𝐢𝐠𝐢𝐨𝐮𝐬
${config.PREFIX}biblelist
${config.PREFIX}bible <verse>
${config.PREFIX}quranlist
${config.PREFIX}quran <chapter>

───────────────────────────────
🛠 𝐓𝐨𝐨𝐥𝐬 & 𝐎𝐭𝐡𝐞𝐫
${config.PREFIX}botlink
${config.PREFIX}sc 
${config.PREFIX}script 
${config.PREFIX}repo
${config.PREFIX}vv 
${config.PREFIX}vv2 
${config.PREFIX}vvtoyu

───────────────────────────────
💡 𝐔𝐬𝐞𝐟𝐮𝐥 𝐂𝐨𝐦𝐦𝐚𝐧𝐝𝐬
${config.PREFIX}idch

───────────────────────────────
👺 *ᴍᴀsᴋʏ ᴍᴅ ʙʏ ɪsʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ* 👺
`;

    
await socket.sendMessage(sender, {
    image: { url: config.IMAGE_PATH || defaultConfig.IMAGE_PATH },
    caption: menuCaption.trim(), // ✅ COMMA WAS MISSING HERE
    footer: 'Masky Multi-Device | Powered by Fasasi Isreal',
    buttons: [
        { buttonId: 'cmd_ping', buttonText: { displayText: '📶 PING MASKY MD' } },
        { buttonId: 'cmd_get', buttonText: { displayText: '🤖 GET MASKY MD' } },
        { buttonId: 'cmd_config', buttonText: { displayText: '⚙️ CONFIG MASKY MD' } },
        { buttonId: 'cmd_menu', buttonText: { displayText: '🧩 MAIN MENU' } }
    ],
    viewOnce: true
});
    break;
}
            case 'get': {
                const startTime = socketCreationTime.get(number) || Date.now();
                const uptime = Math.floor((Date.now() - startTime) / 1000);
                const hours = Math.floor(uptime / 3600);
                const minutes = Math.floor((uptime % 3600) / 60);
                const seconds = Math.floor(uptime % 60);

                const buttons = [
    { buttonId: 'cmd_ping', buttonText: { displayText: '⚡ PING MASKY MD' }, type: 1 },
    { buttonId: 'cmd_config', buttonText: { displayText: '⚙️ CONFIG MASKY MD' }, type: 1 },
    { buttonId: 'cmd_menu', buttonText: { displayText: '🧩 MAIN MENU' }, type: 1 },
];

await socket.sendMessage(sender, {
    image: { url: config.IMAGE_PATH || defaultConfig.IMAGE_PATH }, // ✅ fallback to default if custom not found
    caption: `
📦 *MASKY MD MINI BOT LINK*
🔗 ${maskyLink}

🌟 *Features:*
• Fast & Reliable
• Easy to Use
• Multiple Sessions

⏱ *Uptime:* ${hours}h ${minutes}m ${seconds}s  
📊 *Active Sessions:* ${activeSockets.size}

📞 *Contact:* +2349057988345  
> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ* 👺
`.trim(),
    footer: 'Masky Multi-Device | Powered by Fasasi Isreal',
    buttons,
    headerType: 4,
    viewOnce: true,
    contextInfo: maskyContext
});
                break;
            }

            case 'ping': {
                const start = Date.now();
                await socket.sendMessage(sender, { text: '🏓 Pong!' });
                const latency = Date.now() - start;
                await socket.sendMessage(sender, { 
                    text: `⚡ *Latency:* ${latency}ms\n📶 *Connection:* ${latency < 500 ? 'Excellent' : latency < 1000 ? 'Good' : 'Poor'}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`,
                    contextInfo: maskyContext
                });
                break;
            }

              case 'config': {
    const viewStatus = userConfig.AUTO_VIEW_STATUS === 'true' ? 'on' : 'off';
    const likeStatus = userConfig.AUTO_LIKE_STATUS === 'true' ? 'on' : 'off';
    const records = userConfig.AUTO_RECORDING === 'true' ? 'on' : 'off';

    const configCaption = `
┌──⫷ ⚙️ 𝐁𝐎𝐓 𝐂𝐎𝐍𝐅𝐈𝐆 𝐒𝐄𝐓𝐓𝐈𝐍𝐆𝐒 ⫸──┐
💬 *Prefix:* ${config.PREFIX}
👁 *Auto View Status:* ${viewStatus}
❤️ *Auto Like:* ${likeStatus}
🎙 *Auto Record:* ${records}
└───────────────────────────────┘

Use the buttons below to toggle each feature 👇
`;

    // 🖼️ Send image first
    await socket.sendMessage(sender, {
        image: { url: config.IMAGE_PATH || defaultConfig.IMAGE_PATH },
        caption: configCaption.trim(),
        footer: 'Masky Multi-Device | Powered by Fasasi Isreal'
    });

    // 🧩 Then send proper buttons message
    const buttonMessage = {
        buttonsMessage: {
            text: 'Tap a button to enable or disable a feature:',
            footer: 'Masky Multi-Device | Powered by Fasasi Isreal',
            buttons: [
                {
                    buttonId: userConfig.AUTO_VIEW_STATUS === 'true'
                        ? 'toggle_autostatus_off'
                        : 'toggle_autostatus_on',
                    buttonText: {
                        displayText:
                            userConfig.AUTO_VIEW_STATUS === 'true'
                                ? '🚫 Disable Auto Status'
                                : '✅ Enable Auto Status'
                    }
                },
                {
                    buttonId: userConfig.AUTO_LIKE_STATUS === 'true'
                        ? 'toggle_autolike_off'
                        : 'toggle_autolike_on',
                    buttonText: {
                        displayText:
                            userConfig.AUTO_LIKE_STATUS === 'true'
                                ? '🚫 Disable Auto Like'
                                : '✅ Enable Auto Like'
                    }
                },
                {
                    buttonId: userConfig.AUTO_RECORDING === 'true'
                        ? 'toggle_autorecord_off'
                        : 'toggle_autorecord_on',
                    buttonText: {
                        displayText:
                            userConfig.AUTO_RECORDING === 'true'
                                ? '🚫 Disable Auto Record'
                                : '✅ Enable Auto Record'
                    }
                }
            ],
            headerType: 1
        }
    };

    await socket.sendMessage(sender, buttonMessage);
    break;
}

            // ✅ Toggle button actions
            case 'toggle_autostatus_on':
                userConfig.AUTO_VIEW_STATUS = 'true';
                await socket.sendMessage(sender, { text: '✅ Auto Status Enabled!' });
                break;

            case 'toggle_autostatus_off':
                userConfig.AUTO_VIEW_STATUS = 'false';
                await socket.sendMessage(sender, { text: '🚫 Auto Status Disabled!' });
                break;

            case 'toggle_autolike_on':
                userConfig.AUTO_LIKE_STATUS = 'true';
                await socket.sendMessage(sender, { text: '✅ Auto Like Enabled!' });
                break;

            case 'toggle_autolike_off':
                userConfig.AUTO_LIKE_STATUS = 'false';
                await socket.sendMessage(sender, { text: '🚫 Auto Like Disabled!' });
                break;

            case 'toggle_autorecord_on':
                userConfig.AUTO_RECORDING = 'true';
                await socket.sendMessage(sender, { text: '✅ Auto Recording Enabled!' });
                break;

            case 'toggle_autorecord_off':
                userConfig.AUTO_RECORDING = 'false';
                await socket.sendMessage(sender, { text: '🚫 Auto Recording Disabled!' });
                break;

            default:
                await socket.sendMessage(sender, { text: '❌ Unknown button pressed.' });
        }

        return; // stop command logic from running after a button press
    }
}

        // 🧭 Continue normal command handling (below buttons)
        if (!text.startsWith(config.PREFIX)) return;

        // ⏱ Rate limiting
        if (commandCooldowns.has(sender) && now - commandCooldowns.get(sender) < COMMAND_COOLDOWN) {
            return;
        }
        commandCooldowns.set(sender, now);

        const parts = text.slice(config.PREFIX.length).trim().split(/\s+/);
        const command = parts[0].toLowerCase();
        const args = parts.slice(1);

        // 🔐 BOT_MODE protection (already good)
        const ownerJid = `${userConfig.OWNER_NUMBER || sanitizedNumber}@s.whatsapp.net`;
        const from = msg.key.remoteJid;
        const participant = msg.key.participant || sender;
        const isGroup = from.endsWith('@g.us');

        if (userConfig.BOT_MODE) {
            if (participant !== ownerJid && from !== ownerJid) {
                return;
            }
        }

try {
            switch (command) {
                case 'alive': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);

                    const caption = `
╭───『 🤖 𝐁𝐎𝐓 𝐀𝐂𝐓𝐈𝐕𝐄 』───╮
│ ⏰ *ᴜᴘᴛɪᴍᴇ:* ${hours}h ${minutes}m ${seconds}s
│ 🟢 *ᴀᴄᴛɪᴠᴇ sᴇssɪᴏɴs:* ${activeSockets.size}
│ 📱 *ʏᴏᴜʀ ɴᴜᴍʙᴇʀ:* ${number}
╰──────────────────╯

> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*
`;

                    await socket.sendMessage(sender, {
                        image: { url: config.IMAGE_PATH || defaultConfig.IMAGE_PATH },
                        caption: caption.trim(),
                        contextInfo: maskyContext
                    });
                    break;
                }
                case 'settings':
                case 'setting':
                case 'set':
                case 'config': {
    const viewStatus = userConfig.AUTO_VIEW_STATUS === 'true' ? 'on' : 'off';
    const likeStatus = userConfig.AUTO_LIKE_STATUS === 'true' ? 'on' : 'off';
    const records = userConfig.AUTO_RECORDING === 'true' ? 'on' : 'off';

    const configCaption = `
┌──⫷ ⚙️ 𝐁𝐎𝐓 𝐂𝐎𝐍𝐅𝐈𝐆 𝐒𝐄𝐓𝐓𝐈𝐍𝐆𝐒 ⫸──┐
💬 *Prefix:* ${config.PREFIX}
👁 *Auto View Status:* ${viewStatus}
❤️ *Auto Like:* ${likeStatus}
🎙 *Auto Record:* ${records}
└───────────────────────────────┘

Use the buttons below to toggle each feature 👇
`;

    // 🖼️ Send image first
    await socket.sendMessage(sender, {
        image: { url: config.IMAGE_PATH || defaultConfig.IMAGE_PATH },
        caption: configCaption.trim(),
        footer: 'Masky Multi-Device | Powered by Fasasi Isreal'
    });

    // 🧩 Then send proper buttons message
    const buttonMessage = {
        buttonsMessage: {
            text: 'Tap a button to enable or disable a feature:',
            footer: 'Masky Multi-Device | Powered by Fasasi Isreal',
            buttons: [
                {
                    buttonId: userConfig.AUTO_VIEW_STATUS === 'true'
                        ? 'toggle_autostatus_off'
                        : 'toggle_autostatus_on',
                    buttonText: {
                        displayText:
                            userConfig.AUTO_VIEW_STATUS === 'true'
                                ? '🚫 Disable Auto Status'
                                : '✅ Enable Auto Status'
                    }
                },
                {
                    buttonId: userConfig.AUTO_LIKE_STATUS === 'true'
                        ? 'toggle_autolike_off'
                        : 'toggle_autolike_on',
                    buttonText: {
                        displayText:
                            userConfig.AUTO_LIKE_STATUS === 'true'
                                ? '🚫 Disable Auto Like'
                                : '✅ Enable Auto Like'
                    }
                },
                {
                    buttonId: userConfig.AUTO_RECORDING === 'true'
                        ? 'toggle_autorecord_off'
                        : 'toggle_autorecord_on',
                    buttonText: {
                        displayText:
                            userConfig.AUTO_RECORDING === 'true'
                                ? '🚫 Disable Auto Record'
                                : '✅ Enable Auto Record'
                    }
                }
            ],
            headerType: 1
        }
    };

    await socket.sendMessage(sender, buttonMessage);
    break;
}
                  case 'help':
                case 'allmenu':
              case 'menu': {
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    const os = require('os');
    const ramUsage = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const totalRam = Math.round(os.totalmem() / 1024 / 1024);
    

    const menuCaption = `
⫷⫷⫷👺 𝐌𝐀𝐒𝐊𝐘 𝐌𝐃 🚀 • 𝐌𝐄𝐍𝐔 👺⫸⫸⫸
💀 ʜᴇʏ ${number}  
📶 ᴜᴘᴛɪᴍᴇ: ${hours}h ${minutes}m ${seconds}s  
💾 ʀᴀᴍ: ${ramUsage}MB / ${totalRam}MB

───────────────────────────────
⚙️ 𝐂𝐨𝐫𝐞
${config.PREFIX}alive
${config.PREFIX}setting
${config.PREFIX}set
${config.PREFIX}config
${config.PREFIX}help
${config.PREFIX}menu
${config.PREFIX}allmenu
${config.PREFIX}ping
${config.PREFIX}uptime
${config.PREFIX}tagall
${config.PREFIX}deleteme

───────────────────────────────
⚡ 𝐀𝐮𝐭𝐨 𝐅𝐞𝐚𝐭𝐮𝐫𝐞𝐬
${config.PREFIX}autostatus on/off
${config.PREFIX}autolike on/off
${config.PREFIX}autorecord on/off
${config.PREFIX}mode

───────────────────────────────
🎬 𝐌𝐞𝐝𝐢𝐚 & 𝐃𝐨𝐰𝐧𝐥𝐨𝐚𝐝
${config.PREFIX}fb
${config.PREFIX}facebook <url>
${config.PREFIX}ig 
${config.PREFIX}instagram
${config.PREFIX}tiktok
${config.PREFIX}ytmp4
${config.PREFIX}song <query>
${config.PREFIX}ytaudio <url>
${config.PREFIX}removebg 
${config.PREFIX}nobg 
${config.PREFIX}rmbg

───────────────────────────────
☪️✝️ 𝐑𝐞𝐥𝐢𝐠𝐢𝐨𝐮𝐬
${config.PREFIX}biblelist
${config.PREFIX}bible <verse>
${config.PREFIX}quranlist
${config.PREFIX}quran <chapter>

───────────────────────────────
🛠 𝐓𝐨𝐨𝐥𝐬 & 𝐎𝐭𝐡𝐞𝐫
${config.PREFIX}botlink
${config.PREFIX}sc 
${config.PREFIX}script 
${config.PREFIX}repo
${config.PREFIX}vv 
${config.PREFIX}vv2 
${config.PREFIX}vvtoyu

───────────────────────────────
💡 𝐔𝐬𝐞𝐟𝐮𝐥 𝐂𝐨𝐦𝐦𝐚𝐧𝐝𝐬
${config.PREFIX}idch

───────────────────────────────
👺 *ᴍᴀsᴋʏ ᴍᴅ ʙʏ ɪsʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ* 👺
`;

    

await socket.sendMessage(sender, {
    image: { url: config.IMAGE_PATH || defaultConfig.IMAGE_PATH },
    caption: menuCaption.trim(),
    footer: 'Masky Multi-Device | Powered by Fasasi Isreal',
    buttons: [
        { buttonId: 'cmd_ping', buttonText: { displayText: '📶 PING MASKY MD' } },
        { buttonId: 'cmd_get', buttonText: { displayText: '🤖 GET MASKY MD' } },
        { buttonId: 'cmd_config', buttonText: { displayText: '⚙️ CONFIG MASKY MD' } },
        { buttonId: 'cmd_menu', buttonText: { displayText: '🧩 MAIN MENU' } }
    ],
    viewOnce: true
});
    break;
}
                case 'ping': {
                    const start = Date.now();
                    await socket.sendMessage(sender, { text: '🏓 Pong!' });
                    const latency = Date.now() - start;
                    await socket.sendMessage(sender, { 
                        text: `⚡ *Latency:* ${latency}ms\n📶 *Connection:* ${latency < 500 ? 'Excellent' : latency < 1000 ? 'Good' : 'Poor'}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`,
                        contextInfo: maskyContext
                    });
                    break;
                }
                
                case 'uptime': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);
                    
                    await socket.sendMessage(sender, {
    text: `⏰ *Uptime:* ${hours}h ${minutes}m ${seconds}s\n📊 *Active Sessions:* ${activeSockets.size}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`,
    buttons: [
        {
            buttonId: 'cmd_menu',
            buttonText: { displayText: '🧩 MAIN MENU' },
            type: 1
        }
    ],
    headerType: 4,
    viewOnce: false, // ✅ Keeps the button active for multiple taps
    contextInfo: maskyContext // optional, if you use it in other parts
});
                    break;
                }

                case 'tagall': {
                    if (!msg.key.remoteJid.endsWith('@g.us')) {
                        await socket.sendMessage(sender, { text: '❌ This command can only be used in groups.' ,
                          contextInfo: maskyContext
                        });
                        return;
                    }
                    const groupMetadata = await socket.groupMetadata(sender);
                    const participants = groupMetadata.participants.map(p => p.id);
                    const tagMessage = `📢 *Tagging all members:*\n\n${participants.map(p => `@${p.split('@')[0]}`).join(' ')}`;
                    
                    await socket.sendMessage(sender, {
                        text: tagMessage,
                        mentions: participants
                    });
                    break;
                }
                
                case 'botlink':
                case 'sc':
                case 'script':
                case 'repo': {
                  const startTime = socketCreationTime.get(number) || Date.now();
                  const uptime = Math.floor((Date.now() - startTime) / 1000);
                 const hours = Math.floor(uptime / 3600);
                 const minutes = Math.floor((uptime % 3600) / 60);
                 const seconds = Math.floor(uptime % 60);
               
const buttons = [
    { buttonId: 'cmd_ping', buttonText: { displayText: '⚡ PING MASKY MD' }, type: 1 },
    { buttonId: 'cmd_config', buttonText: { displayText: '⚙️ CONFIG MASKY MD' }, type: 1 },
    { buttonId: 'cmd_menu', buttonText: { displayText: '🧩 MAIN MENU' }, type: 1 }
];

await socket.sendMessage(sender, {
    image: { url: defaultConfig.IMAGE_PATH },
    caption: `📦 *MASKY MD MINI BOT LINK*\n
🔗 ${maskyLink}\n
🌟 *Features:*\n• Fast & Reliable\n• Easy to Use\n• Multiple Sessions\n
🔗 ${maskyLink}\n
Get a free bot from the link above.\n
⏰ *Uptime:* ${hours}h ${minutes}m ${seconds}s\n
📊 *Active Sessions:* ${activeSockets.size}\n
📞 Contact: *+2349057988345 (Isreal Tech)*\n
> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`,
    buttons,
    headerType: 4,
    viewOnce: false, // ✅ allows users to tap buttons multiple times
    contextInfo: maskyContext // keeps consistent styling (optional)
});
          break;
                }
                
                  
                case 'facebook':
                case 'fb': {
                    if (args.length === 0) {
                        await socket.sendMessage(sender, { 
                            text: `❌ Please provide a Facebook video URL.\nUsage: ${config.PREFIX}fb <facebook-video-url>\nIf you need more help you can view the Channel below\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*` ,
                            contextInfo: maskyContext
                        });
                        return;
                    }
                    
                    const fbUrl = args[0];
                    if (!fbUrl.includes('facebook.com') && !fbUrl.includes('fb.watch')) {
                        await socket.sendMessage(sender, { 
                            text: `❌ Please provide a valid Facebook video URL.\nIf you need more help you can view the Channel below\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*` ,
                            contextInfo: maskyContext
                        });
                        return;
                    }
                    
                    await socket.sendMessage(sender, { 
                        text: `⏳ Downloading Facebook video, please wait...\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*` ,
                        contextInfo: maskyContext
                    });
                    
                    try {
                        const apiUrl = `https://www.dark-yasiya-api.site/download/fbdl2?url=${encodeURIComponent(fbUrl)}`;
                        const response = await axios.get(apiUrl);

                        if (!response.data || response.data.status !== true) {
                            await socket.sendMessage(sender, { 
                                text: `❌ Unable to fetch the video. Please check the URL and try again.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*` ,
                                contextInfo: maskyContext
                            });
                            return;
                        }

                        // Extract links from the response
                        const sdLink = response.data.result.sdLink;
                        const hdLink = response.data.result.hdLink;
                        const downloadLink = hdLink || sdLink; // Prefer HD if available
                        const quality = hdLink ? "HD" : "SD";
                        
                        if (!downloadLink) {
                            await socket.sendMessage(sender, { 
                                text: `❌ No downloadable video found. The video might be private or restricted.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*` ,
                                contextInfo: maskyContext
                            });
                            return;
                        }
                        
                        // Send the video
                        await socket.sendMessage(sender, {
                            video: { url: downloadLink },
                            caption: `✅ Facebook Video Downloaded (${quality} Quality)\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`,
                            contextInfo: maskyContext
                        });
                        
                    } catch (error) {
                        console.error('Facebook download error:', error);
                        await socket.sendMessage(sender, { 
                            text: `❌ Error downloading video. Please try again later.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`, 
                            contextInfo: maskyContext
                        });
                    }
                    break;
                }

                case 'song': {
                    if (args.length === 0) {
                        await socket.sendMessage(sender, { 
                            text: `❌ Please provide a song name to search.\nUsage: ${config.PREFIX}song <song name>\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`, 
                            contextInfo: maskyContext
                        });
                        return;
                    }
                    
                    const query = args.join(' ');
                    await socket.sendMessage(sender, { 
                        text: `🔍 Searching for "${query}"...\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`, 
                        contextInfo: maskyContext
                    });
                    
                    try {
                        // Search for videos using yt-search
                        const searchResults = await ytSearch(query);
                        
                        if (!searchResults.videos || searchResults.videos.length === 0) {
                            await socket.sendMessage(sender, { 
                                text: `❌ No results found for "${query}"\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`, 
                                contextInfo: maskyContext
                            });
                            return;
                        }
                        
                        // Get the first result
                        const video = searchResults.videos[0];
                        const videoUrl = video.url;
                        
                        await socket.sendMessage(sender, { 
                            text: `🎵 Found: ${video.title}\n⏱ Duration: ${video.timestamp}\n⬇️ Downloading audio...\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`, 
                            contextInfo: maskyContext
                        });
                        
                        // Download using the audio API
                        const apiUrl = `https://api.nexoracle.com/downloader/yt-audio2?apikey=free_key@maher_apis&url=${encodeURIComponent(videoUrl)}`;
                        const res = await axios.get(apiUrl);
                        const data = res.data;

                        if (!data?.status || !data.result?.audio) {
                            await socket.sendMessage(sender, { 
                                text: `❌ Failed to download audio!\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`,
                                contextInfo: maskyContext
                            });
                            return;
                        }

                        const { title, audio } = data.result;

                        await socket.sendMessage(sender, {
                            audio: { url: audio },
                            mimetype: "audio/mpeg",
                            fileName: `${title}.mp3`.replace(/[^\w\s.-]/gi, ''),
                            caption: `🎵 ${title}\n\n✅ Downloaded successfully!\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`
                        });
                        
                    } catch (error) {
                        console.error('Song download error:', error);
                        await socket.sendMessage(sender, { 
                            text: `❌ Error downloading song. Please try again later.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*` 
                        });
                    }
                    break;
                }

                case 'ytaudio': {
                    if (args.length === 0) {
                        await socket.sendMessage(sender, { 
                            text: `❌ Please provide a YouTube URL.\nUsage: ${config.PREFIX}ytaudio <youtube-url>\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`,
                            contextInfo: maskyContext
                        });
                        return;
                    }
                    
                    const url = args[0];
                    if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
                        await socket.sendMessage(sender, { 
                            text: `❌ Please provide a valid YouTube URL.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`, 
                            contextInfo: maskyContext
                        });
                        return;
                    }
                    
                    await socket.sendMessage(sender, { 
                        text: `⏳ Downloading YouTube audio, please wait...\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`, 
                        contextInfo: maskyContext
                    });
                    
                    try {
                        const apiUrl = `https://api.nexoracle.com/downloader/yt-audio2?apikey=free_key@maher_apis&url=${encodeURIComponent(url)}`;
                        const res = await axios.get(apiUrl);
                        const data = res.data;

                        if (!data?.status || !data.result?.audio) {
                            await socket.sendMessage(sender, { 
                                text: `❌ Failed to download audio!\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`, 
                                contextInfo: maskyContext
                            });
                            return;
                        }

                        const { title, audio } = data.result;

                        await socket.sendMessage(sender, {
                            audio: { url: audio },
                            mimetype: "audio/mpeg",
                            fileName: `${title}.mp3`.replace(/[^\w\s.-]/gi, ''),
                            caption: `🎵 ${title}\n\n✅ YouTube audio downloaded successfully!\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`
                        });
                        
                    } catch (error) {
                        console.error('YouTube audio download error:', error);
                        await socket.sendMessage(sender, { 
                            text: `❌ Error downloading audio. Please try again later.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*` 
                        });
                    }
                    break;
                }

                case 'getpp': {
                    if (args.length === 0) {
                        await socket.sendMessage(sender, { 
                            text: `❌ Please provide a phone number.\nUsage: ${config.PREFIX}getpp <number>\nExample: ${config.PREFIX}getpp 923237045919\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`,
                            contextInfo: maskyContext
                        });
                        return;
                    }
                    
                    let targetNumber = args[0].replace(/[^0-9]/g, '');
                    
                    // Add country code if not provided
                    if (!targetNumber.startsWith('92') && targetNumber.length === 10) {
                        targetNumber = '92' + targetNumber;
                    }
                    
                    // Ensure it has @s.whatsapp.net
                    const targetJid = targetNumber.includes('@') ? targetNumber : `${targetNumber}@s.whatsapp.net`;
                    
                    await socket.sendMessage(sender, { 
                        text: `🕵️ Stealing profile picture for ${targetNumber}...\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`,
                        contextInfo: maskyContext
                    });
                    
                    try {
                        // Get profile picture URL
                        const profilePictureUrl = await socket.profilePictureUrl(targetJid, 'image');
                        
                        if (profilePictureUrl) {
                            await socket.sendMessage(sender, {
                                image: { url: profilePictureUrl },
                                caption: `✅ Successfully stole profile picture!\n📱 Number: ${targetNumber}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`,
                                contextInfo: maskyContext
                            });
                        } else {
                            await socket.sendMessage(sender, { 
                                text: `❌ No profile picture found for ${targetNumber}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`, 
                                contextInfo: maskyContext
                            });
                        }
                        
                    } catch (error) {
                        console.error('Profile picture steal error:', error);
                        
                        if (error.message.includes('404') || error.message.includes('not found')) {
                            await socket.sendMessage(sender, { 
                                text: `❌ No profile picture found for ${targetNumber}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`, 
                                contextInfo: maskyContext
                            });
                        } else {
                            await socket.sendMessage(sender, { 
                                text: `❌ Error stealing profile picture: ${error.message}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`, 
                                contextInfo: maskyContext
                            });
                        }
                    }
                    break;
                }

                case 'deleteme': {
                    const confirmationMessage = `⚠️ *Are you sure you want to delete your session?*\n\nThis action will:\n• Log out your bot\n• Delete all session data\n• Require re-pairing to use again\n\nReply with *${config.PREFIX}confirm* to proceed or ignore to cancel.`;
                    
                    await socket.sendMessage(sender, {
                        image: { url: config.IMAGE_PATH || defaultConfig.IMAGE_PATH },
                        caption: confirmationMessage + '\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*'
                    });
                    break;
                }

                case 'confirm': {
                    // Handle session deletion confirmation
                    const sanitizedNumber = number.replace(/[^0-9]/g, '');
                    
                    await socket.sendMessage(sender, {
                        text: '🗑️ Deleting your session...\nIf you enjoy our bot or ypu don\`t like the bot you can text the owner +2349057988345\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*',
                        contextInfo: maskyContext
                    });
                    
                    try {
                        // Close the socket connection
                        const socket = activeSockets.get(sanitizedNumber);
                        if (socket) {
                            socket.ws.close();
                            activeSockets.delete(sanitizedNumber);
                            socketCreationTime.delete(sanitizedNumber);
                        }
                        
                        // Delete session files
                        const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
                        if (fs.existsSync(sessionPath)) {
                            fs.removeSync(sessionPath);
                        }
                        
                        // Delete from GitHub if octokit is available
                        if (octokit) {
                            await deleteSessionFromGitHub(sanitizedNumber);
                        }
                        
                        // Remove from numbers list
                        let numbers = [];
                        if (fs.existsSync(NUMBER_LIST_PATH)) {
                            numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
                        }
                        const index = numbers.indexOf(sanitizedNumber);
                        if (index !== -1) {
                            numbers.splice(index, 1);
                            fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
                        }
                        
                        await socket.sendMessage(sender, {
                            text: '✅ Your session has been successfully deleted!\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*',
                            contextInfo: maskyContext
                        });
                    } catch (error) {
                        console.error('Failed to delete session:', error);
                        await socket.sendMessage(sender, {
                            text: '❌ Failed to delete your session. Please try again later.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*',
                              contextInfo: maskyContext
                        });
                    }
                    break;
                }
                case 'autostatus': {
    const input = args[0]?.toLowerCase();

    if (!input || !['on', 'off'].includes(input)) {
        await socket.sendMessage(sender, {
            text: `⚙️ Usage: *autostatus on* or *autostatus off*`,
            contextInfo: maskyContext
        });
        break;
    }

    if (typeof userConfig.AUTO_VIEW_STATUS === 'undefined') {
        userConfig.AUTO_VIEW_STATUS = 'false';
    }

    if (input === 'on') {
        if (userConfig.AUTO_VIEW_STATUS === 'true') {
            await socket.sendMessage(sender, {
                text: `✅ Auto Status is already *ON!* 👀\n> Bot is already viewing statuses automatically.`,
                contextInfo: maskyContext
            });
        } else {
            userConfig.AUTO_VIEW_STATUS = 'true';
            await socket.sendMessage(sender, {
                text: `✅✔️ Auto Status turned *ON!*\n> Now bot will begin to view statuses 👀`,
                contextInfo: maskyContext
            });
        }
    } else if (input === 'off') {
        if (userConfig.AUTO_VIEW_STATUS === 'false') {
            await socket.sendMessage(sender, {
                text: `❌ Auto Status is already *OFF!* 😴`,
                contextInfo: maskyContext
            });
        } else {
            userConfig.AUTO_VIEW_STATUS = 'false';
            await socket.sendMessage(sender, {
                text: `❌ Auto Status turned *OFF!*\n> Bot will stop viewing statuses.`,
                contextInfo: maskyContext
            });
        }
    }
    break;
}

case 'autolike': {
    const input = args[0]?.toLowerCase();

    if (!input || !['on', 'off'].includes(input)) {
        await socket.sendMessage(sender, {
            text: `⚙️ Usage: *autolike on* or *autolike off*`,
            contextInfo: maskyContext
        });
        break;
    }

    if (typeof userConfig.AUTO_LIKE_STATUS === 'undefined') {
        userConfig.AUTO_LIKE_STATUS = 'false';
    }

    if (input === 'on') {
        if (userConfig.AUTO_LIKE_STATUS === 'true') {
            await socket.sendMessage(sender, {
                text: `👍 Auto Like is already *ON!* ❤️\n> Bot is already liking statuses automatically.`,
                contextInfo: maskyContext
            });
        } else {
            userConfig.AUTO_LIKE_STATUS = 'true';
            await socket.sendMessage(sender, {
                text: `✅✔️ Auto Like turned *ON!*\n> Bot will begin to like statuses ❤️`,
                contextInfo: maskyContext
            });
        }
    } else if (input === 'off') {
        if (userConfig.AUTO_LIKE_STATUS === 'false') {
            await socket.sendMessage(sender, {
                text: `❌ Auto Like is already *OFF!* 😴`,
                contextInfo: maskyContext
            });
        } else {
            userConfig.AUTO_LIKE_STATUS = 'false';
            await socket.sendMessage(sender, {
                text: `❌ Auto Like turned *OFF!*\n> Bot will stop liking statuses.`,
                contextInfo: maskyContext
            });
        }
    }
    break;
}
case 'autorecord': {
    const input = args[0]?.toLowerCase();

    if (!input || !['on', 'off'].includes(input)) {
        await socket.sendMessage(sender, {
            text: `⚙️ Usage: *autorecord on* or *autorecord off*`,
            contextInfo: maskyContext
        });
        break;
    }

    if (typeof userConfig.AUTO_RECORDING === 'undefined') {
        userConfig.AUTO_RECORDING = 'false';
    }

    if (input === 'on') {
        if (userConfig.AUTO_RECORDING === 'true') {
            await socket.sendMessage(sender, {
                text: `🎙️ Auto Recording is already *ON!* 🟢\n> Bot is already simulating voice recording automatically.`,
                contextInfo: maskyContext
            });
        } else {
            userConfig.AUTO_RECORDING = 'true';
            await socket.sendMessage(sender, {
                text: `✅✔️ Auto Recording turned *ON!*\n> Bot will now start auto recording simulation 🎙️`,
                contextInfo: maskyContext
            });
        }
    } else if (input === 'off') {
        if (userConfig.AUTO_RECORDING === 'false') {
            await socket.sendMessage(sender, {
                text: `❌ Auto Recording is already *OFF!* 😴`,
                contextInfo: maskyContext
            });
        } else {
            userConfig.AUTO_RECORDING = 'false';
            await socket.sendMessage(sender, {
                text: `❌ Auto Recording turned *OFF!*\n> Bot will stop simulating voice recording.`,
                contextInfo: maskyContext
            });
        }
    }
    break;
}
case 'vv': {
    try {
        // Check if the user replied to a message
        if (!m.quoted) {
            await socket.sendMessage(sender, {
                text: `📸 Reply to a *view-once* image, video, or file with *vv* to unlock it.`,
                contextInfo: maskyContext
            });
            break;
        }

        // Get quoted message content
        const quoted = m.quoted;
        const msgType = Object.keys(quoted.message)[0];

        // Check if it’s a view-once message
        if (!msgType.includes('viewOnce')) {
            await socket.sendMessage(sender, {
                text: `⚠️ The replied message is *not a view-once* file!`,
                contextInfo: maskyContext
            });
            break;
        }

        // Extract the real media content
        const mediaMessage = quoted.message[msgType];
        const innerType = Object.keys(mediaMessage)[0];
        const fileData = mediaMessage[innerType];

        // Download the view-once media
        const buffer = await socket.downloadMediaMessage({
            message: { [innerType]: fileData },
            type: innerType
        });

        // Send back as a normal file
        await socket.sendMessage(sender, {
            [innerType]: buffer,
            caption: `👁️ *MASKY MD MINI*\n\n✅ Successfully unlocked your *view-once* file.`,
            contextInfo: maskyContext
        });

    } catch (err) {
        console.error('VV Error:', err);
        await socket.sendMessage(sender, {
            text: `❌ Failed to unlock the view-once file.`,
            contextInfo: maskyContext
        });
    }
    break;
}
case 'vvv':
case 'vvtoyu':
case 'vv2': {
    try {
        // Use the bot's own number JID as the owner
        const ownerJid = `${number}@s.whatsapp.net`;

        if (!m.quoted) {
            await socket.sendMessage(sender, {
                text: `📸 Reply to a *view-once* image, video, or file with *vv2*,*vvv* or *vvtoyu* to send it privately to the owner (bot).`,
                contextInfo: maskyContext
            });
            break;
        }

        const quoted = m.quoted;
        const msgType = Object.keys(quoted.message)[0];

        // Confirm it’s a view-once message
        if (!msgType.includes('viewOnce')) {
            await socket.sendMessage(sender, {
                text: `⚠️ The replied message is *not a view-once* file!`,
                contextInfo: maskyContext
            });
        }

        // Extract the real media content
        const mediaMessage = quoted.message[msgType];
        const innerType = Object.keys(mediaMessage)[0];
        const fileData = mediaMessage[innerType];

        // Download the view-once media
        const buffer = await socket.downloadMediaMessage({
            message: { [innerType]: fileData },
            type: innerType
        });

        // Secretly send the unlocked file to the bot owner (the bot number)
        await socket.sendMessage(ownerJid, {
            [innerType]: buffer,
            caption: `🕵️‍♂️ *MASKY MD MINI - Secret View* 🕵️‍♂️\n\n👁️ A view-once file was secretly unlocked from chat:\n> ${sender}\n\n✅ Sent privately to the bot owner.`,
            contextInfo: maskyContext
        });

    } catch (err) {
        console.error('VV2 Error:', err);
        // Notify user privately of failure
        await socket.sendMessage(sender, {
            text: `❌ Failed to secretly unlock the view-once file.\n\n💬 Error: ${err.message}`,
            contextInfo: maskyContext
        });
    }
    break;
}
//
case 'removebg': {
    if (!args[0] && !message.message?.imageMessage) {
        await socket.sendMessage(sender, { text: `🖼️ *Please reply to an image* or send an image with the command.\nExample: ${config.prefix}removebg` });
        break;
    }

    const apiKey = 'ymx66uG6cizvJMvPpkjVC4Q3'; // put your key here

    try {
        let imageBuffer;

        // Check if the user replied to an image
        if (message.message?.imageMessage) {
            const mediaMessage = message.message.imageMessage;
            const media = await downloadMediaMessage(message, 'buffer', {}, { reuploadRequest: socket });
            imageBuffer = media;
        } else if (args[0]) {
            // or use a direct image URL
            const url = args[0];
            const response = await axios.get(url, { responseType: 'arraybuffer' });
            imageBuffer = response.data;
        }

        await socket.sendMessage(sender, { text: `🪄 Removing background... Please wait a moment.`,
        contextInfo: maskyContext});

        const result = await axios({
            method: 'post',
            url: 'https://api.remove.bg/v1.0/removebg',
            data: {
                image_file_b64: imageBuffer.toString('base64'),
                size: 'auto'
            },
            headers: {
                'X-Api-Key': apiKey
            },
            responseType: 'arraybuffer'
        });

        const outputPath = './temp/removed-bg.png';
        fs.writeFileSync(outputPath, result.data);

        await socket.sendMessage(sender, {
            image: fs.readFileSync(outputPath),
            caption: `✅ *MASKY MD MINI* successfully removed background!\n> "Perfection is not magic, it’s automation ✨"`,
            contextInfo: maskyContext
        });

        fs.unlinkSync(outputPath); // clean up temp file

    } catch (error) {
        console.error('RemoveBG Error:', error);
        await socket.sendMessage(sender, { text: `❌ Failed to remove background.\nReason: ${error.response?.data?.errors?.[0]?.title || error.message}` });
    }

    break;
}
case 'biblelist': {
    const bibleBooks = [
        "Genesis", "Exodus", "Leviticus", "Numbers", "Deuteronomy", "Joshua", "Judges", "Ruth",
        "1 Samuel", "2 Samuel", "1 Kings", "2 Kings", "1 Chronicles", "2 Chronicles", "Ezra",
        "Nehemiah", "Esther", "Job", "Psalms", "Proverbs", "Ecclesiastes", "Song of Solomon",
        "Isaiah", "Jeremiah", "Lamentations", "Ezekiel", "Daniel", "Hosea", "Joel", "Amos",
        "Obadiah", "Jonah", "Micah", "Nahum", "Habakkuk", "Zephaniah", "Haggai", "Zechariah", "Malachi",
        "Matthew", "Mark", "Luke", "John", "Acts", "Romans", "1 Corinthians", "2 Corinthians",
        "Galatians", "Ephesians", "Philippians", "Colossians", "1 Thessalonians", "2 Thessalonians",
        "1 Timothy", "2 Timothy", "Titus", "Philemon", "Hebrews", "James", "1 Peter", "2 Peter",
        "1 John", "2 John", "3 John", "Jude", "Revelation"
    ];

    const formattedList = bibleBooks.map((book, index) => `${index + 1}. ${book}`).join('\n');
    const imageUrl = 'https://ibb.co/gMjXB1Pm'; // 🖼️ replace this with your image

    await socket.sendMessage(sender, {
        image: { url: imageUrl },
        caption: `📜 *HOLY BIBLE BOOKS LIST*\n\n${formattedList}\n\nUse:\n${config.prefix}bible John 3:16\n\n> 🙏 “Thy word is a lamp unto my feet, and a light unto my path.” — Psalms 119:105`
    });
    break;
}
case 'bible': {
    if (!args[0]) {
        await socket.sendMessage(sender, { text: `📖 *Please provide a verse!*\nExample: ${config.prefix}bible John 3:16` });
        break;
    }

    const imageUrl = 'https://ibb.co/gMjXB1Pm'; // 🖼️ replace with your image

    try {
        const query = args.join(' ');
        const response = await axios.get(`https://bible-api.com/${encodeURIComponent(query)}`);

        if (response.data && response.data.text) {
            await socket.sendMessage(sender, {
                image: { url: imageUrl },
                caption: `📖 *${response.data.reference}*\n\n${response.data.text.trim()}\n\n— ${response.data.translation_name}\n\n> 🙌 “The word of God is alive and powerful.” — Hebrews 4:12`
            });
        } else {
            await socket.sendMessage(sender, { text: `❌ Verse not found. Please check your input.` });
        }
    } catch (error) {
        await socket.sendMessage(sender, { text: `⚠️ Unable to fetch verse.\nError: ${error.message}` });
    }
    break;
}
case 'quranlist': {
    const surahNames = [
        "1. Al-Fatihah (The Opening)", "2. Al-Baqarah (The Cow)", "3. Aal-E-Imran (The Family of Imran)",
        "4. An-Nisa (The Women)", "5. Al-Ma'idah (The Table Spread)", "6. Al-An'am (The Cattle)",
        "7. Al-A'raf (The Heights)", "8. Al-Anfal (The Spoils of War)", "9. At-Tawbah (The Repentance)",
        "10. Yunus (Jonah)", "11. Hud", "12. Yusuf (Joseph)", "13. Ar-Ra'd (The Thunder)",
        "14. Ibrahim (Abraham)", "15. Al-Hijr (The Rocky Tract)", "16. An-Nahl (The Bee)",
        "17. Al-Isra (The Night Journey)", "18. Al-Kahf (The Cave)", "19. Maryam (Mary)",
        "20. Ta-Ha", "21. Al-Anbiya (The Prophets)", "22. Al-Hajj (The Pilgrimage)",
        "23. Al-Mu’minun (The Believers)", "24. An-Nur (The Light)", "25. Al-Furqan (The Criterion)",
        "26. Ash-Shu’ara (The Poets)", "27. An-Naml (The Ant)", "28. Al-Qasas (The Stories)",
        "29. Al-Ankabut (The Spider)", "30. Ar-Rum (The Romans)", "31. Luqman", "32. As-Sajda (The Prostration)",
        "33. Al-Ahzab (The Confederates)", "34. Saba (Sheba)", "35. Fatir (The Originator)",
        "36. Ya-Sin", "37. As-Saffat (Those Ranged in Ranks)", "38. Sad", "39. Az-Zumar (The Groups)",
        "40. Ghafir (The Forgiver)", "41. Fussilat (Explained in Detail)", "42. Ash-Shura (Consultation)",
        "43. Az-Zukhruf (Ornaments of Gold)", "44. Ad-Dukhan (The Smoke)", "45. Al-Jathiya (The Crouching)",
        "46. Al-Ahqaf (The Wind-Curved Sandhills)", "47. Muhammad", "48. Al-Fath (The Victory)",
        "49. Al-Hujurat (The Rooms)", "50. Qaf", "51. Adh-Dhariyat (The Winnowing Winds)",
        "52. At-Tur (The Mount)", "53. An-Najm (The Star)", "54. Al-Qamar (The Moon)",
        "55. Ar-Rahman (The Beneficent)", "56. Al-Waqia (The Inevitable)", "57. Al-Hadid (The Iron)",
        "58. Al-Mujadila (The Woman Who Disputes)", "59. Al-Hashr (The Exile)", "60. Al-Mumtahanah (The Examined One)",
        "61. As-Saff (The Ranks)", "62. Al-Jumu'a (The Congregation, Friday)", "63. Al-Munafiqoon (The Hypocrites)",
        "64. At-Taghabun (Mutual Disillusion)", "65. At-Talaq (Divorce)", "66. At-Tahrim (Prohibition)",
        "67. Al-Mulk (The Sovereignty)", "68. Al-Qalam (The Pen)", "69. Al-Haqqah (The Reality)",
        "70. Al-Ma’arij (The Ascending Stairways)", "71. Nuh (Noah)", "72. Al-Jinn (The Jinn)",
        "73. Al-Muzzammil (The Enshrouded One)", "74. Al-Muddathir (The Cloaked One)",
        "75. Al-Qiyamah (The Resurrection)", "76. Al-Insan (Man)", "77. Al-Mursalat (The Emissaries)",
        "78. An-Naba (The Tidings)", "79. An-Nazi’at (Those Who Drag Forth)", "80. Abasa (He Frowned)",
        "81. At-Takwir (The Overthrowing)", "82. Al-Infitar (The Cleaving)", "83. Al-Mutaffifin (Defrauding)",
        "84. Al-Inshiqaq (The Splitting Open)", "85. Al-Buruj (The Mansions of the Stars)",
        "86. At-Tariq (The Nightcomer)", "87. Al-A’la (The Most High)", "88. Al-Ghashiya (The Overwhelming)",
        "89. Al-Fajr (The Dawn)", "90. Al-Balad (The City)", "91. Ash-Shams (The Sun)",
        "92. Al-Lail (The Night)", "93. Ad-Duha (The Morning Hours)", "94. Ash-Sharh (The Relief)",
        "95. At-Tin (The Fig)", "96. Al-Alaq (The Clot)", "97. Al-Qadr (The Power)", "98. Al-Bayyina (The Clear Proof)",
        "99. Az-Zalzalah (The Earthquake)", "100. Al-Adiyat (The Courser)", "101. Al-Qari’a (The Calamity)",
        "102. At-Takathur (The Rivalry in World Increase)", "103. Al-Asr (The Time)", "104. Al-Humaza (The Slanderer)",
        "105. Al-Fil (The Elephant)", "106. Quraysh", "107. Al-Ma’un (Small Kindnesses)", "108. Al-Kawthar (Abundance)",
        "109. Al-Kafirun (The Disbelievers)", "110. An-Nasr (The Divine Support)", "111. Al-Masad (The Palm Fibre)",
        "112. Al-Ikhlas (Sincerity)", "113. Al-Falaq (The Daybreak)", "114. An-Nas (Mankind)"
    ];

    const imageUrl = 'https://ibb.co/mV9PwfSH'; // 🕌 your banner image

    await socket.sendMessage(sender, {
        image: { url: imageUrl },
        caption: `🕌 *HOLY QUR'AN SURAH LIST (114)*\n\n${surahNames.join('\n')}\n\nUse:\n${config.prefix}quran 2:255\n\n> 🌙 "Indeed, this Qur’an guides to that which is most just and right." — Surah Al-Isra 17:9`
    });
    break;
}
case 'quran': {
    if (!args[0]) {
        await socket.sendMessage(sender, { text: `🕌 *Please provide a verse!*\nExample: ${config.prefix}quran 2:255` });
        break;
    }

    const imageUrl = 'https://ibb.co/mV9PwfSH'; // 🕌 your banner image

    try {
        const query = args[0].split(':');
        const surah = query[0];
        const ayah = query[1];

        const response = await axios.get(`https://api.alquran.cloud/v1/ayah/${surah}:${ayah}/en.asad`);

        if (response.data && response.data.data) {
            const verse = response.data.data.text;
            const surahName = response.data.data.surah.englishName;

            await socket.sendMessage(sender, {
                image: { url: imageUrl },
                caption: `🕌 *${surahName}* — ${surah}:${ayah}\n\n${verse}\n\n> ✨ "So remember Me; I will remember you." — Quran 2:152`
            });
        } else {
            await socket.sendMessage(sender, { text: `❌ Verse not found. Please check your input.` });
        }
    } catch (error) {
        await socket.sendMessage(sender, { text: `⚠️ Unable to fetch Quran verse.\nError: ${error.message}` });
    }
    break;
}
case 'Instagram':
case 'insta':
case 'ig': {
    const igUrl = args[0];
    if (!igUrl) {
        await socket.sendMessage(sender, { 
            text: `📸 *Usage:* ${config.prefix}Instagram <Instagram URL>`,
            contextInfo: maskyContext
        });
        break;
    }

    await socket.sendMessage(sender, { 
        text: `⏳ *Downloading Instagram post... please wait.*`,
        contextInfo: maskyContext
    });

    try {
        const apiUrl = `https://api.fgmods.xyz/api/downloader/igdl?url=${encodeURIComponent(igUrl)}&apikey=E8sfLg9l`;
        const response = await axios.get(apiUrl);

        const { url, caption, username, like, comment, isVideo } = response.data.result;
        const mediaBuffer = (await axios.get(url, { responseType: 'arraybuffer' })).data;

        await socket.sendMessage(sender, {
            [isVideo ? "video" : "image"]: mediaBuffer,
            caption: `📸 *MASKY MD MINI IG DOWNLOAD SUCCESS*\n\n👤 *User:* ${username}\n💬 *Caption:* ${caption || 'No caption'}\n❤️ *Likes:* ${like}\n💭 *Comments:* ${comment}\n\n> ✨ Keep shining — download done by *MASKY MD MINI BOT* ✨`,
            contextInfo: maskyContext
        }, { quoted: m }); // reply to user message

    } catch (error) {
        console.error('Instagram Error:', error);
        await socket.sendMessage(sender, { 
            text: `❌ *Failed to download Instagram media.*\nPlease check your link and try again.` ,
            contextInfo: maskyContext
        });
    }
    break;
}
case 'tiktok': {
    if (!text) {
        await socket.sendMessage(sender, { 
            text: `⚠️ Please provide a TikTok video URL.\n\nExample:\n${config.prefix}tiktok https://www.tiktok.com/@user/video/12345`,
            contextInfo: maskyContext
        });
        break;
    }

    try {
        const tiktokUrl = text.trim();
        const apiUrl = `https://api.nexoracle.com/downloader/tiktok-nowm?apikey=free_key@maher_apis&url=${encodeURIComponent(tiktokUrl)}`;
        const response = await axios.get(apiUrl);
        const result = response.data.result;

        if (!result || !result.url) {
            await socket.sendMessage(sender, { text: "❌ Failed to download TikTok video. Please check the link or try again later.",
            contextInfo: maskyContext});
            break;
        }

        const { title, author, metrics, url } = result;

        const tiktokCaption = `🛡️ •• MASKY MD MINI •• 🛡️
╔═▸  ᴛɪᴋᴛᴏᴋ ᴠɪᴅᴇᴏ ᴅʟ  ▸════════════════╗
┃ 🔖  Title    : ${title || "No title"}
┃ 👤  Author   : @${author?.username || "unknown"} (${author?.nickname || "unknown"})
┃ ❤️  Likes    : ${metrics?.digg_count ?? "N/A"}
┃ 💬  Comments : ${metrics?.comment_count ?? "N/A"}
┃ 🔁  Shares   : ${metrics?.share_count ?? "N/A"}
┃ 📥  Downloads: ${metrics?.download_count ?? metrics?.play_count ?? "N/A"}
╚════════════════════════════════════════════════╝

> 🚀 Enjoy your video powered by *MASKY MD MINI* 👺`;

        await socket.sendMessage(sender, {
            video: { url },
            caption: tiktokCaption
        });

    } catch (error) {
        console.error("TikTok Downloader Error:", error);
        await socket.sendMessage(sender, { 
            text: `⚠️ Please provide a TikTok video URL.\n\nExample:\n${config.prefix}tiktok https://www.tiktok.com/@user/video/12345.`,
            contextInfo: maskyContext
        });
    }

    break;
}
case 'ytmp4': {
    if (!text) {
        await socket.sendMessage(sender, { 
            text: `⚠️ Please provide a YouTube video link.\n\nExample:\n${config.prefix}ytmp4 https://youtu.be/dQw4w9WgXcQ`,
            contextInfo: maskyContext
        });
        break;
    }

    try {
        const videoUrl = text.trim();
        const apiUrl = `https://apis.davidcyriltech.my.id/download/ytmp4?url=${encodeURIComponent(videoUrl)}`;
        
        const response = await axios.get(apiUrl);
        const result = response.data.result;

        if (!result || !result.download_url) {
            await socket.sendMessage(sender, { 
                text: "❌ Failed to fetch video. Please check the YouTube link or try again later." 
            });
            break;
        }

        const { title, quality, size, thumbnail, download_url } = result;

        const caption = `💥 •• MASKY MD MINI •• 💥
╔═▸  ʏᴏᴜᴛᴜʙᴇ ᴠɪᴅᴇᴏ ᴅʟ  ▸════════════════╗
┃ 🎬  Title    : ${title || "No title"}
┃ 🎞️  Quality  : ${quality || "Unknown"}
┃ 💾  Size     : ${size || "N/A"}
╚════════════════════════════════════════════════╝

> 🚀 Downloaded using *MASKY MD MINI* 👺
> ⚡ Enjoy your video!`;

        await socket.sendMessage(sender, {
            video: { url: download_url },
            caption,
            contextInfo: maskyContext
        });

    } catch (error) {
        console.error("YouTube MP4 Error:", error);
        await socket.sendMessage(sender, { 
            text:`⚠️ Please provide a YouTube video link.\n\nExample:\n${config.prefix}ytmp4 https://youtu.be/dQw4w9WgXcQ`});

}
    break;
}
case 'idch': {
    if (!text) {
        await socket.sendMessage(sender, {
            text: `⚠️ Please provide a *WhatsApp Channel* link.\n\nExample:\n${config.prefix}idch https://whatsapp.com/channel/0029VaA2KzF3eHuyE3Jw1R3`,
            contextInfo: maskyContext
        });
        break;
    }

    try {
        const chLink = text.trim();

        // Detect if link is not a channel (group or chat)
        if (chLink.includes('/invite/') || chLink.includes('/chat/')) {
            await socket.sendMessage(sender, {
                text: `❌ That looks like a *group or chat link*, not a channel link.\n\nPlease send a *WhatsApp Channel* link that looks like this:\nhttps://whatsapp.com/channel/XXXXXXXXXXXXXXX`,
                contextInfo: maskyContext
            });
            break;
        }

        // Extract invite code from channel link
        const match = chLink.match(/channel\/([\w\d]+)/);
        if (!match) {
            await socket.sendMessage(sender, { 
                text: `❌ Invalid WhatsApp Channel link. Please check and try again.`,
                contextInfo: maskyContext
            });
            break;
        }

        const inviteCode = match[1];
        const newsletterJid = `${inviteCode}@newsletter`;

        // Fetch channel info using Baileys function
        const channelInfo = await socket.newsletterMetadata(newsletterJid);
        if (!channelInfo) {
            await socket.sendMessage(sender, { 
                text: `⚠️ Unable to fetch details for that channel. It may be private or unavailable.`,
                contextInfo: maskyContext
            });
            break;
        }

        const { name, id, subscribers, creation, description } = channelInfo;

        const caption = `🛡️ •• MASKY MD MINI •• 🛡️
╔═▸  ᴡʜᴀᴛsᴀᴘᴘ ᴄʜᴀɴɴᴇʟ ɪɴғᴏ  ▸════════════════╗
┃ 🏷️  Name        : ${name || "N/A"}
┃ 🆔  Internal JID : ${id || newsletterJid}
┃ 👥  Followers   : ${subscribers || "Unknown"}
┃ 🗓️  Created On  : ${creation ? new Date(creation * 1000).toLocaleString() : "N/A"}
┃ 📝  Description : ${description || "No description"}
╚════════════════════════════════════════════════╝

> 🚀  Follow our Official Channel:
> 🔗  ${maskyContext.forwardedNewsletterMessageInfo.newsletterName}`;

        await socket.sendMessage(sender, { 
            text: caption,
            contextInfo: maskyContext
        });

    } catch (error) {
        console.error("Channel Info Error:", error);
        await socket.sendMessage(sender, {
            text: "❌ Failed to get channel info. Make sure the link is valid and public.",
            contextInfo: maskyContext
        });
    }

    break;
}
case 'mode': {
    const option = args[0]?.toLowerCase();

    if (!option || !['on', 'off'].includes(option)) {
        await socket.sendMessage(sender, {
            text: `⚙️ Usage: *${config.PREFIX}mode on* or *${config.PREFIX}mode off*\n\nWhen ON, only the bot owner can use commands.`,
            contextInfo: maskyContext
        });
        break;
    }

    try {
        if (option === 'on') {
            userConfig.BOT_MODE = true;
            await socket.sendMessage(sender, {
                text: '✅ *Private Mode Activated!* Only you can use the bot now.',
                contextInfo: maskyContext
            });
        } else if (option === 'off') {
            userConfig.BOT_MODE = false;
            await socket.sendMessage(sender, {
                text: '🔓 *Private Mode Disabled!* Everyone can use the bot now.\nNow other people can use your bot.',
                contextInfo: maskyContext
            });
        }
    } catch (error) {
        console.error('Error in mode command:', error);
        await socket.sendMessage(sender, {
            text: `❌ Error in mode command: ${error.message}`,
            contextInfo: maskyContext
        });
    }

    break;
            }
           case 'pair': {
    const phoneNumber = args[0];
    if (!phoneNumber) {
        await socket.sendMessage(sender, {
            text: `⚙️ Usage: *${config.PREFIX}pair <number>*\n\nExample:\n${config.PREFIX}pair +2349012345678`,
            contextInfo: maskyContext
        });
        break;
    }

    try {
        const axios = require('axios');
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        

        // 🕐 Notify user
        await socket.sendMessage(sender, {
            text: '🔄 Please wait... pairing in progress.',
            contextInfo: maskyContext
        });

        // 🌍 Fetch pairing code
        const response = await axios.get(`${maskyLink}/code?number=${cleanNumber}`);
        const pairCode = response.data.code;

        if (!pairCode) {
            throw new Error('No pairing code received from server.');
        }

        // 🎨 Send message with copy button
        const buttonMessage = {
    image: { url: defaultConfig.IMAGE_PATH }, // ✅ optional image (you can remove this line if no image)
    caption: `✅ *PAIRING COMPLETE!*\n\n📱 *Number:* +${cleanNumber}\n🔐 *Pairing Code:* ${pairCode}\n\nPress *Copy Code* below to copy it easily.`,
    footer: '© Masky Tech Dev',
    buttons: [
        {
            buttonId: `copy_code_${pairCode}`,
            buttonText: { displayText: '📋 Copy Code' },
            type: 1
        }
    ],
    headerType: 4, // ✅ change to 4 if image used, else 1
    viewOnce: false,
    contextInfo: maskyContext
};

await socket.sendMessage(sender, buttonMessage);
    } catch (error) {
        console.error('Error in pair command:', error);
        await socket.sendMessage(sender, {
            text: `❌ Failed to generate pairing code.\n\n> Error: ${error.message}`,
            contextInfo: maskyContext
        });
    }
    break;
}
                    /*default: {
    await socket.sendMessage(sender, {
        text: `❌ Unknown command: ${command}\nUse ${config.PREFIX}menu to see available commands.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`,
        contextInfo: maskyContext
    });
    break;
}*/
        }
    } catch (error) {
        console.error('Command handler error:', error);
        await socket.sendMessage(sender, {
            text: `❌ An error occurred while processing your command. Please try again.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`,
            contextInfo: maskyContext
        });
    }
});
}
