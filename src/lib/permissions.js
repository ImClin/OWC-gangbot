// src/lib/permissions.js
// Permissie- en rolchecks. Alle functies zijn defensief: caches kunnen leeg zijn,
// rollen kunnen verwijderd zijn en members kunnen partial/null zijn. Nooit gooien —
// bij twijfel geven we 'geen rechten' terug.

const { PermissionFlagsBits } = require('discord.js');

/**
 * Serverrechten die de bot nodig heeft, met hun Nederlandse naam.
 * De Engelse naam staat erbij omdat Discord-clients die tonen.
 *
 * Dit zijn de rechten die de bot ZELF gebruikt om zijn werk te doen. ManageMessages
 * hoort er nadrukkelijk bij: de bot zet dat recht in de overwrites van de
 * registerkanalen (#aangenomen en #ontslagen) voor staff, de leiding en zichzelf, en
 * Discord staat in een overwrite alleen rechten toe die de bot zelf op de server heeft.
 * Mist de bot het, dan verdwijnt die allow stilzwijgend en kan niemand er meer opruimen.
 *
 * De spraak- en moderatierechten uit CATEGORY_PERMS (Speak, MuteMembers, ...) staan hier
 * bewust niet in: die deelt de bot alleen aan anderen uit, en gangService meldt bij het
 * aanmaken van een gang zelf welke daarvan ontbraken.
 */
const REQUIRED_BOT_PERMISSIONS = [
  // Rollen en kanalen aanmaken, hernoemen, verwijderen en op volgorde zetten.
  { flag: PermissionFlagsBits.ManageChannels, label: 'Kanalen beheren (Manage Channels)' },
  { flag: PermissionFlagsBits.ManageRoles, label: 'Rollen beheren (Manage Roles)' },
  // Zonder ViewChannel ziet de bot zijn eigen gangkanalen en de registerkanalen niet,
  // en kan hij de @everyone-deny op de categorie niet zetten.
  { flag: PermissionFlagsBits.ViewChannel, label: 'Kanalen bekijken (View Channels)' },
  // Nodig om te zien wie een rol met de hand heeft aangepast (guildMemberUpdate).
  { flag: PermissionFlagsBits.ViewAuditLog, label: 'Auditlogboek bekijken (View Audit Log)' },
  // Antwoorden in de registerkanalen en het dashboard tonen.
  { flag: PermissionFlagsBits.SendMessages, label: 'Berichten versturen (Send Messages)' },
  { flag: PermissionFlagsBits.EmbedLinks, label: 'Links insluiten (Embed Links)' },
  // Berichten in de registerkanalen teruglezen en er een vinkje onder zetten.
  { flag: PermissionFlagsBits.ReadMessageHistory, label: 'Berichtgeschiedenis bekijken (Read Message History)' },
  { flag: PermissionFlagsBits.AddReactions, label: 'Reacties toevoegen (Add Reactions)' },
  // Foute regels uit de registerkanalen halen en dat recht daar kunnen uitdelen.
  { flag: PermissionFlagsBits.ManageMessages, label: 'Berichten beheren (Manage Messages)' },
];

/**
 * Veilige rolcheck op een GuildMember.
 *
 * @param {import('discord.js').GuildMember|null|undefined} member Het lid.
 * @param {string|null|undefined} roleId Rol-id om te controleren.
 * @returns {boolean} true als het lid deze rol heeft.
 */
function hasRole(member, roleId) {
  if (!member || !roleId || typeof roleId !== 'string') return false;
  try {
    return Boolean(member.roles?.cache?.has(roleId));
  } catch {
    return false;
  }
}

/**
 * Bepaalt of iemand staff is: het recht 'Server beheren' (ManageGuild) of de
 * ingestelde staffrol.
 *
 * @param {import('discord.js').GuildMember|null|undefined} member Het lid.
 * @param {{ staffRoleId?: string|null }|null|undefined} guildConfig Serverconfiguratie.
 * @returns {boolean} true als het lid staff is.
 */
function isStaff(member, guildConfig) {
  if (!member) return false;
  try {
    if (member.permissions?.has?.(PermissionFlagsBits.ManageGuild)) return true;
  } catch {
    // permissions kan ontbreken op een partial member; val terug op de staffrol.
  }
  return hasRole(member, guildConfig?.staffRoleId);
}

