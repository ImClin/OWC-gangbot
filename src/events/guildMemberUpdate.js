// src/events/guildMemberUpdate.js
// Signaleert gangrollen die BUITEN de bot om zijn toegevoegd of verwijderd (dus met de
// hand in Discord). Zulke wijzigingen omzeilen de limieten, dus ze worden vastgelegd
// als actie `manual` en gemeld in het logkanaal.
//
// Twee beschermingen:
//  1. Uitvoerder-check: staat in het auditlogboek dat de bot het zelf deed, dan gebeurt
//     er niets. Kan het auditlogboek niet gelezen worden (recht 'Auditlogboek bekijken'
//     ontbreekt) of staat er niets in, dan falen we bewust stil — anders zou elke
//     aanname van de bot ook nog eens als handmatige wijziging binnenkomen.
//  2. Dedupe: een korte in-memory set op `${lidId}:${rolId}` vangt dubbele events op
//     (Discord kan hetzelfde event meermaals sturen, en een rolwijziging van de bot
//     komt soms als losse events terug).

const { Events, AuditLogEvent } = require('discord.js');

const logger = require('../lib/logger');
const store = require('../store');
const logService = require('../services/logService');
const dashboardService = require('../services/dashboardService');
const { ACTION, ROLE_KIND, ROLE_SUFFIX } = require('../lib/constants');
const { countGang, formatCapacity } = require('../lib/capacity');
const { warningEmbed } = require('../lib/embeds');

/** Hoe lang een `${lidId}:${rolId}`-sleutel geblokkeerd blijft. */
const DEDUPE_TTL_MS = 15 * 1000;

/** Maximale omvang van de dedupe-set; daarboven wordt hij hard opgeschoond. */
const DEDUPE_MAX_ENTRIES = 500;

/** Hoe oud een auditlog-regel maximaal mag zijn om bij deze wijziging te horen. */
const AUDIT_WINDOW_MS = 10 * 1000;

/**
 * Recent verwerkte rolwijzigingen: sleutel `${lidId}:${rolId}` => vervaltijd (ms).
 * @type {Map<string, number>}
 */
const recentChanges = new Map();

/**
 * Ruimt vervallen dedupe-sleutels op zodat de map niet ongelimiteerd groeit.
 *
 * @param {number} now Huidige tijd in milliseconden.
 * @returns {void}
 */
function pruneDedupe(now) {
  for (const [key, expiresAt] of recentChanges) {
    if (expiresAt <= now) recentChanges.delete(key);
  }
  if (recentChanges.size > DEDUPE_MAX_ENTRIES) recentChanges.clear();
}

/**
 * Controleert of deze rolwijziging net al gezien is en markeert hem meteen als gezien.
 *
 * @param {string} memberId Het lid-id.
 * @param {string} roleId Het rol-id.
 * @returns {boolean} true als de wijziging al verwerkt is (dan overslaan).
 */
function seenRecently(memberId, roleId) {
  const now = Date.now();
  pruneDedupe(now);
  const key = `${memberId}:${roleId}`;
  const expiresAt = recentChanges.get(key);
  if (expiresAt && expiresAt > now) return true;
  recentChanges.set(key, now + DEDUPE_TTL_MS);
  return false;
}

/**
 * Verschil tussen de rollen vóór en ná de wijziging.
 *
 * @param {import('discord.js').GuildMember} oldMember Het lid vóór de wijziging.
 * @param {import('discord.js').GuildMember} newMember Het lid ná de wijziging.
 * @returns {{added: string[], removed: string[]}} De toegevoegde en verwijderde rol-id's.
 */
function diffRoles(oldMember, newMember) {
  const before = oldMember?.roles?.cache;
  const after = newMember?.roles?.cache;
  if (!before || !after) return { added: [], removed: [] };
  const added = Array.from(after.keys()).filter((id) => !before.has(id));
  const removed = Array.from(before.keys()).filter((id) => !after.has(id));
  return { added, removed };
}

