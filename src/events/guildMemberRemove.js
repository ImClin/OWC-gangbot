// src/events/guildMemberRemove.js
// Iemand verlaat de server (of wordt gekickt/verbannen). Zat die persoon in een gang,
// dan leggen we dat vast als actie `left_server` en melden we in het logkanaal hoeveel
// plek er weer vrij is. Daarna wordt het dashboard bijgewerkt.
//
// Let op: Discord haalt het lid vóór dit event al uit de cache, dus countGang() geeft
// hier meteen de nieuwe (lagere) bezetting terug.

const { Events } = require('discord.js');

const logger = require('../lib/logger');
const store = require('../store');
const logService = require('../services/logService');
const dashboardService = require('../services/dashboardService');
const { ACTION } = require('../lib/constants');
const { countGang, formatCapacity } = require('../lib/capacity');
const {
  isMemberOf, isLeaderOf, isBossOf, isUnderbossOf,
} = require('../lib/permissions');
const { warningEmbed } = require('../lib/embeds');

/**
 * Leesbare naam van een (vertrokken) lid voor in het logboek.
 *
 * @param {import('discord.js').GuildMember|import('discord.js').PartialGuildMember} member Het lid.
 * @returns {string} Weergavenaam, gebruikersnaam of id.
 */
function memberTag(member) {
  return member?.user?.tag
    || member?.user?.username
    || member?.displayName
    || member?.id
    || 'onbekend lid';
}

/**
 * Welke rol had deze persoon binnen de gang?
 *
 * @param {import('discord.js').GuildMember} member Het vertrokken lid.
 * @param {object} gang Het GangRecord.
 * @returns {string} 'boss', 'underboss' of 'lid'.
 */
function describeRole(member, gang) {
  if (isBossOf(member, gang)) return 'boss';
  if (isUnderbossOf(member, gang)) return 'underboss';
  return 'lid';
}

/**
 * Alle gangs waar dit lid nog een rol van had.
 *
 * @param {import('discord.js').GuildMember} member Het vertrokken lid.
 * @param {object[]} gangs Alle GangRecords.
 * @returns {object[]} De betrokken gangs.
 */
function affectedGangs(member, gangs) {
  return gangs.filter((gang) => gang
    && (isMemberOf(member, gang) || isLeaderOf(member, gang)));
}

/**
 * Zin over de vrijgekomen plek. Een gang heeft nog maar één soort lid, dus de
 * ledenlimiet is de enige grens die hier telt.
 *
 * @param {object} gang Het GangRecord.
 * @param {object} counts Verse telling uit countGang().
 * @returns {string} Bijvoorbeeld 'Er is nu plek voor 1 extra lid.'
 */
function freeSlotText(gang, counts) {
  const vrij = Math.max(0, (Number(counts.memberLimit) || 0) - (Number(counts.members) || 0));
  if (vrij <= 0) return `${gang.name} zit ondanks het vertrek nog steeds vol.`;
  return `Er is nu plek voor ${vrij} extra ${vrij === 1 ? 'lid' : 'leden'}.`;
}

/**
 * Legt het vertrek vast bij één gang en post er een melding over in het logkanaal.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {import('discord.js').GuildMember} member Het vertrokken lid.
 * @param {object} gang Het GangRecord.
 * @returns {Promise<boolean>} true als er iets gelogd is.
 */
async function reportDeparture(guild, member, gang) {
  const rol = describeRole(member, gang);

  let counts = null;
  try {
    counts = countGang(guild, gang);
  } catch (err) {
    logger.warn(`Bezetting van ${gang.name} kon niet geteld worden: ${err?.message || err}`);
  }

  try {
    store.addAction(guild.id, {
      type: ACTION.LEFT_SERVER,
      gangId: gang.id,
      gangName: gang.name,
      targetId: member.id,
      targetTag: memberTag(member),
      actorId: null,
      actorTag: 'systeem',
      reason: `Heeft de server verlaten (was ${rol} van ${gang.name})`,
    });
  } catch (err) {
    logger.error(`Actie 'left_server' kon niet opgeslagen worden voor ${member?.id}`, err);
  }

  const regels = [
    `**${memberTag(member)}** heeft de server verlaten — was ${rol} van **${gang.name}**.`,
    counts ? freeSlotText(gang, counts) : null,
    counts ? `Bezetting: ${formatCapacity(counts)}` : null,
    rol === 'boss' || rol === 'underboss'
      ? 'Let op: er is nu geen leiding meer op die plek. Wijs met `/gang promoveer` een vervanger aan.'
      : null,
  ].filter(Boolean).join('\n');

  try {
    await logService.logNotice(guild, warningEmbed('🚪 Lid heeft de server verlaten', regels));
  } catch (err) {
    logger.warn(`Vertrekmelding kon niet gepost worden: ${err?.message || err}`);
  }
  logger.info(`${memberTag(member)} verliet de server en was ${rol} van ${gang.name}.`);
  return true;
}

module.exports = {
  name: Events.GuildMemberRemove,
  once: false,

  /**
   * Verwerkt het vertrek van een lid: per gang waar de persoon nog in zat een
   * `left_server`-actie vastleggen, een melding in het logkanaal posten en het
   * dashboard bijwerken. Faalt nooit hard.
   *
   * @param {import('discord.js').GuildMember|import('discord.js').PartialGuildMember} member Het vertrokken lid.
   * @returns {Promise<void>}
   */
  async execute(member) {
    try {
      const guild = member?.guild;
      if (!guild || !guild.id || !member?.id) return;

      // Bij een partial lid is de rolcache leeg; dan valt niet vast te stellen in
      // welke gang de persoon zat en slaan we het bewust stil over.
      if (!member.roles || !member.roles.cache) {
        logger.debug(`Vertrek van ${member?.id} kon niet beoordeeld worden (geen rolgegevens).`);
        return;
      }

      let gangs = [];
      try {
        gangs = store.listGangs(guild.id) || [];
      } catch (err) {
        logger.error(`Ganglijst van ${guild.id} kon niet gelezen worden`, err);
        return;
      }

      const betrokken = affectedGangs(member, gangs);
      if (!betrokken.length) return;

      let gemeld = 0;
      for (const gang of betrokken) {
        // eslint-disable-next-line no-await-in-loop -- sequentieel tegen ratelimits.
        if (await reportDeparture(guild, member, gang)) gemeld += 1;
      }

      if (gemeld) {
        void Promise.resolve(dashboardService.updateDashboard(guild)).catch((err) => {
          logger.debug(`Dashboard bijwerken mislukt: ${err?.message || err}`);
        });
      }
    } catch (err) {
      logger.error('Onverwachte fout bij het verwerken van een vertrokken lid', err);
    }
  },
};