/**
 * Is dit lid de boss van deze gang?
 *
 * @param {import('discord.js').GuildMember|null|undefined} member Het lid.
 * @param {{ bossRoleId?: string|null }|null|undefined} gang GangRecord.
 * @returns {boolean} true bij een boss.
 */
function isBossOf(member, gang) {
  return hasRole(member, gang?.bossRoleId);
}

/**
 * Is dit lid de underboss van deze gang?
 *
 * @param {import('discord.js').GuildMember|null|undefined} member Het lid.
 * @param {{ underbossRoleId?: string|null }|null|undefined} gang GangRecord.
 * @returns {boolean} true bij een underboss.
 */
function isUnderbossOf(member, gang) {
  return hasRole(member, gang?.underbossRoleId);
}

/**
 * Is dit lid leider (boss of underboss) van deze gang?
 *
 * @param {import('discord.js').GuildMember|null|undefined} member Het lid.
 * @param {object|null|undefined} gang GangRecord.
 * @returns {boolean} true bij boss of underboss.
 */
function isLeaderOf(member, gang) {
  return isBossOf(member, gang) || isUnderbossOf(member, gang);
}

/**
 * Heeft dit lid de gangrol (dus: zit het in de gang)? Boss en underboss hebben de
 * gangrol ook, dus die geven hier eveneens true.
 *
 * @param {import('discord.js').GuildMember|null|undefined} member Het lid.
 * @param {{ roleId?: string|null }|null|undefined} gang GangRecord.
 * @returns {boolean} true als het lid de gangrol heeft.
 */
function isMemberOf(member, gang) {
  return hasRole(member, gang?.roleId);
}

/**
 * Alle gangs waarvan dit lid boss of underboss is.
 *
 * @param {import('discord.js').GuildMember|null|undefined} member Het lid.
 * @param {object[]|null|undefined} gangs Lijst GangRecords.
 * @returns {object[]} GangRecords waarvan het lid leider is (lege array bij geen).
 */
function getLedGangs(member, gangs) {
  if (!member || !Array.isArray(gangs)) return [];
  return gangs.filter((gang) => isLeaderOf(member, gang));
}

/**
 * De gang waarvan dit lid de gangrol heeft (eerste match).
 *
 * @param {import('discord.js').GuildMember|null|undefined} member Het lid.
 * @param {object[]|null|undefined} gangs Lijst GangRecords.
 * @returns {object|null} Het GangRecord of null als het lid in geen enkele gang zit.
 */
function getMemberGang(member, gangs) {
  if (!member || !Array.isArray(gangs)) return null;
  return gangs.find((gang) => isMemberOf(member, gang)) || null;
}

/**
 * Kan de bot deze rol toekennen/afnemen? Dat kan alleen als de hoogste botrol
 * boven de rol staat en de rol niet door een integratie wordt beheerd.
 *
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @param {string|null|undefined} roleId Rol-id.
 * @returns {boolean} true als de bot de rol mag beheren.
 */
function botCanManageRole(guild, roleId) {
  if (!guild || !roleId || typeof roleId !== 'string') return false;
  try {
    const me = guild.members?.me;
    const role = guild.roles?.cache?.get(roleId);
    if (!me || !role) return false;
    // Beheerde rollen (bot-/boostrollen) kan niemand toekennen.
    if (role.managed) return false;
    const highest = me.roles?.highest;
    if (!highest) return false;
    return highest.comparePositionTo(role) > 0;
  } catch {
    return false;
  }
}

/**
 * Controleert welke serverrechten de bot mist.
 * Kan het niet vastgesteld worden (bot-member niet in cache), dan worden alle
 * rechten als ontbrekend gemeld — beter een valse waarschuwing dan een stille fout.
 *
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @returns {string[]} Nederlandse namen van de ontbrekende rechten (leeg = alles ok).
 */
function missingBotPermissions(guild) {
  const allLabels = REQUIRED_BOT_PERMISSIONS.map((entry) => entry.label);
  if (!guild) return allLabels;
  try {
    const me = guild.members?.me;
    const permissions = me?.permissions;
    if (!permissions || typeof permissions.has !== 'function') return allLabels;
    return REQUIRED_BOT_PERMISSIONS
      .filter((entry) => !permissions.has(entry.flag))
      .map((entry) => entry.label);
  } catch {
    return allLabels;
  }
}

module.exports = {
  isStaff,
  isBossOf,
  isUnderbossOf,
  isLeaderOf,
  isMemberOf,
  getLedGangs,
  getMemberGang,
  botCanManageRole,
  missingBotPermissions,
};