/**
 * Bepaalt welke rolsoort een rol-id binnen een gang is.
 *
 * @param {object} gang Het GangRecord.
 * @param {string} roleId Het rol-id.
 * @returns {string} Een waarde uit ROLE_KIND.
 */
function roleKindOf(gang, roleId) {
  if (gang.bossRoleId === roleId) return ROLE_KIND.BOSS;
  if (gang.underbossRoleId === roleId) return ROLE_KIND.UNDERBOSS;
  return ROLE_KIND.GANG;
}

/**
 * Nederlandse naam van een gangrol ('Rayuza', 'Rayuza Boss', ...).
 *
 * @param {object} gang Het GangRecord.
 * @param {string} kind Rolsoort uit ROLE_KIND.
 * @returns {string} De rolnaam.
 */
function roleLabel(gang, kind) {
  const naam = gang?.name || 'de gang';
  if (kind === ROLE_KIND.GANG) return naam;
  const suffix = ROLE_SUFFIX ? ROLE_SUFFIX[kind] : null;
  return suffix ? `${naam} ${suffix}` : `${naam} ${kind}`;
}

/**
 * Zoekt bij elke gewijzigde rol de bijbehorende gang; rollen die bij geen enkele gang
 * horen worden genegeerd.
 *
 * @param {string} guildId Server-id.
 * @param {string[]} added Toegevoegde rol-id's.
 * @param {string[]} removed Verwijderde rol-id's.
 * @returns {Array<{gang: object, roleId: string, kind: string, added: boolean}>} De relevante wijzigingen.
 */
function collectGangChanges(guildId, added, removed) {
  const changes = [];
  const scan = (ids, isAdded) => {
    for (const roleId of ids) {
      let gang = null;
      try {
        gang = store.getGangByRoleId(guildId, roleId);
      } catch (err) {
        logger.warn(`Gang bij rol ${roleId} opzoeken mislukt: ${err?.message || err}`);
      }
      if (!gang) continue;
      changes.push({
        gang, roleId, kind: roleKindOf(gang, roleId), added: isAdded,
      });
    }
  };
  scan(added, true);
  scan(removed, false);
  return changes;
}

/**
 * Zoekt in het auditlogboek wie deze rolwijziging heeft doorgevoerd.
 * Ontbreekt het recht 'Auditlogboek bekijken' of is er geen recente regel, dan komt er
 * bewust null terug: we loggen dan niets in plaats van iets verkeerds.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {string} targetId Het lid-id waarop de wijziging sloeg.
 * @returns {Promise<import('discord.js').User|null>} De uitvoerder, of null.
 */
async function findExecutor(guild, targetId) {
  try {
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 5 });
    const now = Date.now();
    const entry = logs?.entries?.find?.((item) => item
      && item.target?.id === targetId
      && now - Number(item.createdTimestamp || 0) <= AUDIT_WINDOW_MS);
    return entry?.executor || null;
  } catch (err) {
    logger.debug(
      `Auditlogboek van ${guild.id} kon niet gelezen worden (recht "Auditlogboek bekijken"?): ${err?.message || err}`,
    );
    return null;
  }
}

/**
 * Legt één handmatige rolwijziging vast en meldt hem in het logkanaal.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {import('discord.js').GuildMember} member Het gewijzigde lid.
 * @param {import('discord.js').User} executor Wie de wijziging deed.
 * @param {{gang: object, roleId: string, kind: string, added: boolean}} change De wijziging.
 * @returns {Promise<boolean>} true als er iets gemeld is.
 */
