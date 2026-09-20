// src/events/guildCreate.js
// Vult de ledencache zodra de bot in een nieuwe server gezet wordt.
//
// `ready.js` doet dat alleen voor de servers waar de bot bij het opstarten al in zat.
// Wordt hij daarna uitgenodigd, dan bevat GUILD_CREATE maar een handvol leden en zou
// elke telling in die server te laag uitvallen tot de eerstvolgende herstart.

const { Events } = require('discord.js');

const logger = require('../lib/logger');
const { ensureMemberCache } = require('../lib/memberCache');

/** Aantal pogingen bij het vullen van de cache van een nieuwe server. */
const ATTEMPTS = 3;

module.exports = {
  name: Events.GuildCreate,
  once: false,

  /**
   * Draait wanneer de bot aan een server toegevoegd wordt. Faalt nooit hard.
   *
   * @param {import('discord.js').Guild} guild De nieuwe server.
   * @returns {Promise<void>}
   */
  async execute(guild) {
    const naam = `${guild?.name || 'server'} (${guild?.id || '?'})`;
    const result = await ensureMemberCache(guild, { attempts: ATTEMPTS, ignoreCooldown: true });

    if (result.ok) {
      logger.info(`De bot is toegevoegd aan ${naam}: ${result.size} leden in de cache.`);
      return;
    }
    logger.warn(
      `De bot is toegevoegd aan ${naam}, maar de leden konden niet opgehaald worden `
        + `(${result.size} van ${result.expected ?? '?'}). Staat de "Server Members Intent" aan? `
        + 'Zonder die leden kloppen de ledentellingen van de gangs niet.',
    );
  },
};
