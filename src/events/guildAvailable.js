// src/events/guildAvailable.js
// Vult de ledencache opnieuw zodra een server terugkomt na een onderbreking.
//
// DIT IS DE PLEK WAAR HET EERDER MISGING. `ready.js` staat op `once: true` en vulde de
// ledencache dus precies een keer per proces. Verliest de bot daarna de gatewayverbinding
// - en dat gebeurt op een server met haperend netwerk regelmatig; in het logboek zie je
// dat als `Connect Timeout Error (attempted address: discord.com:443)` - dan stuurt
// Discord na het opnieuw verbinden een verse GUILD_CREATE. discord.js gooit in
// `Guild#_patch` de hele `members.cache` leeg en vult hem met alleen de leden uit dat
// frame (maximaal `large_threshold`, standaard 50).
//
// De bot draaide daarna vrolijk door met een halve ledencache: `role.members` in
// lib/capacity.js zag nog maar een deel van de gang, dus stond er "9/22 leden" bij een
// gang waar er 19 in zitten, en bleef een volle gang aannames accepteren. Zonder een
// herstart kwam dat nooit meer goed.
//
// Discord meldt zo'n terugkeer met `guildAvailable`, en dat event vuurt ook na elke
// herverbinding. Hier halen we de leden dus opnieuw op.

const { Events } = require('discord.js');

const logger = require('../lib/logger');
const { ensureMemberCache } = require('../lib/memberCache');

/** Aantal pogingen: na een herverbinding is het netwerk vaak nog even wankel. */
const ATTEMPTS = 3;

/**
 * Korte omschrijving van een server voor logregels.
 *
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @returns {string} Bijvoorbeeld 'OWC (123456789012345678)'.
 */
function describeGuild(guild) {
  if (!guild) return 'onbekende server';
  return `${guild.name || 'server'} (${guild.id})`;
}

module.exports = {
  name: Events.GuildAvailable,
  once: false,

  /**
   * Draait elke keer dat een server (weer) beschikbaar wordt: na een storing bij
   * Discord en na elke herverbinding van de bot. Vult de ledencache opnieuw zodat de
   * ledentellingen blijven kloppen. Faalt nooit hard.
   *
   * @param {import('discord.js').Guild} guild De server die beschikbaar werd.
   * @returns {Promise<void>}
   */
  async execute(guild) {
    const result = await ensureMemberCache(guild, { attempts: ATTEMPTS, ignoreCooldown: true });

    if (!result.fetched) {
      logger.debug(`${describeGuild(guild)} is weer beschikbaar; de ledencache was nog compleet.`);
      return;
    }
    if (result.ok) {
      logger.info(
        `${describeGuild(guild)} is weer beschikbaar; ledencache opnieuw gevuld (${result.size} leden).`,
      );
      return;
    }
    logger.warn(
      `${describeGuild(guild)} is weer beschikbaar, maar de ledencache kon niet opnieuw gevuld `
        + `worden (${result.size} van ${result.expected ?? '?'} leden). De ledentellingen van de `
        + 'gangs staan tot die tijd te laag; de bot probeert het vanzelf opnieuw.',
    );
  },
};