async function reportChange(guild, member, executor, change) {
  const { gang, kind, added } = change;
  const rolNaam = roleLabel(gang, kind);
  const richting = added ? 'toegevoegd' : 'verwijderd';

  let counts = null;
  try {
    counts = countGang(guild, gang);
  } catch (err) {
    logger.warn(`Bezetting van ${gang.name} kon niet geteld worden: ${err?.message || err}`);
  }

  try {
    store.addAction(guild.id, {
      type: ACTION.MANUAL,
      gangId: gang.id,
      gangName: gang.name,
      targetId: member.id,
      targetTag: member.user?.tag || member.user?.username || member.displayName || member.id,
      actorId: executor.id,
      actorTag: executor.tag || executor.username || executor.id,
      reason: `Rol ${rolNaam} handmatig ${richting}`,
      roleId: change.roleId,
      roleKind: kind,
      manualAdded: added,
    });
  } catch (err) {
    logger.error(`Actie 'manual' kon niet opgeslagen worden voor ${member.id}`, err);
  }

  const overLimiet = counts && counts.members > counts.memberLimit;

  const regels = [
    `De rol **${rolNaam}** is buiten de bot om ${richting} bij <@${member.id}>.`,
    `Uitgevoerd door <@${executor.id}>.`,
    counts ? `Bezetting: ${formatCapacity(counts)}` : null,
    overLimiet
      ? '⚠️ Hierdoor zit deze gang **boven** de ingestelde ledenlimiet. Corrigeer het met `/gang ontslaan` of verhoog de limiet met `/gangbeheer limiet leden:<aantal>`.'
      : null,
    'Gebruik het #aangenomen- of #ontslagen-kanaal (of `/gang aannemen`) zodat de limieten bewaakt blijven.',
  ].filter(Boolean).join('\n');

  try {
    await logService.logNotice(guild, warningEmbed('✏️ Handmatige rolwijziging', regels));
  } catch (err) {
    logger.warn(`Melding van handmatige rolwijziging mislukt: ${err?.message || err}`);
  }
  logger.info(`Handmatige rolwijziging: ${rolNaam} ${richting} bij ${member.id} door ${executor.id}.`);
  return true;
}

module.exports = {
  name: Events.GuildMemberUpdate,
  once: false,

  /**
   * Vergelijkt de rollen vóór en ná een wijziging en meldt handmatige gangrol-
   * wijzigingen. Wijzigingen van de bot zelf en dubbele events worden overgeslagen.
   *
   * @param {import('discord.js').GuildMember|import('discord.js').PartialGuildMember} oldMember Het lid vóór de wijziging.
   * @param {import('discord.js').GuildMember} newMember Het lid ná de wijziging.
   * @returns {Promise<void>}
   */
  async execute(oldMember, newMember) {
    try {
      const guild = newMember?.guild;
      if (!guild || !guild.id || !newMember?.id) return;

      // Een partial 'oud' lid heeft een onbetrouwbare rolcache; vergelijken zou dan
      // alle rollen als 'net toegevoegd' zien. Beter niets doen.
      if (oldMember?.partial || !oldMember?.roles?.cache) {
        logger.debug(`Rolwijziging van ${newMember.id} overgeslagen: geen betrouwbare oude rolgegevens.`);
        return;
      }

      const { added, removed } = diffRoles(oldMember, newMember);
      if (!added.length && !removed.length) return;

      const changes = collectGangChanges(guild.id, added, removed);
      if (!changes.length) return;

      const nieuw = changes.filter((change) => !seenRecently(newMember.id, change.roleId));
      if (!nieuw.length) {
        logger.debug(`Rolwijziging van ${newMember.id} was al verwerkt; genegeerd.`);
        return;
      }

      const executor = await findExecutor(guild, newMember.id);
      if (!executor) return;
      if (executor.id === newMember.client?.user?.id) {
        logger.debug(`Rolwijziging van ${newMember.id} kwam van de bot zelf; niet gelogd.`);
        return;
      }

      let gemeld = 0;
      for (const change of nieuw) {
        // eslint-disable-next-line no-await-in-loop -- sequentieel tegen ratelimits.
        if (await reportChange(guild, newMember, executor, change)) gemeld += 1;
      }

      if (gemeld) {
        void Promise.resolve(dashboardService.updateDashboard(guild)).catch((err) => {
          logger.debug(`Dashboard bijwerken mislukt: ${err?.message || err}`);
        });
      }
    } catch (err) {
      logger.error('Onverwachte fout bij het verwerken van een rolwijziging', err);
    }
  },
};
