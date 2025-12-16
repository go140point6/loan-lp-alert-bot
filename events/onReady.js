require('dotenv').config({ quiet: true });
// Node's native file system module. fs is used to read the commands directory and identify our command files.
const fs = require('node:fs');
// Node's native path utility module. path helps construct paths to access files and directories.
const path = require('node:path');
const { REST, Routes, Collection } = require('discord.js');

const { monitorLoans } = require('../monitoring/loanMonitor');
const { monitorLPs } = require('../monitoring/lpMonitor');

// How often to refresh monitoring tasks (in minutes, from env, default 5)
const MONITOR_INTERVAL_MIN = parseInt(process.env.MONITOR_INTERVAL_MIN || '5', 10);
const MONITOR_INTERVAL_MS = Math.max(1, MONITOR_INTERVAL_MIN) * 60 * 1000;

async function onReady(client) {
    console.log(`Ready! Logged in as ${client.user.tag}`);
    
    client.commands = new Collection();
    const commands = [];

    const commandsPath = path.join(__dirname, '..', 'commands');
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        const command = require(filePath);
        // Set a new item in the Collection with the key as the command name and the value as the exported module
        if ('data' in command && 'execute' in command) {
            client.commands.set(command.data.name, command);
            commands.push(command.data.toJSON());
        } else {
            console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
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
            { body: commands },
        );

        console.log(`Successfully loaded ${data.length} application (/) commands.`);
    } catch (error) {
        // Catch and log any errors.
        console.error(error);
    }

    // ===== Monitoring example: tick-style, non-overlapping scheduler =====

    // Generic runner wrapper so logs stay consistent per task
    async function runTaskOnce(label, fn) {
        const t0 = Date.now();
        console.log(`▶️  ${label} start`);

        try {
            await fn();
        } catch (e) {
            console.error(`❌ ${label} failed:`, e);
        }

        const elapsed = Date.now() - t0;
        console.log(`⏹️  ${label} end (elapsed ${elapsed} ms)`);
        return elapsed;
    }

    // Simple tick scheduler: avoids overlapping runs, uses setTimeout
    function startTickScheduler(label, intervalMs, fn) {
        let running = false;

        async function tick() {
            if (running) return; // guard against overlap
            running = true;

            try {
                const elapsed = await runTaskOnce(label, fn);
                const nextDelay = Math.max(0, intervalMs - elapsed);
                if (nextDelay === 0) {
                    console.warn(
                        `⏱️ ${label} duration (${elapsed} ms) ≥ interval (${intervalMs} ms). Scheduling next immediately.`
                    );
                }
                setTimeout(() => {
                    running = false;
                    tick();
                }, nextDelay);
            } catch (err) {
                console.error(`Unexpected scheduler error in ${label}:`, err);
                running = false;
                setTimeout(tick, intervalMs);
            }
        }

        // Kick off the loop
        tick();
    }

    // This is an example of how to run a function based on a time value
    // In this example, running loan / LP monitoring every N minutes using a tick-style scheduler
    // Loan runs first, then LP, sequentially in a single scheduler to avoid interleaved logs.
    startTickScheduler('Loan + LP monitor', MONITOR_INTERVAL_MS, async () => {
        await monitorLoans();  // runs first
        await monitorLPs();    // runs after loans finish
    });
}

module.exports = { 
    onReady
};
