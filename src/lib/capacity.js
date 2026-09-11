// src/lib/capacity.js
// Telt de bezetting van een gang en zet die om in tekst/kleur voor embeds.
// Let op: role.members werkt alleen met een warme member-cache; ready.js doet
// daarom `await guild.members.fetch()`. Ontbreekt de cache, dan tellen we 0.

const {
  COLORS,
  DEFAULT_MEMBER_LIMIT,
  DEFAULT_BOSS_LIMIT,
  DEFAULT_UNDERBOSS_LIMIT,
  ROLE_KIND,
} = require('./constants');

/** Aantal blokjes in de capaciteitsbalk. */
const BAR_SEGMENTS = 10;

/** Vanaf deze bezetting kleurt de gang oranje. */
const WARNING_RATIO = 0.8;

/** Gevulde en lege blokjes van de balk. */
const BAR_FILLED = '█';
const BAR_EMPTY = '░';

/**
 * @typedef {object} CapacityCounts
 * @property {number} members Aantal leden met de gangrol (boss en underboss tellen mee).
 * @property {number} memberLimit Maximum aantal leden.
 * @property {string[]} memberIds Id's van de leden.
 * @property {boolean} memberFull members >= memberLimit.
 * @property {string[]} bossIds Id's met de bossrol.
 * @property {string[]} underbossIds Id's met de underbossrol.
 * @property {number} bossLimit Maximum aantal bosses.
 * @property {number} underbossLimit Maximum aantal underbosses.
 * @property {boolean} bossFull bossIds.length >= bossLimit.
 * @property {boolean} underbossFull underbossIds.length >= underbossLimit.
 * @property {string[]} missingRoles Rolsoorten die niet meer bestaan op de server.
 */

/**
 * Leest een limiet uit een GangRecord met terugval op de standaardwaarde.
 *
 * @param {unknown} value Waarde uit het GangRecord.
 * @param {number} fallback Standaardwaarde uit constants.js.
 * @returns {number} Een geheel getal >= 0.
 */
function limitOrDefault(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.floor(number);
}

/**
 * Haalt de id's op van alle leden met een rol. Bestaat de rol niet (meer), dan
 * wordt de rolsoort in `missingRoles` gezet en is het resultaat leeg.
 *
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @param {string|null|undefined} roleId Rol-id uit het GangRecord.
 * @param {string} kind Rolsoort uit ROLE_KIND, voor de missingRoles-lijst.
 * @param {string[]} missingRoles Verzamellijst die ter plekke aangevuld wordt.
 * @returns {string[]} Lid-id's met deze rol.
 */
function idsWithRole(guild, roleId, kind, missingRoles) {
  const role = roleId ? guild?.roles?.cache?.get(roleId) : null;
  if (!role) {
    missingRoles.push(kind);
    return [];
  }
  try {
    // role.members is een Collection<string, GuildMember>; leeg bij een koude cache.
    return Array.from(role.members?.keys?.() || []);
  } catch {
    return [];
  }
}

/**
 * Telt de bezetting van een gang. Een gang heeft nog maar een soort lid: iedereen
 * met de gangrol telt mee, boss en underboss inbegrepen. De ledenlimiet is dus de
 * enige grens op het aantal personen in de gang.
 *
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @param {object|null|undefined} gang Het GangRecord.
 * @returns {CapacityCounts} De telling; nooit null, ook niet bij ontbrekende rollen.
 */
function countGang(guild, gang) {
  const missingRoles = [];

  const memberIds = idsWithRole(guild, gang?.roleId, ROLE_KIND.GANG, missingRoles);
  const bossIds = idsWithRole(guild, gang?.bossRoleId, ROLE_KIND.BOSS, missingRoles);
  const underbossIds = idsWithRole(guild, gang?.underbossRoleId, ROLE_KIND.UNDERBOSS, missingRoles);

  const members = memberIds.length;

  const memberLimit = limitOrDefault(gang?.memberLimit, DEFAULT_MEMBER_LIMIT);
  const bossLimit = limitOrDefault(gang?.bossLimit, DEFAULT_BOSS_LIMIT);
  const underbossLimit = limitOrDefault(gang?.underbossLimit, DEFAULT_UNDERBOSS_LIMIT);

  return {
    members,
    memberLimit,
    memberIds,
    memberFull: members >= memberLimit,
    bossIds,
    underbossIds,
    bossLimit,
    underbossLimit,
    bossFull: bossIds.length >= bossLimit,
    underbossFull: underbossIds.length >= underbossLimit,
    missingRoles,
  };
}

/**
 * Bezettingsgraad van de gang: leden gedeeld door de ledenlimiet. De leidingslimieten
 * zitten hier bewust niet in - 2/2 bosses mag een verder lege gang niet rood kleuren.
 * Een limiet van 0 telt als vol zodra er iemand in de gang zit.
 *
 * @param {CapacityCounts|null|undefined} counts Telling uit countGang.
 * @returns {number} Verhouding tussen 0 en (eventueel) meer dan 1; 0 bij een lege gang.
 */
function occupancyRatio(counts) {
  if (!counts || typeof counts !== 'object') return 0;
  const members = Number(counts.members);
  const limit = Number(counts.memberLimit);
  if (!Number.isFinite(members) || members <= 0) return 0;
  if (!Number.isFinite(limit) || limit <= 0) return 1;
  return members / limit;
}

/**
 * Zet een telling om in de standaardregel met de ledenbezetting.
 *
 * @param {CapacityCounts|null|undefined} counts Telling uit countGang.
 * @returns {string} Bijvoorbeeld '17/22 leden'.
 */
function formatCapacity(counts) {
  if (!counts || typeof counts !== 'object') return 'bezetting onbekend';
  const members = Number(counts.members) || 0;
  const memberLimit = limitOrDefault(counts.memberLimit, DEFAULT_MEMBER_LIMIT);
  return `${members}/${memberLimit} leden`;
}

/**
 * Korte tekstbalk van de ledenbezetting.
 *
 * @param {CapacityCounts|null|undefined} counts Telling uit countGang.
 * @returns {string} Bijvoorbeeld '████████░░ 80%'.
 */
function capacityBar(counts) {
  const value = occupancyRatio(counts);
  const filled = Math.min(BAR_SEGMENTS, Math.round(value * BAR_SEGMENTS));
  const percentage = Math.round(value * 100);
  return `${BAR_FILLED.repeat(filled)}${BAR_EMPTY.repeat(BAR_SEGMENTS - filled)} ${percentage}%`;
}

/**
 * Embedkleur op basis van de ledenbezetting: rood als de gang vol zit,
 * oranje vanaf 80 procent, anders groen.
 *
 * @param {CapacityCounts|null|undefined} counts Telling uit countGang.
 * @returns {number} Een kleur uit COLORS.
 */
function capacityColor(counts) {
  const value = occupancyRatio(counts);
  if (value >= 1) return COLORS.danger;
  if (value >= WARNING_RATIO) return COLORS.warning;
  return COLORS.success;
}

module.exports = {
  countGang,
  formatCapacity,
  capacityBar,
  capacityColor,
};
