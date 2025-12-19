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

  // ===== Daily heartbeat via node-cron =====

  console.log(`[CRON] Using heartbeat schedule: ${HEARTBEAT_CRON} (America/Los_Angeles)`);

  cron.schedule(
    HEARTBEAT_CRON,        // e.g. "0 3 * * *"
    async () => {
      const t0 = Date.now();
      console.log('▶️  Daily heartbeat start');

      try {
        await sendDailyHeartbeat(client);
      } catch (e) {
        console.error('❌ Daily heartbeat failed:', e);
      }

      const elapsed = Date.now() - t0;
      console.log(`⏹️  Daily heartbeat end (elapsed ${elapsed} ms)`);
    },
    {
      timezone: 'America/Los_Angeles'   // <-- IMPORTANT FIX
    }
  );
}

module.exports = {
  onReady,
};