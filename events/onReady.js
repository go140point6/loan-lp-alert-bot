require('dotenv').config({ quiet: true });
// Node's native file system module. fs is used to read the commands directory and identify our command files.
const fs = require('node:fs');
// Node's native path utility module. path helps construct paths to access files and directories.
const path = require('node:path');
const { REST, Routes, Collection } = require('discord.js');

const cron = require('node-cron');

const { monitorLoans } = require('../monitoring/loanMonitor');
const { monitorLPs } = require('../monitoring/lpMonitor');
const { sendDailyHeartbeat } = require('../monitoring/dailyHeartbeat');

// Cron schedule for monitoring (from .env)
const CRON_SCHED = process.env.CRON_SCHED;
if (!CRON_SCHED) {
  console.error('Missing CRON_SCHED in .env');
  process.exit(1);
}

// Cron schedule for daily heartbeat (from .env)
// e.g. HEARTBEAT_CRON="0 3 * * *"  // 3:00 AM America/Los_Angeles
const HEARTBEAT_CRON = process.env.HEARTBEAT_CRON;
if (!HEARTBEAT_CRON) {
  console.error('Missing HEARTBEAT_CRON in .env');
  process.exit(1);
}

// Heartbeat timezone (from .env) — no code defaults
// e.g. HEARTBEAT_TZ="America/Los_Angeles"
const HEARTBEAT_TZ = process.env.HEARTBEAT_TZ;
if (!HEARTBEAT_TZ) {
  console.error('Missing HEARTBEAT_TZ in .env');
  process.exit(1);
}

// -----------------------------
// Discord DM chunking helpers
// -----------------------------

const DISCORD_MSG_MAX = 2000;
// headroom to avoid edge-case overflow
const DISCORD_SAFE_MAX = 1900;

function splitIntoDiscordMessages(text, maxLen = DISCORD_SAFE_MAX) {
  if (!text) return [];

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const chunks = [];

  let buf = '';

  for (const line of lines) {
    const addLen = (buf.length === 0 ? 0 : 1) + line.length;

    // If a single line is too long, hard-split it
    if (line.length > maxLen) {
      if (buf.length) {
        chunks.push(buf);
        buf = '';
      }
      for (let i = 0; i < line.length; i += maxLen) {
        chunks.push(line.slice(i, i + maxLen));
      }
      continue;
    }

    // If adding this line would exceed max, flush buffer
    if (buf.length + addLen > maxLen) {
      if (buf.length) chunks.push(buf);
      buf = line;
      continue;
    }

    buf = buf.length ? `${buf}\n${line}` : line;
  }

  if (buf.length) chunks.push(buf);

  return chunks.map((c) =>
    c.length > DISCORD_MSG_MAX ? c.slice(0, DISCORD_MSG_MAX) : c
  );
}

async function sendLongDM(user, content) {
  const chunks = splitIntoDiscordMessages(content);

  for (let i = 0; i < chunks.length; i++) {
    const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length}) ` : '';
    await user.send({ content: prefix + chunks[i] });
  }
}

// Wrap sendDailyHeartbeat(client) so it can return a string OR send itself.
// If it returns a string, we chunk+send here.
// If it already sends, we do nothing extra.
async function sendDailyHeartbeatChunked(client) {
  const res = await sendDailyHeartbeat(client);

  // If your heartbeat module returns content, send it chunked here.
  if (typeof res === 'string' && res.trim().length > 0) {
    const myId = process.env.MY_DISCORD_ID;
    if (!myId) {
      console.error('Missing MY_DISCORD_ID in .env');
      process.exit(1);
    }

    const user = await client.users.fetch(myId);
    const header = `📌 Daily Heartbeat — ${new Date().toISOString()}\n`;
    await sendLongDM(user, header + res);
  }

  // Otherwise assume sendDailyHeartbeat handled delivery (and might now internally chunk).
}

async function onReady(client) {
  console.log(`Ready! Logged in as ${client.user.tag}`);

  client.commands = new Collection();
  const commands = [];

  const commandsPath = path.join(__dirname, '..', 'commands');
  const commandFiles = fs
    .readdirSync(commandsPath)
    .filter((file) => file.endsWith('.js'));

  for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    // Set a new item in the Collection with the key as the command name and the value as the exported module
    if ('data' in command && 'execute' in command) {
      client.commands.set(command.data.name, command);
      commands.push(command.data.toJSON());
    } else {
      console.log(
        `[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`
      );
    }
  }

  // Construct and prepare an instance of the REST module
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

  // Register slash commands FIRST
  try {
    const data = await rest.put(
      Routes.applicationGuildCommands(
        process.env.CLIENT_ID,
        process.env.GUILD_ID
      ),
      { body: commands }
    );

    console.log(`Successfully loaded ${data.length} application (/) commands.`);
  } catch (error) {
    console.error(error);
  }

  // ===== Monitoring via node-cron (non-overlapping) =====

  console.log(`[CRON] Using schedule: ${CRON_SCHED}`);

  let isMonitorRunning = false;

  // -------- RUN MONITOR IMMEDIATELY ON STARTUP --------
  (async () => {
    if (isMonitorRunning) return;
    isMonitorRunning = true;

    const t0 = Date.now();
    console.log('▶️  (startup) Loan + LP monitor start');

    try {
      await monitorLoans();
      await monitorLPs();
    } catch (e) {
      console.error('❌ (startup) Loan + LP monitor failed:', e);
    }

    const elapsed = Date.now() - t0;
    console.log(`⏹️  (startup) Loan + LP monitor end (elapsed ${elapsed} ms)`);

    isMonitorRunning = false;
  })();
  // ---------------------------------------------------

  // Schedule recurring Loan + LP runs
  cron.schedule(CRON_SCHED, async () => {
    if (isMonitorRunning) {
      console.log(
        '[CRON] Previous Loan + LP monitor cycle still running — skipping this tick.'
      );
      return;
    }

    isMonitorRunning = true;

    const t0 = Date.now();
    console.log('▶️  Loan + LP monitor start');

    try {
      // Run loans first, then LPs, sequentially, to keep logs tidy
      await monitorLoans();
      await monitorLPs();
    } catch (e) {
      console.error('❌ Loan + LP monitor failed:', e);
    }

    const elapsed = Date.now() - t0;
    console.log(`⏹️  Loan + LP monitor end (elapsed ${elapsed} ms)`);

    isMonitorRunning = false;
  });

  // ===== Daily heartbeat via node-cron =====

  console.log(
    `[CRON] Using heartbeat schedule: ${HEARTBEAT_CRON} (${HEARTBEAT_TZ})`
  );

  cron.schedule(
    HEARTBEAT_CRON,
    async () => {
      const t0 = Date.now();
      console.log('▶️  Daily heartbeat start');

      try {
        await sendDailyHeartbeatChunked(client);
      } catch (e) {
        console.error('❌ Daily heartbeat failed:', e);
      }

      const elapsed = Date.now() - t0;
      console.log(`⏹️  Daily heartbeat end (elapsed ${elapsed} ms)`);
    },
    {
      timezone: HEARTBEAT_TZ,
    }
  );
}

module.exports = {
  onReady,
};
