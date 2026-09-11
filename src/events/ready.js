// src/events/ready.js
// Eenmalige opstartroutine: bevestigen dat de bot ingelogd is, de ledencache van elke
// server warm maken (nodig voor role.members in lib/capacity.js), controleren of de bot
// de juiste rechten en rolpositie heeft, de vergrendeling van de registerkanalen
// (#aangenomen en #ontslagen) opnieuw neerzetten, en de dashboard-lus starten.
//
// Alles hier is defensief: een server die niet meewerkt (ontbrekende intent, geen
// rechten) mag het opstarten van de rest nooit blokkeren.

const { Events } = require('discord.js');

const logger = require('../lib/logger');
const store = require('../store');
const { missingBotPermissions, botCanManageRole } = require('../lib/permissions');
const gangService = require('../services/gangService');
const { startDashboardLoop } = require('../services/dashboardService');

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

/**
 * Haalt alle leden van een server op zodat `role.members` betrouwbaar telt.
 * Mislukt dit, dan staat vrijwel altijd de privileged intent 'Server Members' uit.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @returns {Promise<number>} Aantal leden in de cache (0 als het ophalen mislukte).
 */
async function warmMemberCache(guild) {
  try {
    const members = await guild.members.fetch();
    const size = members?.size ?? guild.members?.cache?.size ?? 0;
    logger.debug(`Ledencache van ${describeGuild(guild)} gevuld: ${size} leden.`);
    return size;
  } catch (err) {
    logger.warn(
      `Kon de leden van ${describeGuild(guild)} niet ophalen. Zet in de Discord Developer Portal `
        + 'de "Server Members Intent" aan (Bot > Privileged Gateway Intents); zonder die intent '
        + 'kloppen de ledentellingen en limieten niet.',
      err,
    );
    return 0;
  }
}

/**
 * Waarschuwt over ontbrekende serverrechten van de bot.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @returns {void}
 */
function checkPermissions(guild) {
  const missing = missingBotPermissions(guild);
  if (!missing.length) return;
  logger.warn(
    `De bot mist rechten in ${describeGuild(guild)}: ${missing.join(', ')}. `
      + 'Geef de botrol deze rechten in Serverinstellingen > Rollen.',
  );
}

/**
 * Waarschuwt als de botrol onder een of meer gangrollen staat; dan kan de bot die
 * rollen niet toekennen of afnemen en mislukt elke aanname/ontslag.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @returns {void}
 */
function checkRoleHierarchy(guild) {
  let gangs = [];
  try {
    gangs = store.listGangs(guild.id) || [];
  } catch (err) {
    logger.warn(`Kon de gangs van ${describeGuild(guild)} niet lezen.`, err);
    return;
  }

  const blocked = [];
  for (const gang of gangs) {
    if (!gang) continue;
    const roleIds = [gang.roleId, gang.bossRoleId, gang.underbossRoleId];
    const unmanageable = roleIds.filter((roleId) => roleId && !botCanManageRole(guild, roleId));
    if (unmanageable.length) blocked.push(gang.name || `gang #${gang.id}`);
  }

  if (blocked.length) {
    logger.warn(
      `De botrol staat in ${describeGuild(guild)} te laag voor: ${blocked.join(', ')}. `
        + 'Sleep de rol van de bot in Serverinstellingen > Rollen boven alle gangrollen.',
    );
  }
}

/**
 * Zet de vergrendeling van de registerkanalen (#aangenomen en #ontslagen) opnieuw neer.
 *
 * WAAROM DIT BIJ ELKE START MOET: die vergrendeling wordt verder alleen gezet vanuit
 * /setup en /gang. Past iemand de kanaalrechten met de hand aan, of sleept hij het kanaal
 * naar een andere categorie (dan erft het de rechten van die categorie), dan staat het
 * register stilletjes weer open en kan iedereen er in typen zonder dat de bot dat merkt.
 * Deze aanroep zet het bij het opstarten weer dicht en meldt wat er hersteld is.
 *
 * Draait NA het vullen van de ledencache en faalt nooit hard: lukt het op één server niet,
 * dan gaat het opstarten van de rest gewoon door.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @returns {Promise<void>}
 */
