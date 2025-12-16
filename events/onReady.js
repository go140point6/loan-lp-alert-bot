require('dotenv').config();
// Node's native file system module. fs is used to read the commands directory and identify our command files.
const fs = require('node:fs');
// Node's native path utility module. path helps construct paths to access files and directories.
const path = require('node:path');
const { REST, Routes, Collection } = require('discord.js');
const axios = require('axios'); // Required for getXRP example below

// How often to refresh XRP price (in minutes, from env, default 5)
const PRICE_INTERVAL_MIN = parseInt(process.env.PRICE_INTERVAL_MIN || '5', 10);
const PRICE_INTERVAL_MS = Math.max(1, PRICE_INTERVAL_MIN) * 60 * 1000;

function onReady(client) {
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

    // Register slash commands
    (async () => {
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
    })();

    // ===== XRP EXAMPLE: tick-style, non-overlapping scheduler =====

    // Run XRP fetch once and log timing
    async function runXRPOnce() {
        const t0 = Date.now();
        console.log('▶️  XRP price fetch start');

        try {
            await getXRPToken();
        } catch (e) {
            console.error('❌ getXRPToken failed:', e);
        }

        const elapsed = Date.now() - t0;
        console.log(`⏹️  XRP price fetch end (elapsed ${elapsed} ms)`);
        return elapsed;
    }

    // Simple tick scheduler: avoids overlapping runs, uses setTimeout
    function startXRPScheduler(intervalMs) {
        let running = false;

        async function tick() {
            if (running) return; // guard against overlap
            running = true;

            try {
                const elapsed = await runXRPOnce();
                const nextDelay = Math.max(0, intervalMs - elapsed);
                if (nextDelay === 0) {
                    console.warn(`⏱️ XRP fetch duration (${elapsed} ms) ≥ interval (${intervalMs} ms). Scheduling next immediately.`);
                }
                setTimeout(() => {
                    running = false;
                    tick();
                }, nextDelay);
            } catch (err) {
                console.error('Unexpected XRP scheduler error:', err);
                running = false;
                setTimeout(tick, intervalMs);
            }
        }

        // Kick off the loop
        tick();
    }

    // This is an example of how to run a function based on a time value
    // In this example, getting XRP price and updating it every N minutes
    startXRPScheduler(PRICE_INTERVAL_MS);
}

// ===== Your original XRP helpers (unchanged) =====

async function getXRP() {
    await axios
        .get(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=ripple`)
        .then(res => {
            if (res.data && res.data[0].current_price) {
                const currentXRP = res.data[0].current_price.toFixed(4) || 0;
                console.log("XRP current price: " + currentXRP);
                module.exports.currentXRP = currentXRP;
            } else {
                console.log("Error loading coin data");
            }
        })
        .catch(err => {
            console.log(
                "An error with the Coin Gecko api call: ",
                err.response && err.response.status,
                err.response && err.response.statusText
            );
        });
}

async function getXRPToken() {
    await getXRP();
}

module.exports = { 
    onReady
};