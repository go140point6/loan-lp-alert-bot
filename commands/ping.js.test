// Example ping-pong with Embed
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const embedPing = new EmbedBuilder()
	.setTitle('Ping!')
	.addFields(
		{ name: 'Ping', value: 'Pong!'},
	);

module.exports = {
	data: new SlashCommandBuilder()
		.setName('ping')
		.setDescription('Replies with Pong!'),
	async execute(interaction) {
		//await interaction.reply('Pong!');
		await interaction.reply({ embeds: [embedPing] });
	},
};