async function restoreFlowChannelLock(guild) {
  let result = null;
  try {
    result = await gangService.applyFlowChannelPermissions(guild);
  } catch (err) {
    logger.warn(
      `De schrijfrechten van #aangenomen en #ontslagen konden in ${describeGuild(guild)} niet `
        + 'gezet worden. Voer /gang herstel uit zodra de bot draait; tot die tijd kan daar '
        + 'mogelijk iedereen typen.',
      err,
    );
    return;
  }
  if (!result) return;

  if (result.updated > 0) {
    const kanalen = Array.isArray(result.kanalen) && result.kanalen.length
      ? result.kanalen.join(' en ')
      : 'de registerkanalen';
    logger.info(
      `${describeGuild(guild)}: ${kanalen} weer dichtgezet (${result.updated} rechtenregel(s) `
        + 'hersteld) — alleen bosses, underbosses, staff en de bot kunnen daar nog posten.',
    );
  } else if (result.ok) {
    logger.debug(`${describeGuild(guild)}: de schrijfrechten van de registerkanalen stonden al goed.`);
  }

  if (result.error) logger.warn(`${describeGuild(guild)}: ${result.error}`);

  // Dat een registerkanaal nog niet gekoppeld is, is geen mankement van deze server; dat
  // hoort in het debuglogboek en niet als waarschuwing bij elke herstart.
  const ongekoppeld = new Set(Array.isArray(result.ongekoppeld) ? result.ongekoppeld : []);
  const waarschuwingen = Array.isArray(result.waarschuwingen) ? result.waarschuwingen : [];
  for (const regel of waarschuwingen) {
    if (ongekoppeld.has(regel)) logger.debug(`${describeGuild(guild)}: ${regel}`);
    else logger.warn(`${describeGuild(guild)}: ${regel}`);
  }
}

/**
 * Bereidt één server voor: ledencache vullen, de controles draaien en de registerkanalen
 * weer dichtzetten.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @returns {Promise<void>}
 */
async function prepareGuild(guild) {
  try {
    const members = await warmMemberCache(guild);
    checkPermissions(guild);
    checkRoleHierarchy(guild);
    // Bewust pas hier: het vergrendelen zet ook een overwrite voor de bot zelf en filtert
    // de rechten op wat de bot mag. Daar is guild.members.me voor nodig, en die staat na
    // het ophalen van de leden zeker in de cache.
    await restoreFlowChannelLock(guild);
    const gangs = store.listGangs(guild.id) || [];
    logger.info(`${describeGuild(guild)}: ${members} leden, ${gangs.length} gang(s) bekend.`);
  } catch (err) {
    logger.error(`Voorbereiden van ${describeGuild(guild)} mislukt`, err);
  }
}

module.exports = {
  name: Events.ClientReady,
  once: true,

  /**
   * Draait eenmalig zodra de bot verbonden is: logt de inlogmelding, vult per server
   * de ledencache, controleert rechten en rolvolgorde, zet de registerkanalen weer dicht
   * en start de dashboard-lus.
   *
   * @param {import('discord.js').Client} client De ingelogde client.
   * @returns {Promise<void>}
   */
  async execute(client) {
    try {
      const tag = client.user?.tag || client.user?.username || 'onbekend';
      logger.info(`Ingelogd als ${tag} (${client.user?.id || '?'}).`);

      const guilds = client.guilds?.cache ? Array.from(client.guilds.cache.values()) : [];
      if (!guilds.length) {
        logger.warn('De bot zit in geen enkele server. Nodig hem uit met de URL uit de README.');
      }

      // Bewust sequentieel: bij meerdere servers voorkomt dit een ratelimit op members.fetch.
      for (const guild of guilds) {
        await prepareGuild(guild);
      }

      startDashboardLoop(client);
      logger.info('OWC Gangbot is klaar voor gebruik.');
    } catch (err) {
      logger.error('Opstarten (ready) mislukt', err);
    }
  },
};
