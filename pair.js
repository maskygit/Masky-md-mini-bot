const axios = require('axios');
const ytSearch = require('yt-search');
const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const { Octokit } = require('@octokit/rest');
const moment = require('moment-timezone');
// 1. HTTP Client (Required for TikTok Multi-Scraper
const os = require('os'); 

// 2. Scraper Library (Required for TikTok & Instagram Downloaders)
// Based on the code, you need 'ttdl' and 'igdl' functions from 'ruhend-scraper'.
const { ttdl, igdl } = require("ruhend-scraper");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    downloadMediaMessage
    isJidGroup
    jidNormalizedUser
} = require('baileys');
const  getImage  = require('./masky.js');
// Default config structure
const defaultConfig = {
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'false',
    AUTO_LIKE_EMOJI: ['💥', '👍', '😍', '💗', '🎈', '🎉', '🥳', '😎', '🚀', '🔥'],
    PREFIX: '.',
    MAX_RETRIES: 3,
    ADMIN_LIST_PATH: './admin.json',
    IMAGE_PATH: getImage(),
    OWNER_NUMBER: ''
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
// --- GLOBAL IN-MEMORY ANTILINK HELPERS (Mandatory for Anti-link commands) ---

// 1. STORAGE: This object and the helper functions manage group settings and warnings.
const groupAntilinkConfigs = {}; 
const INITIAL_ANTILINK_CONFIG = {
    enabled: false, action: 'warn', warnLimit: 3, warnings: {}
};

function getGroupAntilinkConfig(groupId) {
    if (!groupAntilinkConfigs[groupId]) {
        groupAntilinkConfigs[groupId] = JSON.parse(JSON.stringify(INITIAL_ANTILINK_CONFIG));
    }
    return groupAntilinkConfigs[groupId];
}

function updateGroupAntilinkConfig(groupId, updates) {
    const currentConfig = getGroupAntilinkConfig(groupId);
    Object.assign(currentConfig, updates);
    if (updates.enabled === false) {
        currentConfig.warnings = {};
    }
}

// 2. ACTION HANDLERS: These functions execute the warn/kick logic.
// You must define handleAntilinkKick, handleAntilinkDelete, and handleAntilinkWarn 
// (or ensure they are imported from your own internal files). 
// If they are not imported, they MUST be defined globally for the command cases to work.
// (The definitions were provided in the previous two responses).

// --- END ANTILINK HELPERS ---

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
            // --- 1. React to the status (Your original code) ---
            await socket.sendMessage(
                message.key.remoteJid, // This is 'status@broadcast'
                { react: { text: randomEmoji, key: message.key } },
                { statusJidList: [message.key.participant] } // Specifies *who* to react to
            );
            lastStatusInteraction = now;
            console.log(`Reacted to status with ${randomEmoji} for ${message.key.participant}`);
            
            // --- 2. Send the follow-up message (New functionality) ---
            try {
                const replyMessage = "MASKY MD has view your status successfully and liked you status";
                
                // As requested, here is the contextInfo structure.
                // Fill in your channel details in the placeholders below.

                // Send the text message directly to the user
                await socket.sendMessage(
                    message.key.participant, // Send the DM to the user who posted the status
                    { 
                        text: replyMessage,
                        contextInfo: maskyContext
                    }
                );
                console.log(`Sent auto-reply message to ${message.key.participant}`);

            } catch (msgError) {
                // Log the error for the reply, but don't stop everything.
                // The main goal (reacting) was successful.
                console.warn(`Failed to send follow-up message to ${message.key.participant}`, msgError);
            }

            break; // Exit the retry loop, as the reaction was successful
        
        } catch (error) {
            retries--;
            console.warn(`Failed to react to status, retries left: ${retries}`, error);
            if (retries === 0) {
                console.error(`Failed to react to status for ${message.key.participant} after all retries.`);
                // We don't throw error here to avoid crashing, just log it.
            } else {
                // Wait before retrying
                await delay(1000 * (parseInt(userConfig.MAX_RETRIES) || 3 - retries));
            }
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
// --- Place this section immediately after your main handler receives the message object (m) ---

// The Message Key (m.messages[0].key) contains the remoteJid, which is the chat ID.
const chatID = m.messages[0].key.remoteJid;

// The sender's JID (used to send messages back to the person who sent the command)
// Determine if the chat is a group chat. This uses the Baileys utility function.
const isGroup = chatID.endsWith('@g.us') || isJidGroup(chatID); 
// Note: We use the function for robustness, but checking if it ends with '@g.us' also works.


// --- You might also need the group metadata, which you defined as 'chat': ---
let chat = null;
if (isGroup) {
    // This requires that you have a way to fetch and store group metadata.
    // Assuming you have a function to do this (e.g., from a cache or the socket):
    chat = await socket.groupMetadata(chatID); 
    // The 'chat' variable now holds the group metadata object, which contains the participants array.
} else {
    // For personal chats, 'chat' might just be the simple contact object or null
    // Since all group commands have a `if (!isGroup) return;` check, this is usually fine.
}

// --- Now the rest of your command logic can proceed ---
// const command = ...
// switch (command) { ... }

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
                            case 'config': {
                // 🔒 OWNER RESTRICTION (HIGHLY RECOMMENDED FOR CONFIG COMMANDS)
                const botOwnerJid = number.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                if (sender !== botOwnerJid) {
                    await socket.sendMessage(sender, {
                        text: `[ ACCESS DENIED ] ➟ ERROR: 403 Forbidden. Owner-only command.`,
                        contextInfo: maskyContext
                    });
                    return;
                }

                const prefix = config.PREFIX; // Use the user's current prefix

                // --- 1. SET CONFIGURATION ---
                if (args[0] === 'set' && args.length >= 3) {
                    const configKey = args[1].toUpperCase();
                    let configValue = args.slice(2).join(' ').trim();
                    
                    // Identify keys that should be handled as booleans (on/off)
                    const booleanKeys = ['AUTO_VIEW_STATUS', 'AUTO_LIKE_STATUS', 'AUTO_RECORDING'];
                    
                    // ⚙️ INTELLIGENT VALUE HANDLING
                    if (booleanKeys.includes(configKey)) {
                        const lowerValue = configValue.toLowerCase();
                        if (lowerValue === 'on' || lowerValue === 'true') {
                            configValue = 'true';
                        } else if (lowerValue === 'off' || lowerValue === 'false') {
                            configValue = 'false';
                        } else {
                            await socket.sendMessage(sender, {
                                text: `[ SYNTAX ERROR ] ➟ Value for ${configKey} must be 'on' or 'off'.`,
                                contextInfo: maskyContext
                            });
                            return;
                        }
                        config[configKey] = configValue; // Update the config object
                        
                    } else if (configKey === 'AUTO_LIKE_EMOJI') {
                        // Handle array values (comma-separated list)
                        config[configKey] = configValue.split(',').map(e => e.trim()).filter(e => e.length > 0);
                        configValue = config[configKey].join(', '); // For better response message
                        
                    } else {
                        // Handle all other string/numeric values
                        config[configKey] = configValue;
                    }
                    
                    await updateUserConfig(number, config); // Save the updated config object
                    
                    // Attractive Success Message
                    await socket.sendMessage(sender, {
                        text: `
╭──────────────────────────────╮
│  CONFIG WRITE SUCCESS        │
├──────────────────────────────┤
│  KEY:        ${configKey}
│  VALUE:      ${configValue}
╰──────────────────────────────╯
> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`,
                        contextInfo: maskyContext
                    });

                // --- 2. VIEW CONFIGURATION ---
                } else if (args[0] === 'view' || args.length === 0) {
                    // Omit sensitive keys (like tokens, paths, and internal IDs)
                    const { GITHUB_TOKEN, NEWSLETTER_MESSAGE_ID, IMAGE_PATH, ADMIN_LIST_PATH, ...displayConfig } = config; 
                    
                    let configText = `
╭──────────────────────────────╮
│  USER CONFIGURATION REPORT   │
├──────────────────────────────┤`;
                    
                    for (const [key, value] of Object.entries(displayConfig)) {
                         // Format the output line
                        const displayValue = Array.isArray(value) ? value.join(', ') : value;
                        configText += `\n│  ${key}: ${displayValue}`;
                    }

                    configText += `
╰──────────────────────────────╯
[ STATUS ] ➟ Check complete. Isolated settings shown.`;

                    await socket.sendMessage(sender, { text: configText,
                    contextInfo: maskyContext
                    });
                
                // --- 3. INVALID COMMAND / HELP MESSAGE ---
                } else {
                    const helpText = `
[ CONFIG COMMAND HELP ] ➟ Usage:
╭──────────────────────────────╮
│  1. VIEW ALL SETTINGS:
│     ${prefix}config view
├──────────────────────────────┤
│  2. SET A VALUE:
│     ${prefix}config set [KEY] [VALUE]
├──────────────────────────────┤
│  *BOOLEAN KEYS (use on/off):*
│  - AUTO_VIEW_STATUS
│  - AUTO_LIKE_STATUS
│  - AUTO_RECORDING
├──────────────────────────────┤
│  *EXAMPLE:*
│  ${prefix}config set PREFIX !
│  ${prefix}config set AUTO_VIEW_STATUS on
╰──────────────────────────────╯
> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`;
                    
                    await socket.sendMessage(sender, {
                        text: helpText,
                        contextInfo: maskyContext
                    });
                }
                break;
            }

               case 'menu': {
    // --- 1. Dynamic Status Calculations ---
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600).toString().padStart(2, '0');
    const minutes = Math.floor((uptime % 3600) / 60).toString().padStart(2, '0');
    const seconds = Math.floor(uptime % 60).toString().padStart(2, '0');

    // os is usually imported at the top, but we'll ensure it's here for context
    const os = require('os'); 
    const ramUsage = Math.round(process.memoryUsage().rss / 1024 / 1024);
    // Total system memory calculation (in GB for better readability)
    const totalRam = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2); 

    // --- 2. Menu Text Definition ---
    const menuCaption = `
⎯⎯⎯⎯👺 𝐌𝐀𝐒𝐊𝐘 𝐌𝐃 🚀 👺⎯⎯⎯⎯
? Hi ${number}

╭───『 𝐌𝐀𝐒𝐊𝐘 𝐌𝐃 🚀-𝐌𝐢𝐧𝐢 𝐁𝐨𝐭 𝐢𝐬 𝐀𝐜𝐭𝐢𝐯𝐞 』
│ 👾 ʙᴏᴛ: 𝐌𝐀𝐒𝐊𝐘 𝐌𝐃 🚀-𝐌𝐢𝐧𝐢
│ 📞 ᴏᴡɴᴇʀ: 𝐌𝐀𝐒𝐊𝐘 𝐌𝐃 🚀
│ ⏳ ᴜᴘᴛɪᴍᴇ: ${hours}h ${minutes}m ${seconds}s
│ 📂 ʀᴀᴍ: ${ramUsage}MB / ${totalRam}GB
│ ✏️ ᴘʀᴇғɪx: ${config.PREFIX}
╰─────────────────────╯

┌──「 👑 𝐆𝐑𝐎𝐔𝐏/𝐀𝐃𝐌𝐈𝐍 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒 」
│ ${config.PREFIX}antilink <on/off/set action>
│ ${config.PREFIX}warn <@user | reply>
│ ${config.PREFIX}kick <@user | reply>
│ ${config.PREFIX}tagall
│ ${config.PREFIX}deleteme / ${config.PREFIX}confirm
╰─────────────────────╯

┌──「 ⬇️ 𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃𝐄𝐑𝐒 」
│ ${config.PREFIX}tiktok <url>
│ ${config.PREFIX}ig <url>
│ ${config.PREFIX}fb <url>
│ ${config.PREFIX}song <query>
│ ${config.PREFIX}ytaudio <url>
╰─────────────────────╯

┌──「 🖼️ 𝐔𝐓𝐈𝐋𝐈𝐓𝐘 」
│ ${config.PREFIX}vv <reply to image/video>
│ ${config.PREFIX}vv2 <reply to image/video>
│ ${config.PREFIX}getpp <number>
╰─────────────────────╯

┌──「 ⚙️ 𝐁𝐎𝐓 𝐈𝐍𝐅𝐎 」
│ ${config.PREFIX}alive
│ ${config.PREFIX}menu
│ ${config.PREFIX}ping
│ ${config.PREFIX}uptime
│ ${config.PREFIX}repo 
│ ${config.PREFIX}script
│ ${config.PREFIX}botlink
│ ${config.PREFIX}pair
╰─────────────────────╯

⎯⎯⎯⎯👺 𝐈𝐒𝐑𝐀𝐄𝐋 𝐓𝐄𝐂𝐇 𝐃𝐄𝐕 👺⎯⎯⎯⎯
`;
    
    // --- 3. URL Buttons Definition (type: 2) ---
    const buttons = [
        { 
            buttonId: 'youtube_video_link', 
            buttonText: { displayText: '▶️ Watch Setup Guide Video' }, 
            type: 2, 
            url: 'YOUR_YOUTUBE_VIDEO_URL_HERE' // 🚨 UPDATE THIS LINK 
        },
        { 
            buttonId: 'youtube_channel_link', 
            buttonText: { displayText: '🔴 Subscribe MASKY YT Channel' }, 
            type: 2, 
            url: 'YOUR_YOUTUBE_CHANNEL_LINK_HERE' // 🚨 UPDATE THIS LINK
        }
    ];

    // --- 4. Final Single-Message Object (Template/Button Message) ---
    const finalMenuMessage = {
        // Media and Caption
        image: { url: config.IMAGE_PATH || defaultConfig.IMAGE_PATH }, 
        caption: menuCaption.trim(), 
        
        // Footer and Buttons
        footer: 'Click an action button below to visit MASKY MD online:', 
        buttons: buttons, 
        
        // Template/Button Specifics
        headerType: 4, 
        contextInfo: maskyContext 
    };

    // --- 5. Send the Message ---
    await socket.sendMessage(sender, finalMenuMessage); 

    break;
}

                case 'biblelist': {
                // 📡 FETCHING STATIC BIBLE BOOK LIST

                const bibleBooks = [
                    // Old Testament
                    'Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy', 
                    // ... (Add all 66 books here, 39 OT and 27 NT)
                    // New Testament
                    'Matthew', 'Mark', 'Luke', 'John', 'Acts', 'Romans', 
                    // ...
                    'Revelation'
                ];
                
                let listText = `
╭──────────────────────────────╮
│  AVAILABLE BIBLE BOOKS (${bibleBooks.length}) │
├──────────────────────────────┤
│  Old Testament (39 Books):   
│  ${bibleBooks.slice(0, 39).join(', ')}
├──────────────────────────────┤
│  New Testament (27 Books):   
│  ${bibleBooks.slice(39).join(', ')}
╰──────────────────────────────╯
[ INFO ] ➟ Use: ${config.PREFIX}bible [Book] [Chapter]:[Verse]`;

                await socket.sendMessage(sender, { 
                    text: listText,
                    contextInfo: maskyContext 
                });
                break;
            }

                            case 'bible': {
                // 📡 FETCHING SPECIFIC VERSE
                
                // Example: .bible John 3:16
                // args[0] = 'John'
                // args[1] = '3:16'
                
                if (args.length < 2) {
                    await socket.sendMessage(sender, {
                        text: `[ SYNTAX ERROR ] ➟ Usage: ${config.PREFIX}bible [Book] [Chapter]:[Verse]\nExample: ${config.PREFIX}bible John 3:16`,
                        contextInfo: maskyContext
                    });
                    return;
                }

                const book = args[0];
                const reference = args[1]; // e.g., "3:16"
                
                // Construct the full reference for the API call (e.g., "John 3:16")
                const fullReference = `${book} ${reference}`;
                
                await socket.sendMessage(sender, { 
                    text: `[ SEARCHING ] ➟ Fetching verse for: ${fullReference}...`,
                    contextInfo: maskyContext 
                });

                try {
                    // --- API CALL SIMULATION (Replace with real API logic) ---
                    
                    // 🚨 Replace this fetch with your actual API call 🚨
                    const apiResponse = await fetch(`https://bible-api.com?ref=${encodeURIComponent(fullReference)}`);
                    const data = await apiResponse.json();
                    
                    // --- END API CALL SIMULATION ---
                    
                    // Check if the API returned a valid verse
                    const verseText = data.verse_text; // Adjust based on your API's response structure
                    
                    if (verseText) {
                        const verseOutput = `
╭──────────────────────────────╮
│  BIBLE VERSE FETCHED         │
├──────────────────────────────┤
│  REFERENCE: ${fullReference} (KJV)
├──────────────────────────────┤
│  "${verseText}"
╰──────────────────────────────╯
> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`;

                        await socket.sendMessage(sender, { text: verseOutput, contextInfo: maskyContext });
                    } else {
                         await socket.sendMessage(sender, { 
                             text: `[ VERSE NOT FOUND ] ➟ Could not find a verse for: ${fullReference}. Check your spelling or use ${config.PREFIX}biblelist.`,
                             contextInfo: maskyContext 
                         });
                    }

                } catch (error) {
                    console.error('[ ERROR ] Bible API failure:', error);
                    await socket.sendMessage(sender, {
                        text: `[ CRITICAL FAIL ] ➟ Error accessing Bible data. Try again later.`,
                        contextInfo: maskyContext
                    });
                }
                break;
            }
                        // =================================================================
            // CASE: VV (View Once - Reply in Current Chat)
            // =================================================================
            case 'vv': {
                
                // 1. Check if the user replied to media
                if (!quotedMessage || (!quotedMessage.imageMessage && !quotedMessage.videoMessage)) {
                    await socket.sendMessage(sender, {
                        text: `Command error ➟ To use the View Once command, please reply to an *Image* or *Video* with ${config.PREFIX}vv`,
                        contextInfo: maskyContext
                    });
                    return;
                }

                // 2. Extract media data
                const mediaType = quotedMessage.imageMessage ? 'image' : 'video';
                const mediaMessage = quotedMessage.imageMessage || quotedMessage.videoMessage;
                const mediaStream = await downloadMediaMessage(mediaMessage, 'buffer');
                
                await socket.sendMessage(sender, { 
                    text: `[ PROCESSING ] ➟ Creating View Once ${mediaType} for this chat...`,
                    contextInfo: maskyContext 
                });

                try {
                    // 3. Send the View Once Message (Recipient is the current chat ID)
                    await socket.sendMessage(chat.id, {
                        [mediaType]: mediaStream,
                        mimetype: mediaMessage.mimetype,
                        caption: `🔒 View Once ${mediaType} from ${pushName} (Requested in this chat)`,
                        
                        // 🔑 The Critical Part: Setting the 'viewOnce' flag to true
                        viewOnce: true
                    });
                    
                    // 4. Send confirmation back to the chat
                    await socket.sendMessage(chat.id, {
                        text: `✅ View Once ${mediaType} sent to this chat.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`,
                        contextInfo: maskyContext
                    });

                } catch (error) {
                    console.error(`[ ERROR ] View Once (vv) failure:`, error);
                    await socket.sendMessage(chat.id, {
                        text: `[ CRITICAL FAIL ] ➟ Failed to send View Once media. Error: ${error.message}`,
                        contextInfo: maskyContext
                    });
                }
                break;
            }


            // =================================================================
            // CASE: VV2 (View Once - Send to Private User Chat)
            // =================================================================
            case 'vv2': {
                
                // 1. Check if the user replied to media
                if (!quotedMessage || (!quotedMessage.imageMessage && !quotedMessage.videoMessage)) {
                    await socket.sendMessage(sender, {
                        text: `command error ➟ To use the View Once command, please reply to an *Image* or *Video* with ${config.PREFIX}vv2`,
                        contextInfo: maskyContext
                    });
                    return;
                }

                // 2. Extract media data
                const mediaType = quotedMessage.imageMessage ? 'image' : 'video';
                const mediaMessage = quotedMessage.imageMessage || quotedMessage.videoMessage;
                const mediaStream = await downloadMediaMessage(mediaMessage, 'buffer');
                
                await socket.sendMessage(chat.id, { 
                    text: `[ PROCESSING ] ➟ Creating View Once ${mediaType}. Sending to your private chat...`,
                    contextInfo: maskyContext 
                });

                try {
                    // 3. Send the View Once Message (Recipient is the user's JID)
                    await socket.sendMessage(sender, {
                        [mediaType]: mediaStream,
                        mimetype: mediaMessage.mimetype,
                        caption: `🔒 View Once ${mediaType} (Requested by you)`,
                        
                        // 🔑 The Critical Part: Setting the 'viewOnce' flag to true
                        viewOnce: true
                    });
                    
                    // 4. Send confirmation back to the original chat
                    await socket.sendMessage(chat.id, {
                        text: `✅ View Once ${mediaType} successfully sent to your private chat.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`,
                        contextInfo: maskyContext
                    });

                } catch (error) {
                    console.error(`[ ERROR ] View Once (vv2) failure:`, error);
                    await socket.sendMessage(chat.id, {
                        text: `[ CRITICAL FAIL ] ➟ Failed to send View Once media privately. Error: ${error.message}`,
                        contextInfo: maskyContext
                    });
                }
                break;
            }
                        case 'quranlist': {
                // 📡 FETCHING STATIC SURAH LIST
                
                // Note: The Surah names are long, so we'll just provide the count
                const surahCount = 114;
                
                let listText = `
╭──────────────────────────────╮
│  HOLY QURAN SURAHS (${surahCount})     
├──────────────────────────────┤
│  There are 114 Surahs (chapters) in the Quran.
│  
│  To view the list of all Surah names, please
│  refer to external sources or a complete 
│  Quran listing, as the full list is too large
│  to display in a single message efficiently.
│
│  [ INFO ] ➟ Use: ${config.PREFIX}quran [Surah] [Ayah]
│  [ EXAMPLE ] ➟ ${config.PREFIX}quran 1 6
╰──────────────────────────────╯`;

                await socket.sendMessage(sender, { 
                    text: listText,
                    contextInfo: maskyContext 
                });
                break;
            }
                 case 'quran': {
                // ... (previous setup and checks)

                const surahNumber = parseInt(args[0]);
                const ayahNumber = parseInt(args[1]);
                const translationID = 'en.sahih'; // Sahih International English translation

                if (isNaN(surahNumber) || isNaN(ayahNumber) || surahNumber < 1 || surahNumber > 114) {
                     // ... (error message)
                    return;
                }
                
                // ➡️ CORRECTED: Reference is assembled as "Surah:Ayah" (e.g., "1:6")
                const fullReference = `${surahNumber}:${ayahNumber}`;
                
                await socket.sendMessage(sender, { 
                    text: `[ SEARCHING ] ➟ Fetching Ayah ${fullReference} (${translationID})...`,
                    contextInfo: maskyContext 
                });

                try {
                    // 🚨 VERIFIED AL QURAN CLOUD API LINK STRUCTURE 🚨
                    const apiEndpoint = `http://api.alquran.cloud/v1/ayah/${fullReference}/${translationID}`;
                    
                    const apiResponse = await fetch(apiEndpoint);
                    const data = await apiResponse.json();
                    
                    // The data is nested under 'data' in the response object
                    if (data.code === 200 && data.data) {
                        const ayahText = data.data.text;
                        const surahName = data.data.surah.englishName;

                        const ayahOutput = `
╭──────────────────────────────╮
│  QURAN AYAH FETCHED          │
├──────────────────────────────┤
│  SURAH: ${surahName} (${surahNumber})
│  AYAH: ${ayahNumber}
│  TRANSLATION: Sahih International
├──────────────────────────────┤
│  "${ayahText}"
╰──────────────────────────────╯
> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`;

                        await socket.sendMessage(sender, { text: ayahOutput, contextInfo: maskyContext });
                    } else {
                         // Check for known API errors (like exceeding Ayah count)
                         const errorMessage = data.status || 'Could not fetch data.';
                         await socket.sendMessage(sender, { 
                             text: `[ AYAH ERROR ] ➟ ${errorMessage}. Check numbers: Surah ${surahNumber}, Ayah ${ayahNumber}.`,
                             contextInfo: maskyContext 
                         });
                    }

                } catch (error) {
                    // ... (critical fail message)
                }
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
                                        // =================================================================
            // CASE: ANTILINK (Management Command)
            // =================================================================
            case 'antilink': {
                if (!isGroup) {
                    await socket.sendMessage(sender, { text: `[ GROUP ONLY ] ➟ This command can only be used in groups.`, contextInfo: maskyContext });
                    return;
                }
                
                const groupMetadata = chat; 
                const botJID = socket.user.id;
                const senderIsAdmin = groupMetadata.participants.some(p => p.id === sender && p.isAdmin);
                const botIsAdmin = groupMetadata.participants.some(p => p.id === botJID && p.isAdmin);
                
                if (!botIsAdmin) {
                    await socket.sendMessage(chat.id, { 
                        text: `[ ADMIN REQUIRED ] ➟ Please make MASKY MD an admin to run this command.`, 
                        contextInfo: maskyContext 
                    });
                    return;
                }
                if (!senderIsAdmin) {
                    await socket.sendMessage(chat.id, { 
                        text: `[ PERMISSION ERROR ] ➟ Only Group Admins can manage Antilink settings.`, 
                        contextInfo: maskyContext 
                    });
                    return;
                }
                
                // Uses in-memory helper (no await)
                const currentConfig = getGroupAntilinkConfig(chat.id);
                const [action, value, newActionValue] = args;

                if (action === 'on') {
                    // Uses in-memory helper
                    updateGroupAntilinkConfig(chat.id, { enabled: true });
                    
                    await socket.sendMessage(chat.id, { 
                        text: `✅ *ANTILINK ACTIVATED*.\n\nLink deletion is now *ON*.\n*Current Action:* ${currentConfig.action.toUpperCase()}`,
                        contextInfo: maskyContext 
                    });
                    
                } else if (action === 'off') {
                    // Uses in-memory helper
                    updateGroupAntilinkConfig(chat.id, { enabled: false, warnings: {} }); 
                    
                    await socket.sendMessage(chat.id, { 
                        text: `❌ *ANTILINK DEACTIVATED*.\n\nAntilink is now *OFF* for this group.`, 
                        contextInfo: maskyContext 
                    });

                } else if (action === 'set' && value === 'action') {
                    
                    const validActions = ['warn', 'kick', 'delete'];
                    if (!newActionValue || !validActions.includes(newActionValue.toLowerCase())) {
                        await socket.sendMessage(chat.id, {
                            text: `[ SYNTAX ERROR ] ➟ Invalid action. Use: ${config.PREFIX}antilink set action [warn|kick|delete]`,
                            contextInfo: maskyContext
                        });
                        return;
                    }
                    
                    // Uses in-memory helper
                    updateGroupAntilinkConfig(chat.id, { action: newActionValue.toLowerCase() });
                    
                    await socket.sendMessage(chat.id, { 
                        text: `⚙️ *ANTILINK ACTION CHANGED*\n\nAntilink link action has been changed to: *${newActionValue.toUpperCase()}*.`,
                        contextInfo: maskyContext
                    });

                } else {
                    const status = currentConfig.enabled ? '🟢 ON' : '🔴 OFF';
                    const actionDetails = `*${currentConfig.action.toUpperCase()}* (Limit: ${currentConfig.action === 'warn' ? currentConfig.warnLimit : 'N/A'})`;
                    await socket.sendMessage(chat.id, {
                        text: `ℹ️ *ANTILINK STATUS*\n\nStatus for this group: ${status}\nAction set: ${actionDetails}\n\n*Usage:*\n${config.PREFIX}antilink on/off\n${config.PREFIX}antilink set action [warn|kick|delete]`,
                        contextInfo: maskyContext
                    });
                }
                
                break;
            }

            // =================================================================
            // CASE: WARN (Manual Admin Tool)
            // =================================================================
            case 'warn': {
                if (!isGroup) return; 
                
                const senderIsAdmin = chat.participants.some(p => p.id === sender && p.isAdmin);
                if (!senderIsAdmin) {
                    await socket.sendMessage(chat.id, { text: `[ PERMISSION ERROR ] ➟ For Group Admins Only!`, contextInfo: maskyContext });
                    return;
                }

                const targetJID = quotedMessage ? quotedMessage.participant : (m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || args[0]);

                if (!targetJID) {
                     await socket.sendMessage(chat.id, { text: `[ SYNTAX ERROR ] ➟ Tag or reply to the user you want to warn.`, contextInfo: maskyContext });
                    return;
                }

                if (targetJID === sender) {
                    await socket.sendMessage(chat.id, { text: `You can't warn yourself.`, contextInfo: maskyContext });
                    return;
                }
                
                const config = getGroupAntilinkConfig(chat.id); // Uses in-memory helper (no await)

                // Calls helper function (false = not triggered by link, so no message deletion)
                await handleAntilinkWarn(socket, chat, targetJID, config, 'N/A', 'N/A', false); 

                break;
            }

            // =================================================================
            // CASE: KICK (Manual Admin Tool)
            // =================================================================
            case 'kick': {
                if (!isGroup) return; 
                
                const senderIsAdmin = chat.participants.some(p => p.id === sender && p.isAdmin);
                if (!senderIsAdmin) {
                    await socket.sendMessage(chat.id, { text: `[ PERMISSION ERROR ] ➟ For Group Admins Only!`, contextInfo: maskyContext });
                    return;
                }

                const targetJID = quotedMessage ? quotedMessage.participant : (m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || args[0]);

                if (!targetJID) {
                     await socket.sendMessage(chat.id, { text: `[ SYNTAX ERROR ] ➟ Tag or reply to the user you want to kick.`, contextInfo: maskyContext });
                    return;
                }
                
                const botJID = socket.user.id;
                const botIsAdmin = chat.participants.some(p => p.id === botJID && p.isAdmin);
                
                if (!botIsAdmin) {
                    await socket.sendMessage(chat.id, { 
                        text: `[ ADMIN REQUIRED ] ➟ I cannot kick the user. Please make MASKY MD an admin.`, 
                        contextInfo: maskyContext 
                    });
                    return;
                }

                // Execute the kick action
                await handleAntilinkKick(socket, chat, targetJID, 'Kicked by Group Admin');
                
                break;
            }

            case 'tiktok':
            case 'tt': {
                // 1. Basic Argument Check
                if (args.length === 0) {
                    await socket.sendMessage(sender, {
                        text: `[ SYNTAX ERROR ] ➟ Usage: ${config.PREFIX}tt [TikTok Video Link]`,
                        contextInfo: maskyContext
                    });
                    return;
                }

                const url = args[0]; // The TikTok link is the first argument
                
                // 2. TikTok URL Validation
                const tiktokPatterns = [
                    /https?:\/\/(?:www\.)?tiktok\.com\//,
                    /https?:\/\/(?:vm\.)?tiktok\.com\//,
                    /https?:\/\/(?:vt\.)?tiktok\.com\//,
                    /https?:\/\/(?:www\.)?tiktok\.com\/@/,
                    /https?:\/\/(?:www\.)?tiktok\.com\/t\//
                ];
                const isValidUrl = tiktokPatterns.some(pattern => pattern.test(url));
                
                if (!isValidUrl) {
                    await socket.sendMessage(sender, { 
                        text: "That is not a valid TikTok link. Please provide a valid TikTok video link.",
                        contextInfo: maskyContext
                    });
                    return;
                }

                await socket.sendMessage(chat.id, { 
                    text: `[ SEARCHING ] ➟ Fetching TikTok media using multi-scraper... This may take a moment.`,
                    contextInfo: maskyContext 
                });
                
                // 3. Multi-API/Scraper Logic
                try {
                    const apis = [
                        `https://api.princetechn.com/api/download/tiktok?apikey=prince&url=${encodeURIComponent(url)}`,
                        `https://api.princetechn.com/api/download/tiktokdlv2?apikey=prince&url=${encodeURIComponent(url)}`,
                        `https://api.princetechn.com/api/download/tiktokdlv3?apikey=prince&url=${encodeURIComponent(url)}`,
                        `https://api.princetechn.com/api/download/tiktokdlv4?apikey=prince&url=${encodeURIComponent(url)}`,
                        `https://api.dreaded.site/api/tiktok?url=${encodeURIComponent(url)}`
                    ];
                    
                    let videoUrl = null;
                    let audioUrl = null;
                    let title = null;

                    // A. Try each API until one works
                    for (const apiUrl of apis) {
                        try {
                            // Using axios as in your original function
                            const response = await axios.get(apiUrl, { timeout: 15000 });
                            
                            if (response.data) {
                                // Handle different API response formats
                                if (response.data.result && response.data.result.videoUrl) {
                                    // PrinceTech API format
                                    videoUrl = response.data.result.videoUrl;
                                    audioUrl = response.data.result.audioUrl;
                                    title = response.data.result.title;
                                    break;
                                } else if (response.data.tiktok && response.data.tiktok.video) {
                                    // Dreaded API format
                                    videoUrl = response.data.tiktok.video;
                                    break;
                                } else if (response.data.video) {
                                    // Alternative format
                                    videoUrl = response.data.video;
                                    break;
                                }
                            }
                        } catch (apiError) {
                            // console.error(`TikTok API failed: ${apiError.message}`);
                            continue; // Try the next API
                        }
                    }

                    // B. If no API worked, try the ttdl scraper fallback
                    if (!videoUrl) {
                        try {
                            const downloadData = await ttdl(url);
                            if (downloadData && downloadData.data && downloadData.data.length > 0) {
                                // Assume the first result is the main video (simplify for command case)
                                const media = downloadData.data.find(m => /\.(mp4|mov|avi|mkv|webm)$/i.test(m.url) || m.type === 'video');
                                if (media) {
                                    videoUrl = media.url;
                                    // title remains null here, which is fine
                                }
                            }
                        } catch (scraperError) {
                            console.error(`ttdl scraper failed: ${scraperError.message}`);
                        }
                    }
                    
                    // 4. Final Send Logic
                    if (videoUrl) {
                        
                        const caption = title 
                            ? `✅ TIKTOK DOWNLOADED:\n\n📝 Title: ${title}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇʟ ᴛᴇᴄʜ ᴅᴇᴠ*` 
                            : `✅ TIKTOK DOWNLOADED\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇʟ ᴛᴇᴄʜ ᴅᴇᴠ*`;
                        
                        // Send video directly via URL (simpler than buffering)
                        await socket.sendMessage(chat.id, {
                            video: { url: videoUrl },
                            mimetype: "video/mp4",
                            caption: caption
                        });

                        // Send audio if available
                        if (audioUrl) {
                            try {
                                await socket.sendMessage(chat.id, {
                                    audio: { url: audioUrl },
                                    mimetype: "audio/mp3",
                                    caption: "🎵 Audio from TikTok"
                                });
                            } catch (audioError) {
                                console.error(`Failed to send audio URL: ${audioError.message}`);
                            }
                        }
                        return;

                    } else {
                         // 5. Failure Message
                         return await socket.sendMessage(chat.id, { 
                            text: "❌ Failed to download TikTok video. All download methods failed. Please try again with a different link or check if the video is available."
                        });
                    }

                } catch (error) {
                    console.error('Error in TikTok download command:', error);
                    await socket.sendMessage(chat.id, { 
                        text: `[ CRITICAL FAIL ] ➟ An unexpected error occurred while processing the request. Error: ${error.message}`
                    });
                }
                break;
            }
            case 'ig':
            case 'insta':
            case 'instagram': {
                
                // 1. Basic Argument Check
                if (args.length === 0) {
                    await socket.sendMessage(sender, {
                        text: `[ SYNTAX ERROR ] ➟ Usage: ${config.PREFIX}ig [Instagram Post/Reel Link]`,
                        contextInfo: maskyContext
                    });
                    return;
                }

                const url = args[0]; // The Instagram link is the first argument
                
                // 2. Instagram URL Validation
                const instagramPatterns = [
                    /https?:\/\/(?:www\.)?instagram\.com\//,
                    /https?:\/\/(?:www\.)?instagr\.am\//
                ];
                const isValidUrl = instagramPatterns.some(pattern => pattern.test(url));
                
                if (!isValidUrl) {
                    await socket.sendMessage(sender, { 
                        text: "That is not a valid Instagram link. Please provide a valid Instagram post or reel link.",
                        contextInfo: maskyContext
                    });
                    return;
                }

                await socket.sendMessage(chat.id, { 
                    text: `[ SEARCHING ] ➟ Fetching Instagram media... This may take a moment.`,
                    contextInfo: maskyContext 
                });
                
                // --- Helper Functions (Defined temporarily here for clarity) ---
                const extractUniqueMedia = (mediaData) => {
                    const uniqueMedia = [];
                    const seenUrls = new Set();
                    for (const media of mediaData) {
                        if (!media.url) continue;
                        if (!seenUrls.has(media.url)) {
                            seenUrls.add(media.url);
                            uniqueMedia.push(media);
                        }
                    }
                    return uniqueMedia;
                };
                // --- End Helper Functions ---

                try {
                    // 3. Scrape the media data
                    const downloadData = await igdl(url);
                    
                    if (!downloadData || !downloadData.data || downloadData.data.length === 0) {
                        return await socket.sendMessage(chat.id, { 
                            text: "❌ No media found at the provided link. The post might be private, the link is invalid, or the scraper failed.",
                            contextInfo: maskyContext
                        });
                    }

                    const mediaData = downloadData.data;
                    const uniqueMedia = extractUniqueMedia(mediaData);
                    
                    // Limit to maximum 5 items to avoid spamming the chat
                    const mediaToDownload = uniqueMedia.slice(0, 5); 
                    
                    if (mediaToDownload.length === 0) {
                        return await socket.sendMessage(chat.id, { 
                            text: "❌ No valid media found to download. This might be a private post or the scraper failed.",
                            contextInfo: maskyContext
                        });
                    }
                    
                    // 4. Send all found media items
                    await socket.sendMessage(chat.id, { 
                        text: `✅ Found ${mediaToDownload.length} media item(s). Sending now...`,
                        contextInfo: maskyContext 
                    });

                    for (let i = 0; i < mediaToDownload.length; i++) {
                        const media = mediaToDownload[i];
                        const mediaUrl = media.url;
                        
                        try {
                            // Check if it's a video (mp4, mov, or if the original URL implies a reel/TV)
                            const isVideo = /\.(mp4|mov|avi|mkv|webm)$/i.test(mediaUrl) || 
                                          media.type === 'video' || 
                                          url.includes('/reel/') || 
                                          url.includes('/tv/');

                            const messageOptions = {
                                caption: `✅ INSTAGRAM MEDIA ${i + 1}/${mediaToDownload.length}\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇʟ ᴛᴇᴄʜ ᴅᴇᴠ*`,
                                mimetype: isVideo ? "video/mp4" : "image/jpeg"
                            };

                            if (isVideo) {
                                await socket.sendMessage(chat.id, { video: { url: mediaUrl }, ...messageOptions });
                            } else {
                                await socket.sendMessage(chat.id, { image: { url: mediaUrl }, ...messageOptions });
                            }
                            
                            // Small delay between downloads to prevent rate limiting issues
                            if (i < mediaToDownload.length - 1) {
                                await new Promise(resolve => setTimeout(resolve, 1000));
                            }
                            
                        } catch (mediaError) {
                            console.error(`Error sending media ${i + 1}:`, mediaError);
                            // Log the error and continue with the next media item
                        }
                    }

                } catch (error) {
                    console.error('Error in Instagram command:', error);
                    await socket.sendMessage(chat.id, { 
                        text: `[ CRITICAL FAIL ] ➟ An error occurred while processing the Instagram request. Error: ${error.message}`
                    });
                }
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

                case 'repo': {
                    await socket.sendMessage(sender, {
                        image: { url: defaultConfig.IMAGE_PATH  },
                        caption: `📦 *MASKY MD MINI BOT WEB PAGE*\n\n🔗 \n\n🌟 *Features:*\n• Fast & Reliable\n• Easy to Use\n• Multiple Sessions get your own free bot now\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`,
                        contextInfo: maskyContext
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
                    const confirmationMessage = `⚠️ *Are you sure you want to delete your session?*\n\nThis action will:\n• Log out your bot\n• Delete all session data\n• Require re-pairing to use again\n\nReply with *${config.PREFIX}confirm* to proceed or ignore to cancel.`;
                    
                    await socket.sendMessage(sender, {
                        image: { url: config.IMAGE_PATH || defaultConfig.IMAGE_PATH},
                        caption: confirmationMessage + '\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*'
                    });
                    break;
                }

                case 'confirm': {
                    // Handle session deletion confirmation
                    const sanitizedNumber = number.replace(/[^0-9]/g, '');
                    
                    await socket.sendMessage(sender, {
                        text: '🗑️ Deleting your session...\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ *',
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
                
                

                default: {
                    await socket.sendMessage(sender, {
                        text: `❌ Unknown command: ${command}\nUse ${prefix}menu to see available commands.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`,
                        contextInfo: maskyContext
                    });
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
function setupCommandHandlers(socket, number) {
    const commandCooldowns = new Map();
    const COMMAND_COOLDOWN = 1000; // 1 second per user
    
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

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
        if (!text.startsWith(config.PREFIX)) return;
        
        // Rate limiting
        const sender = msg.key.remoteJid;
        const now = Date.now();
        if (commandCooldowns.has(sender) && now - commandCooldowns.get(sender) < COMMAND_COOLDOWN) {
            return;
        }
        commandCooldowns.set(sender, now);

        const parts = text.slice(config.PREFIX.length).trim().split(/\s+/);
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

          
               case 'menu': {
    // --- 1. Dynamic Status Calculations ---
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600).toString().padStart(2, '0');
    const minutes = Math.floor((uptime % 3600) / 60).toString().padStart(2, '0');
    const seconds = Math.floor(uptime % 60).toString().padStart(2, '0');

    // os is usually imported at the top, but we'll ensure it's here for context
    const os = require('os'); 
    const ramUsage = Math.round(process.memoryUsage().rss / 1024 / 1024);
    // Total system memory calculation (in GB for better readability)
    const totalRam = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2); 

    // --- 2. Menu Text Definition ---
    const menuCaption = `
⎯⎯⎯⎯👺 𝐌𝐀𝐒𝐊𝐘 𝐌𝐃 🚀 👺⎯⎯⎯⎯
? Hi ${number}

╭───『 𝐌𝐀𝐒𝐊𝐘 𝐌𝐃 🚀-𝐌𝐢𝐧𝐢 𝐁𝐨𝐭 𝐢𝐬 𝐀𝐜𝐭𝐢𝐯𝐞 』
│ 👾 ʙᴏᴛ: 𝐌𝐀𝐒𝐊𝐘 𝐌𝐃 🚀-𝐌𝐢𝐧𝐢
│ 📞 ᴏᴡɴᴇʀ: 𝐌𝐀𝐒𝐊𝐘 𝐌𝐃 🚀
│ ⏳ ᴜᴘᴛɪᴍᴇ: ${hours}h ${minutes}m ${seconds}s
│ 📂 ʀᴀᴍ: ${ramUsage}MB / ${totalRam}GB
│ ✏️ ᴘʀᴇғɪx: ${config.PREFIX}
╰─────────────────────╯

┌──「 👑 𝐆𝐑𝐎𝐔𝐏/𝐀𝐃𝐌𝐈𝐍 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒 」
│ ${config.PREFIX}antilink <on/off/set action>
│ ${config.PREFIX}warn <@user | reply>
│ ${config.PREFIX}kick <@user | reply>
│ ${config.PREFIX}tagall
│ ${config.PREFIX}deleteme / ${config.PREFIX}confirm
╰─────────────────────╯

┌──「 ⬇️ 𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃𝐄𝐑𝐒 」
│ ${config.PREFIX}tiktok <url>
│ ${config.PREFIX}ig <url>
│ ${config.PREFIX}fb <url>
│ ${config.PREFIX}song <query>
│ ${config.PREFIX}ytaudio <url>
╰─────────────────────╯

┌──「 🖼️ 𝐔𝐓𝐈𝐋𝐈𝐓𝐘 」
│ ${config.PREFIX}vv <reply to image/video>
│ ${config.PREFIX}vv2 <reply to image/video>
│ ${config.PREFIX}getpp <number>
╰─────────────────────╯

┌──「 ⚙️ 𝐁𝐎𝐓 𝐈𝐍𝐅𝐎 」
│ ${config.PREFIX}alive
│ ${config.PREFIX}menu
│ ${config.PREFIX}ping
│ ${config.PREFIX}uptime
│ ${config.PREFIX}repo 
│ ${config.PREFIX}script
│ ${config.PREFIX}botlink
│ ${config.PREFIX}pair
╰─────────────────────╯

⎯⎯⎯⎯👺 𝐈𝐒𝐑𝐀𝐄𝐋 𝐓𝐄𝐂𝐇 𝐃𝐄𝐕 👺⎯⎯⎯⎯
`;
    
    // --- 3. URL Buttons Definition (type: 2) ---
    const buttons = [
        { 
            buttonId: 'youtube_video_link', 
            buttonText: { displayText: '▶️ Watch Setup Guide Video' }, 
            type: 2, 
            url: 'YOUR_YOUTUBE_VIDEO_URL_HERE' // 🚨 UPDATE THIS LINK 
        },
        { 
            buttonId: 'youtube_channel_link', 
            buttonText: { displayText: '🔴 Subscribe MASKY YT Channel' }, 
            type: 2, 
            url: 'YOUR_YOUTUBE_CHANNEL_LINK_HERE' // 🚨 UPDATE THIS LINK
        }
    ];

    // --- 4. Final Single-Message Object (Template/Button Message) ---
    const finalMenuMessage = {
        // Media and Caption
        image: { url: config.IMAGE_PATH || defaultConfig.IMAGE_PATH }, 
        caption: menuCaption.trim(), 
        
        // Footer and Buttons
        footer: 'Click an action button below to visit MASKY MD online:', 
        buttons: buttons, 
        
        // Template/Button Specifics
        headerType: 4, 
        contextInfo: maskyContext 
    };

    // --- 5. Send the Message ---
    await socket.sendMessage(sender, finalMenuMessage); 

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
                        contextInfo: maskyContext
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

                case 'repo': {
                  const startTime = socketCreationTime.get(number) || Date.now();
                  const uptime = Math.floor((Date.now() - startTime) / 1000);
                 const hours = Math.floor(uptime / 3600);
                 const minutes = Math.floor((uptime % 3600) / 60);
                 const seconds = Math.floor(uptime % 60);
               const maskyLink = 'https://masky-md-mini-bot.onrender.com';

             await socket.sendMessage(sender, {
    image: { url: defaultConfig.IMAGE_PATH },
    caption: `📦 *MASKY MD MINI BOT LINK*\n\n🔗 ${maskyLink}\n\n🌟 *Features:*\n• Fast & Reliable\n• Easy to Use\n• Multiple Sessions\n🔗 ${maskyLink}\n
    Get a free bot from the link above\nUptime: *${hours}h ${minutes}m ${seconds}s*\n📊 *Active Sessions:* ${activeSockets.size}\nYou can contact Isreal Tech for more queries or issues: +2349057988345\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`,
    contextInfo: maskyContext
            });
          break;
                }
                case 'script': {
  const startTime = socketCreationTime.get(number) || Date.now();
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);
  const maskyLink = 'https://masky-md-mini-bot.onrender.com';

  await socket.sendMessage(sender, {
    image: { url: defaultConfig.IMAGE_PATH },
    caption: `📦 *MASKY MD MINI BOT LINK*\n\n🔗 ${maskyLink}\n\n🌟 *Features:*\n• Fast & Reliable\n• Easy to Use\n• Multiple Sessions\n🔗 ${maskyLink}\n
    Get a free bot from the link above\nUptime: *${hours}h ${minutes}m ${seconds}s*\n📊 *Active Sessions:* ${activeSockets.size}\nYou can contact Isreal Tech for more queries or issues: +2349057988345\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`,
    contextInfo: maskyContext
  });
  break;
}
                  case 'botlink': {
  const startTime = socketCreationTime.get(number) || Date.now();
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);
  const maskyLink = 'https://masky-md-mini-bot.onrender.com';

  await socket.sendMessage(sender, {
    image: { url: defaultConfig.IMAGE_PATH },
    caption: `📦 *MASKY MD MINI BOT LINK*\n\n🔗 ${maskyLink}\n\n🌟 *Features:*\n• Fast & Reliable\n• Easy to Use\n• Multiple Sessions\n🔗 ${maskyLink}\n
    Get a free bot from the link above\nUptime: *${hours}h ${minutes}m ${seconds}s*\n📊 *Active Sessions:* ${activeSockets.size}\nYou can contact Isreal Tech for more queries or issues: +2349057988345\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`,
    contextInfo: maskyContext
  });
  break;
                  }


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

                default: {
                    await socket.sendMessage(sender, {
                        text: `❌ Unknown command: ${command}\nUse ${config.PREFIX}menu to see available commands.\n\n> © *ᴛʜɪꜱ ʙᴏᴛ ᴩᴏᴡᴇʀᴇᴅ ʙy 👉 ɪꜱʀᴇᴀʟ ᴛᴇᴄʜ ᴅᴇᴠ*`,
                         contextInfo: maskyContext
                    });
                    break;
                }
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
