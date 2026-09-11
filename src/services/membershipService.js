// src/services/membershipService.js
// Kern van de businesslogica rond lidmaatschap: aannemen (hire), ontslaan (fire),
// een trede op of neer langs de ladder lid > underboss > boss (promote, demote,
// setLeadership) en acties terugdraaien (revertAction).
//
// Afspraken die in dit hele bestand gelden:
//  - Elke geexporteerde functie is async en gooit NOOIT. Een fout komt terug als
//    { ok: false, code, error }: een machineleesbare code voor de aanroeper plus een
//    concrete Nederlandse melding waarin staat wat de gebruiker moet doen.
//  - Elke cache-lookup (rollen, leden) kan undefined zijn en wordt afgeschermd.
//  - Rollen worden per richting in EEN API-aanroep toegekend of verwijderd, altijd met
//    een reden voor het auditlogboek van Discord.
//  - Voordat een rol gemuteerd wordt, controleren we altijd `botCanManageRole`.

const store = require('../store');
const logger = require('../lib/logger');
const { ACTION, ROLE_KIND, ROLE_SUFFIX } = require('../lib/constants');
const { countGang, formatCapacity } = require('../lib/capacity');
const { truncate } = require('../lib/parse');
const {
  isStaff,
  isBossOf,
  isUnderbossOf,
  isLeaderOf,
  isMemberOf,
  botCanManageRole,
} = require('../lib/permissions');

/**
 * @typedef {object} Failure
 * @property {false} ok Altijd false.
 * @property {string} code Machineleesbare foutcode.
 * @property {string} error Nederlandse melding voor de gebruiker.
 * @property {object} [counts] Alleen bij LIMIT_REACHED: de telling van dat moment.
 */

/** Maximale lengte van de reden die naar het auditlogboek van Discord gaat. */
const MAX_AUDIT_REASON = 400;

/** Maximale lengte van een door de gebruiker opgegeven reden. */
const MAX_REASON = 400;

/** Toegestane waarden voor setLeadership, inclusief de Nederlandse aliassen. */
const LEADERSHIP_KINDS = {
  boss: 'boss',
  underboss: 'underboss',
  none: 'none',
  geen: 'none',
  geenrol: 'none',
  leeg: 'none',
};

/** Nederlandse labels bij de leidingssoorten. */
const LEADERSHIP_LABEL = {
  boss: 'boss',
  underboss: 'underboss',
  none: 'geen leiding',
};

/**
 * Actietypes die `revertAction` kan terugdraaien.
 *
 * HIRE_MEELOPER staat er alleen nog in voor de HISTORIE: er komen geen nieuwe acties van
 * dat type meer bij, maar onder oude logberichten staat de knop 'Terugdraaien' nog. Zo'n
 * actie wordt hier behandeld als een gewone aanname (alle gangrollen gaan er weer af).
 */
const REVERTABLE_TYPES = [ACTION.HIRE, ACTION.HIRE_MEELOPER, ACTION.FIRE];

// ---------------------------------------------------------------------------
// Kleine hulpfuncties
// ---------------------------------------------------------------------------

/**
 * Bouwt een uniform foutresultaat.
 *
 * @param {string} code Machineleesbare foutcode.
 * @param {string} error Nederlandse melding voor de gebruiker.
 * @param {object} [extra] Extra velden (bijvoorbeeld `counts` bij LIMIT_REACHED).
 * @returns {Failure} Het foutresultaat.
 */
function fail(code, error, extra = {}) {
  return { ok: false, code, error, ...extra };
}

/**
 * Leesbare naam van een lid voor meldingen (geen mention, dus zonder ping).
 *
 * @param {import('discord.js').GuildMember|null|undefined} member Het lid.
 * @returns {string} Weergavenaam, gebruikersnaam of id.
 */
function describeMember(member) {
  if (!member) return 'dit lid';
  return member.displayName
    || member.user?.globalName
    || member.user?.username
    || member.user?.tag
    || member.id
    || 'dit lid';
}

/**
 * Tag zoals we die in een ActionRecord bewaren.
 *
 * @param {import('discord.js').GuildMember|null|undefined} member Het lid.
 * @returns {string|null} De tag, of null als er geen lid is.
 */
function memberTag(member) {
  if (!member) return null;
  return member.user?.tag || member.user?.username || describeMember(member);
}

/**
 * Naam van een gangrol zoals die op de server staat ('Rayuza', 'Rayuza Boss', ...).
 *
 * @param {object|null|undefined} gang Het GangRecord.
 * @param {string} kind Rolsoort uit ROLE_KIND.
 * @returns {string} De rolnaam.
 */
function roleDisplay(gang, kind) {
  const name = gang?.name || 'de gang';
  if (kind === ROLE_KIND.GANG) return name;
  const suffix = ROLE_SUFFIX ? ROLE_SUFFIX[kind] : null;
  return suffix ? `${name} ${suffix}` : `${name} ${kind || 'rol'}`;
}

/**
 * De drie rollen van een gang als {kind, id}-paren; een id kan null zijn.
 *
 * @param {object|null|undefined} gang Het GangRecord.
 * @returns {Array<{kind: string, id: string|null}>} De rolparen in vaste volgorde.
 */
function gangRoleEntries(gang) {
  return [
    { kind: ROLE_KIND.GANG, id: gang?.roleId || null },
    { kind: ROLE_KIND.BOSS, id: gang?.bossRoleId || null },
    { kind: ROLE_KIND.UNDERBOSS, id: gang?.underbossRoleId || null },
  ];
}

/**
 * De gangrollen die dit lid daadwerkelijk heeft.
 *
 * @param {import('discord.js').GuildMember|null|undefined} member Het lid.
 * @param {object|null|undefined} gang Het GangRecord.
 * @returns {Array<{kind: string, id: string}>} De rolparen die het lid heeft.
 */
function heldGangRoles(member, gang) {
  const cache = member?.roles?.cache;
  if (!cache) return [];
  return gangRoleEntries(gang).filter((entry) => entry.id && cache.has(entry.id));
}

/**
 * Heeft dit lid deze rol? Veilig bij een ontbrekende cache of een lege id.
 *
 * @param {import('discord.js').GuildMember|null|undefined} member Het lid.
 * @param {string|null|undefined} roleId Rol-id.
 * @returns {boolean} true als het lid de rol heeft.
 */
function hasRoleId(member, roleId) {
  return Boolean(roleId && member?.roles?.cache?.has(roleId));
}

/**
 * Leest de serverconfiguratie; faalt de store, dan werken we zonder configuratie door.
 *
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @returns {object} De configuratie (mogelijk leeg).
 */
function readConfig(guild) {
  try {
    return store.getGuildConfig(guild?.id) || {};
  } catch (err) {
    logger.warn('membershipService: serverconfiguratie lezen mislukt.', err);
    return {};
  }
}

/**
 * Verwijzing naar het ontslagkanaal voor in foutmeldingen.
 *
 * @param {object|null|undefined} config Serverconfiguratie.
 * @returns {string} Een kanaalmention of de tekst '#ontslagen'.
 */
function fireChannelRef(config) {
  return config?.fireChannelId ? `<#${config.fireChannelId}>` : '#ontslagen';
}

/**
 * Alle gangs van de server, met terugval op een lege lijst.
 *
 * @param {string} guildId Discord server-id.
 * @returns {object[]} De GangRecords.
 */
function readGangs(guildId) {
  try {
    return store.listGangs(guildId) || [];
  } catch (err) {
    logger.warn('membershipService: ganglijst lezen mislukt.', err);
    return [];
  }
}

/**
 * Zoekt de andere gang waar dit lid al in zit. We kijken naar alle bekende gangs en
 * naar alle drie de rollen, zodat ook een losse leidingsrol zonder gangrol opvalt.
 *
 * @param {string} guildId Discord server-id.
 * @param {object} gang De gang waar iemand aangenomen wordt (wordt overgeslagen).
 * @param {import('discord.js').GuildMember} member Het doellid.
 * @returns {object|null} De conflicterende gang, of null.
 */
function findConflictingGang(guildId, gang, member) {
  for (const other of readGangs(guildId)) {
    if (!other || other.id === gang.id) continue;
    if (isMemberOf(member, other) || isLeaderOf(member, other)) return other;
  }
  return null;
}

/**
 * Controleert of alle opgegeven gangrollen bestaan en door de bot beheerd kunnen worden.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} gang Het GangRecord (voor nette rolnamen in de melding).
 * @param {Array<{kind: string, id: string|null}>} entries De te muteren rollen.
 * @returns {Failure|null} Een MISSING_ROLE- of HIERARCHY-fout, of null als alles kan.
 */
function checkRoles(guild, gang, entries) {
  const missing = [];
  const blocked = [];
  for (const entry of entries) {
    if (!entry || !entry.id || !guild?.roles?.cache?.get(entry.id)) {
      missing.push(roleDisplay(gang, entry?.kind));
      continue;
    }
    if (!botCanManageRole(guild, entry.id)) blocked.push(roleDisplay(gang, entry.kind));
  }
  if (missing.length) {
    return fail(
      'MISSING_ROLE',
      `De rol ${missing.join(', ')} bestaat niet meer op de server. `
        + `Laat staff /gangbeheer herstel uitvoeren voor ${gang?.name || 'deze gang'}.`,
    );
  }
  if (blocked.length) {
    return fail(
      'HIERARCHY',
      `Ik kan de rol ${blocked.join(', ')} niet beheren. Sleep de rol van de bot in `
        + 'Serverinstellingen > Rollen boven alle gangrollen en probeer het opnieuw.',
    );
  }
  return null;
}

/**
 * Basisvalidatie die voor alle acties geldt.
 *
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @param {object|null|undefined} gang Het GangRecord.
 * @param {import('discord.js').GuildMember|null|undefined} targetMember Het doellid.
 * @returns {Failure|null} Een INVALID_INPUT-fout, of null als alles bruikbaar is.
 */
function checkBasics(guild, gang, targetMember) {
  if (!guild || !guild.id) {
    return fail('INVALID_INPUT', 'Deze actie kan alleen binnen een server uitgevoerd worden.');
  }
  if (!gang || typeof gang !== 'object' || !gang.id) {
    return fail('INVALID_INPUT', 'Deze gang bestaat niet (meer). Bekijk /gang lijst voor de juiste naam.');
  }
  if (!targetMember || !targetMember.id) {
    return fail('INVALID_INPUT', 'Ik kon dit lid niet op de server vinden. Zit die persoon nog in de server?');
  }
  if (!targetMember.roles || !targetMember.roles.cache) {
    return fail(
      'INVALID_INPUT',
      `Ik kon de rollen van ${describeMember(targetMember)} niet ophalen. Probeer het zo nog een keer.`,
    );
  }
  return null;
}

/**
 * Normaliseert een door de gebruiker opgegeven reden.
 *
 * @param {*} value Ruwe reden.
 * @returns {string|null} De getrimde reden, of null.
 */
function normalizeReason(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return truncate(trimmed, MAX_REASON);
}

/**
 * Bouwt de tekst die in het auditlogboek van Discord komt te staan.
 *
 * @param {string} actionText Korte omschrijving, bijvoorbeeld 'Aangenomen bij Rayuza'.
 * @param {import('discord.js').GuildMember|null|undefined} actorMember De uitvoerder.
 * @param {string|null} [reason] Optionele reden van de gebruiker.
 * @returns {string} De (afgekapte) auditreden.
 */
function buildAuditReason(actionText, actorMember, reason) {
  const actor = actorMember ? `${memberTag(actorMember)} (${actorMember.id})` : 'de bot';
  const extra = reason ? ` - reden: ${reason}` : '';
  return truncate(`${actionText} door ${actor}${extra}`, MAX_AUDIT_REASON);
}

/**
 * Werkt de ledencache bij met de rollen zoals ze na de mutatie zijn.
 *
 * WAAROM DIT NODIG IS (niet weghalen): `member.roles.add()/remove()` doen na de
 * REST-call een `member._clone()` en zetten de nieuwe rollen op die KOPIE; het object
 * in `guild.members.cache` houdt zijn oude `_roles` tot het GUILD_MEMBER_UPDATE-frame
 * binnenkomt. `countGang` telt via `role.members` -> `guild.members.cache` ->
 * `member._roles`, en tussen een mutatie en de hertelling zitten alleen microtasks -
 * dat frame kan er dus niet tussen komen. Zonder deze sync toetst elke volgende
 * aanname in hetzelfde bericht tegen de stand van VOOR de eerste aanname (de gang
 * komt boven zijn limiet) en staat elke `counts` in de bevestiging te laag.
 * We patchen `_roles` in plaats van de kloon in de cache te zetten: dat houdt de
 * objectidentiteit intact en laat de prototypeketen niet bij elke wijziging groeien.
 *
 * @param {import('discord.js').GuildMember} member Het lid waarop gemuteerd is.
 * @param {import('discord.js').GuildMember|undefined} updated Wat discord.js teruggaf.
 * @returns {void}
 */
function syncRoleCache(member, updated) {
  const roles = updated?._roles;
  if (!member || !Array.isArray(roles)) return;
  try {
    member._roles = roles.slice();
    const cached = member.guild?.members?.cache?.get(member.id);
    if (cached && cached !== member) cached._roles = roles.slice();
  } catch (err) {
    logger.debug(`membershipService: rollencache van ${member?.id} bijwerken mislukt.`, err);
  }
}

/**
 * Voegt rollen toe of haalt ze weg met EEN API-aanroep, met try/catch eromheen.
 *
 * @param {import('discord.js').GuildMember} member Het lid.
 * @param {'add'|'remove'} mode Toevoegen of verwijderen.
 * @param {string[]} roleIds De rol-id's (mag leeg zijn: dan gebeurt er niets).
 * @param {string} reason Auditreden.
 * @returns {Promise<{ok: true, member: import('discord.js').GuildMember}|Failure>}
 *   Bij succes komt het BIJGEWERKTE lid mee. Gebruik dat verderop: een tweede mutatie
 *   op het oude object draait de eerste ongedaan, want `roles.add(array)` stelt de
 *   volledige rollenset samen uit de rollencache van dat ene object.
 */
async function mutateRoles(member, mode, roleIds, reason) {
  const ids = Array.isArray(roleIds) ? roleIds.filter(Boolean) : [];
  if (!ids.length) return { ok: true, member };
  const verbPast = mode === 'add' ? 'toegekend' : 'verwijderd';
  const verbInf = mode === 'add' ? 'toekennen' : 'verwijderen';
  try {
    const updated = mode === 'add'
      ? await member.roles.add(ids, reason)
      : await member.roles.remove(ids, reason);
    syncRoleCache(member, updated);
    return { ok: true, member: updated || member };
  } catch (err) {
    logger.error(`membershipService: rollen ${verbInf} mislukt voor ${member?.id}.`, err);
    const detail = err && err.code === 50013
      ? 'De bot mist het recht "Rollen beheren" of staat te laag in de rollijst.'
      : `Discord meldde: ${truncate(String(err?.message || err || 'onbekende fout'), 150)}`;
    return fail('DISCORD_ERROR', `De rollen konden niet ${verbPast} worden. ${detail}`);
  }
}

/**
 * Slaat een actie op. Lukt dat niet, dan gaat de bot door met een niet-bewaard record
 * (id = null), zodat een aanroeper nooit op een ontbrekend object stukloopt.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} fields De actievelden.
 * @returns {object} Het opgeslagen (of vervangende) ActionRecord.
 */
function recordAction(guild, fields) {
  const base = {
    type: ACTION.MANUAL,
    gangId: null,
    gangName: null,
    targetId: null,
    targetTag: null,
    actorId: null,
    actorTag: null,
    reason: null,
    ...fields,
  };
  try {
    const saved = store.addAction(guild?.id, base);
    if (saved) return saved;
    logger.error(`membershipService: actie '${base.type}' kon niet opgeslagen worden.`);
  } catch (err) {
    logger.error('membershipService: actie opslaan mislukt.', err);
  }
  return {
    id: null,
    createdAt: Date.now(),
    reverted: false,
    revertedBy: null,
    revertedAt: null,
    logMessageId: null,
    logChannelId: null,
    ...base,
  };
}

/**
 * Haalt een lid op uit de cache of via de API.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {string|null|undefined} userId Gebruikers-id.
 * @returns {Promise<import('discord.js').GuildMember|null>} Het lid, of null.
 */
async function fetchMember(guild, userId) {
  if (!userId) return null;
  const cached = guild?.members?.cache?.get(userId);
  if (cached) return cached;
  try {
    return await guild.members.fetch(userId);
  } catch (err) {
    logger.debug(`membershipService: lid ${userId} niet gevonden op de server.`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Limietcontrole
// ---------------------------------------------------------------------------

/**
 * Controleert de ledenlimiet voor een aanname. Een gang kent nog maar een soort lid, dus
 * `memberFull` is de enige grens: iedereen met de gangrol telt mee, boss en underboss
 * inbegrepen.
 *
 * @param {object} gang Het GangRecord.
 * @param {object} counts Telling uit countGang.
 * @param {object} config Serverconfiguratie (voor de verwijzing naar #ontslagen).
 * @param {boolean} staff Is de uitvoerder staff? (bepaalt de tip in de melding)
 * @returns {Failure|null} Een LIMIT_REACHED-fout, of null als er plek is.
 */
function checkLimits(gang, counts, config, staff) {
  if (!counts || !counts.memberFull) return null;
  const staffTip = staff ? ' Staff kan de limiet verhogen met /gangbeheer limiet leden:<aantal>.' : '';
  return fail(
    'LIMIT_REACHED',
    `${gang.name} zit vol (${counts.members}/${counts.memberLimit} leden). `
      + `Ontsla eerst iemand in ${fireChannelRef(config)}.${staffTip}`,
    { counts },
  );
}

// ---------------------------------------------------------------------------
// hire
// ---------------------------------------------------------------------------

/**
 * Controleert alle niet-capaciteitsregels voor het aannemen van een lid.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} gang Het GangRecord.
 * @param {import('discord.js').GuildMember} targetMember Het doellid.
 * @param {import('discord.js').GuildMember|null} actorMember De uitvoerder.
 * @param {{staff: boolean}} ctx Context.
 * @returns {Failure|null} De eerste overtreding, of null.
 */
function checkHire(guild, gang, targetMember, actorMember, ctx) {
  const { staff } = ctx;
  const label = describeMember(targetMember);

  if (!staff && !isLeaderOf(actorMember, gang)) {
    return fail('NOT_LEADER', `Alleen de boss of underboss van ${gang.name} (of staff) mag hier iemand aannemen.`);
  }
  if (targetMember.user?.bot) {
    return fail('TARGET_IS_BOT', `${label} is een bot; bots kun je niet in een gang aannemen.`);
  }

  const roleProblem = checkRoles(guild, gang, [{ kind: ROLE_KIND.GANG, id: gang.roleId }]);
  if (roleProblem) return roleProblem;

  if (isMemberOf(targetMember, gang)) {
    return fail('ALREADY_MEMBER', `${label} zit al bij ${gang.name}.`);
  }

  const other = findConflictingGang(guild.id, gang, targetMember);
  if (other) {
    return fail(
      'OTHER_GANG',
      `${label} zit al bij ${other.name}. Laat ${other.name} die persoon eerst ontslaan `
        + `voordat je hem bij ${gang.name} aanneemt.`,
    );
  }
  return null;
}

/**
 * Neemt een lid aan bij een gang. Er is nog maar een soort lid: de persoon krijgt de
 * gangrol en telt daarmee mee voor de ledenlimiet.
 *
 * Foutcodes: `INVALID_INPUT`, `NOT_LEADER`, `TARGET_IS_BOT`, `MISSING_ROLE`,
 * `ALREADY_MEMBER`, `OTHER_GANG`, `LIMIT_REACHED`, `HIERARCHY`, `DISCORD_ERROR`.
 * Bij `LIMIT_REACHED` komt `counts` mee in het foutresultaat.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} gang Het GangRecord van de gang.
 * @param {import('discord.js').GuildMember} targetMember Wie aangenomen wordt.
 * @param {import('discord.js').GuildMember|null} actorMember Wie de actie uitvoert.
 * @param {{reason?: string|null, bypassLimit?: boolean}} [opts]
 *   `reason` = vrije reden; `bypassLimit` = ledenlimiet negeren (wordt voor niet-staff
 *   stil genegeerd).
 * @returns {Promise<{ok: true, action: object, counts: object}|Failure>}
 *   Bij succes de vastgelegde actie en een VERSE telling.
 */
async function hire(guild, gang, targetMember, actorMember, opts = {}) {
  const invalid = checkBasics(guild, gang, targetMember);
  if (invalid) return invalid;

  const options = opts && typeof opts === 'object' ? opts : {};
  const config = readConfig(guild);
  const staff = isStaff(actorMember, config);
  const reason = normalizeReason(options.reason);
  // Alleen staff mag de limiet omzeilen; bij anderen negeren we de vlag stil.
  const bypassLimit = options.bypassLimit === true && staff;

  const problem = checkHire(guild, gang, targetMember, actorMember, { staff });
  if (problem) return problem;

  const before = countGang(guild, gang);
  if (!bypassLimit) {
    const limitProblem = checkLimits(gang, before, config, staff);
    if (limitProblem) return limitProblem;
  }

  const toAdd = [gang.roleId].filter((id) => id && !hasRoleId(targetMember, id));
  const auditReason = buildAuditReason(`Aangenomen bij ${gang.name}`, actorMember, reason);
  const applied = await mutateRoles(targetMember, 'add', toAdd, auditReason);
  if (!applied.ok) return applied;
  // Verder met het BIJGEWERKTE lid: het meegegeven object heeft nog de rollen van voor
  // de mutatie (discord.js patcht een kloon), dus elke rolcheck erop valt verkeerd uit.
  const target = applied.member || targetMember;

  const action = recordAction(guild, {
    type: ACTION.HIRE,
    gangId: gang.id,
    gangName: gang.name,
    targetId: target.id,
    targetTag: memberTag(target),
    actorId: actorMember?.id || null,
    actorTag: memberTag(actorMember),
    reason,
    // Extra velden voor revertAction en de historie (blijven bewaard in de store).
    addedRoleIds: toAdd,
    bypassedLimit: bypassLimit && before.memberFull === true,
  });

  // countGang leest de ledencache die mutateRoles zojuist bijgewerkt heeft; dit is dus
  // een VERSE telling waarin deze aanname al meetelt.
  const counts = countGang(guild, gang);
  logger.info(
    `${gang.name}: ${memberTag(target)} aangenomen door ${memberTag(actorMember) || 'de bot'} `
      + `- ${formatCapacity(counts)}.`,
  );
  return { ok: true, action, counts };
}

// ---------------------------------------------------------------------------
// fire
// ---------------------------------------------------------------------------

/**
 * Controleert alle regels voor het ontslaan van een lid, inclusief de
 * beschermingsregels rond boss en underboss.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} gang Het GangRecord.
 * @param {import('discord.js').GuildMember} targetMember Het doellid.
 * @param {import('discord.js').GuildMember|null} actorMember De uitvoerder.
 * @param {{staff: boolean, held: Array<{kind: string, id: string}>}} ctx Context.
 * @returns {Failure|null} De eerste overtreding, of null.
 */
function checkFire(guild, gang, targetMember, actorMember, ctx) {
  const { staff, held } = ctx;
  const label = describeMember(targetMember);

  if (!staff && !isLeaderOf(actorMember, gang)) {
    return fail('NOT_LEADER', `Alleen de boss of underboss van ${gang.name} (of staff) mag hier iemand ontslaan.`);
  }
  if (!held.length) {
    return fail('NOT_MEMBER', `${label} zit niet bij ${gang.name} en kan daar dus niet ontslagen worden.`);
  }

  const targetIsBoss = isBossOf(targetMember, gang);
  const targetIsUnderboss = isUnderbossOf(targetMember, gang);
  const isSelf = Boolean(actorMember?.id) && actorMember.id === targetMember.id;

  if (isSelf && targetIsBoss && !staff) {
    return fail(
      'SELF',
      `Je kunt jezelf niet als boss van ${gang.name} ontslaan. Vraag staff om je met `
        + '`/gang degradeer` eerst een trede omlaag te zetten.',
    );
  }
  if (targetIsBoss && !staff) {
    return fail('PROTECTED', `${label} is de boss van ${gang.name}. Alleen staff mag de boss ontslaan.`);
  }
  if (targetIsUnderboss && !staff && !isBossOf(actorMember, gang)) {
    return fail(
      'PROTECTED',
      `${label} is underboss van ${gang.name}. Alleen de boss van de gang of staff mag een underboss ontslaan.`,
    );
  }

  return checkRoles(guild, gang, held);
}

/**
 * Ontslaat een lid bij een gang: alle gangrollen die de persoon heeft (gangrol, boss,
 * underboss) worden in EEN roles.remove-aanroep verwijderd.
 *
 * Foutcodes: `INVALID_INPUT`, `NOT_LEADER`, `NOT_MEMBER`, `SELF`, `PROTECTED`,
 * `MISSING_ROLE`, `HIERARCHY`, `DISCORD_ERROR`.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} gang Het GangRecord van de gang.
 * @param {import('discord.js').GuildMember} targetMember Wie ontslagen wordt.
 * @param {import('discord.js').GuildMember|null} actorMember Wie de actie uitvoert.
 * @param {{reason?: string|null}} [opts] Optionele reden voor het logboek.
 * @returns {Promise<{ok: true, action: object, counts: object, removedLeadership: boolean}|Failure>}
 *   Bij succes de vastgelegde actie, een VERSE telling en of er een leidingsrol afging.
 */
async function fire(guild, gang, targetMember, actorMember, opts = {}) {
  const invalid = checkBasics(guild, gang, targetMember);
  if (invalid) return invalid;

  const options = opts && typeof opts === 'object' ? opts : {};
  const config = readConfig(guild);
  const staff = isStaff(actorMember, config);
  const reason = normalizeReason(options.reason);
  const held = heldGangRoles(targetMember, gang);

  const problem = checkFire(guild, gang, targetMember, actorMember, { staff, held });
  if (problem) return problem;

  const kinds = held.map((entry) => entry.kind);
  const leadershipKinds = kinds.filter((kind) => kind === ROLE_KIND.BOSS || kind === ROLE_KIND.UNDERBOSS);
  const auditReason = buildAuditReason(`Ontslagen bij ${gang.name}`, actorMember, reason);

  const applied = await mutateRoles(targetMember, 'remove', held.map((entry) => entry.id), auditReason);
  if (!applied.ok) return applied;
  // Verder met het BIJGEWERKTE lid; zie de toelichting bij syncRoleCache.
  const target = applied.member || targetMember;

  const action = recordAction(guild, {
    type: ACTION.FIRE,
    gangId: gang.id,
    gangName: gang.name,
    targetId: target.id,
    targetTag: memberTag(target),
    actorId: actorMember?.id || null,
    actorTag: memberTag(actorMember),
    reason,
    // Extra velden zodat revertAction precies weet wat er weggehaald is.
    removedRoleIds: held.map((entry) => entry.id),
    removedRoleKinds: kinds,
    hadLeadership: leadershipKinds,
  });

  // Verse telling: de ledencache is door mutateRoles al bijgewerkt.
  const counts = countGang(guild, gang);
  logger.info(
    `${gang.name}: ${memberTag(target)} ontslagen door ${memberTag(actorMember) || 'de bot'} `
      + `- ${formatCapacity(counts)}.`,
  );
  return { ok: true, action, counts, removedLeadership: leadershipKinds.length > 0 };
}

// ---------------------------------------------------------------------------
// setLeadership
// ---------------------------------------------------------------------------

/**
 * Bepaalt welke rollen er weg moeten en bij moeten komen voor een leidingswijziging.
 * De oude leidingsrol gaat er altijd eerst af en bij boss/underboss zorgen we dat de
 * persoon ook de gewone gangrol heeft.
 *
 * @param {object} gang Het GangRecord.
 * @param {import('discord.js').GuildMember} targetMember Het doellid.
 * @param {'boss'|'underboss'|'none'} kind De gewenste situatie.
 * @returns {{remove: Array<{kind: string, id: string}>, add: Array<{kind: string, id: string|null}>, changes: string[]}}
 *   Het plan plus een Nederlandse omschrijving van elke wijziging.
 */
function planLeadership(gang, targetMember, kind) {
  const remove = [];
  const add = [];
  const changes = [];
  const label = describeMember(targetMember);

  if (kind === 'none') {
    if (hasRoleId(targetMember, gang.bossRoleId)) remove.push({ kind: ROLE_KIND.BOSS, id: gang.bossRoleId });
    if (hasRoleId(targetMember, gang.underbossRoleId)) {
      remove.push({ kind: ROLE_KIND.UNDERBOSS, id: gang.underbossRoleId });
    }
    remove.forEach((entry) => changes.push(`Rol ${roleDisplay(gang, entry.kind)} verwijderd.`));
    changes.push(`${label} heeft geen leidingsrol meer bij ${gang.name} en blijft gewoon lid.`);
    return { remove, add, changes };
  }

  const keepId = kind === 'boss' ? gang.bossRoleId : gang.underbossRoleId;
  const dropKind = kind === 'boss' ? ROLE_KIND.UNDERBOSS : ROLE_KIND.BOSS;
  const dropId = kind === 'boss' ? gang.underbossRoleId : gang.bossRoleId;

  if (hasRoleId(targetMember, dropId)) {
    remove.push({ kind: dropKind, id: dropId });
    changes.push(`Oude rol ${roleDisplay(gang, dropKind)} verwijderd.`);
  }
  if (!hasRoleId(targetMember, gang.roleId)) {
    add.push({ kind: ROLE_KIND.GANG, id: gang.roleId });
    changes.push(`Gangrol ${roleDisplay(gang, ROLE_KIND.GANG)} toegekend.`);
  }
  add.push({ kind, id: keepId });
  changes.push(`${label} is nu ${LEADERSHIP_LABEL[kind]} van ${gang.name}.`);
  return { remove, add, changes };
}

/**
 * Bepaalt of de aanroeper deze leidingswijziging überhaupt mag doen.
 *
 * Staff mag alles. De boss van de gang mag zijn eigen underbosses aanstellen en
 * intrekken, maar niemand tot boss maken en geen mede-boss degraderen — een
 * bosswissel is een overdracht van de hele gang en blijft bij staff liggen.
 *
 * @param {object} gang De gang.
 * @param {import('discord.js').GuildMember} targetMember Wie de rol krijgt of verliest.
 * @param {import('discord.js').GuildMember} actorMember Wie de wijziging doet.
 * @param {'boss'|'underboss'|'none'} kind De gevraagde rol.
 * @param {object} config De guildconfiguratie (voor de staffrol).
 * @returns {Failure|null} Een fout, of null als het mag.
 */
function checkLeadershipActor(gang, targetMember, actorMember, kind, config) {
  if (isStaff(actorMember, config)) return null;

  if (!actorMember || !isBossOf(actorMember, gang)) {
    return fail(
      'NOT_ALLOWED',
      `Alleen staff of de boss van ${gang.name} mag de leiding aanpassen.`,
    );
  }
  if (kind === 'boss') {
    return fail(
      'NOT_ALLOWED',
      `Alleen staff mag iemand tot boss van ${gang.name} maken. Vraag een staflid om de overdracht.`,
    );
  }
  // Aan een zittende boss mag een andere boss NIETS veranderen - ook niet hem "slechts"
  // naar underboss terugzetten. Eerder keek deze controle alleen naar kind === 'none',
  // waardoor een boss zijn mede-boss alsnog kon wegwerken via de underboss-trede.
  if (isBossOf(targetMember, gang)) {
    return fail(
      'NOT_ALLOWED',
      `${describeMember(targetMember)} is boss van ${gang.name}; alleen staff kan daar iets `
        + 'aan veranderen.',
    );
  }
  return null;
}

/**
 * Controleert de inhoudelijke voorwaarden voor een leidingswijziging: verandert er wel
 * iets, zit de persoon niet al bij een andere gang, en is er nog een boss- of
 * underbossplek vrij?
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} gang Het GangRecord.
 * @param {import('discord.js').GuildMember} targetMember Het doellid.
 * @param {'boss'|'underboss'|'none'} kind De gewenste situatie.
 * @returns {Failure|null} De eerste overtreding, of null.
 */
function checkLeadership(guild, gang, targetMember, kind) {
  const label = describeMember(targetMember);
  if (targetMember.user?.bot) {
    return fail('TARGET_IS_BOT', `${label} is een bot; een bot kan geen leiding van een gang zijn.`);
  }
  if (kind === 'boss' && isBossOf(targetMember, gang)) {
    return fail('NO_CHANGE', `${label} is al boss van ${gang.name}.`);
  }
  if (kind === 'underboss' && isUnderbossOf(targetMember, gang)) {
    return fail('NO_CHANGE', `${label} is al underboss van ${gang.name}.`);
  }
  if (kind === 'none' && !isLeaderOf(targetMember, gang)) {
    return fail('NO_CHANGE', `${label} heeft helemaal geen leidingsrol bij ${gang.name}.`);
  }
  if (kind !== 'none') {
    const other = findConflictingGang(guild.id, gang, targetMember);
    if (other) {
      return fail(
        'OTHER_GANG',
        `${label} zit al bij ${other.name}. Laat die persoon daar eerst ontslaan voordat je `
          + `hem de leiding van ${gang.name} geeft.`,
      );
    }

    // Leidingslimiet. De target zelf telt niet mee: wie al underboss is en boss wordt,
    // maakt zijn underbossplek immers vrij.
    const counts = countGang(guild, gang);
    const bezet = (kind === 'boss' ? counts.bossIds : counts.underbossIds)
      .filter((id) => id !== targetMember.id).length;
    const limiet = kind === 'boss' ? counts.bossLimit : counts.underbossLimit;
    if (bezet >= limiet) {
      const meervoud = kind === 'boss' ? 'bosses' : 'underbosses';
      const optie = kind === 'boss' ? 'bosses' : 'underbosses';
      return fail(
        'LEADERSHIP_FULL',
        `${gang.name} heeft al ${bezet}/${limiet} ${meervoud}. Degradeer er eerst één met `
          + `\`/gang degradeer\`, of verhoog de limiet met \`/gangbeheer limiet ${optie}:<aantal>\`.`,
        { counts },
      );
    }
  }
  return null;
}

/**
 * Toetst of een leidingswijziging de gang niet boven de ledenlimiet duwt.
 *
 * WAAROM DIT MOET (niet weghalen): planLeadership kent actief lidmaatschap toe. Een
 * buitenstaander die tot boss of underboss gemaakt wordt, krijgt de gangrol erbij en
 * telt vanaf dat moment mee. Zonder deze controle is /gang promoveer een omweg langs
 * memberLimit. Zit de persoon al in de gang, dan verandert de bezetting niet en mag de
 * ledenlimiet hem nooit tegenhouden - vandaar de toets op de GEPROJECTEERDE telling.
 * Promoveren kent bewust geen bypassLimit; de melding wijst staff naar /gangbeheer limiet.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} gang Het GangRecord.
 * @param {{remove: Array<{kind: string}>, add: Array<{kind: string}>}} plan Het rolplan.
 * @param {'boss'|'underboss'|'none'} normalized De gewenste situatie.
 * @param {object} config Serverconfiguratie (voor de verwijzing naar #ontslagen).
 * @returns {Failure|null} Een LIMIT_REACHED-fout, of null als het past.
 */
function checkLeadershipLimits(guild, gang, plan, normalized, config) {
  if (normalized === 'none') return null;
  if (!plan.add.some((entry) => entry.kind === ROLE_KIND.GANG)) return null;

  const before = countGang(guild, gang);
  const members = before.members + 1;
  if (members <= before.memberLimit) return null;

  return fail(
    'LIMIT_REACHED',
    `${gang.name} komt hierdoor boven de limiet (${members}/${before.memberLimit} leden). `
      + `Ontsla eerst iemand in ${fireChannelRef(config)} of verhoog de limiet met `
      + '/gangbeheer limiet leden:<aantal>.',
    { counts: before },
  );
}

/**
 * Zet iemand als boss of underboss van een gang, of trekt de leidingsrol in. Een
 * eventuele oude leidingsrol gaat er eerst af en de persoon krijgt bij boss/underboss
 * altijd ook de gewone gangrol.
 *
 * Rechten: staff mag alles; de boss van de gang mag zijn eigen underbosses aanstellen en
 * intrekken (zie checkLeadershipActor).
 *
 * Foutcodes: `INVALID_INPUT`, `NOT_ALLOWED`, `INVALID_KIND`, `TARGET_IS_BOT`,
 * `NO_CHANGE`, `OTHER_GANG`, `LEADERSHIP_FULL`, `LIMIT_REACHED`, `MISSING_ROLE`,
 * `HIERARCHY`, `DISCORD_ERROR`.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} gang Het GangRecord van de gang.
 * @param {import('discord.js').GuildMember} targetMember Wie de rol krijgt of verliest.
 * @param {import('discord.js').GuildMember|null} actorMember Wie de actie uitvoert.
 * @param {'boss'|'underboss'|'none'} kind Gewenste situatie ('geen' wordt ook geaccepteerd).
 * @param {{reason?: string|null}} [opts] Optionele reden; die gaat mee naar het
 *   auditlogboek van Discord en naar het ActionRecord.
 * @returns {Promise<{ok: true, action: object, counts: object, kind: string, changes: string[]}|Failure>}
 *   Bij succes de vastgelegde actie, een verse telling en wat er precies gewijzigd is.
 */
async function setLeadership(guild, gang, targetMember, actorMember, kind, opts = {}) {
  const invalid = checkBasics(guild, gang, targetMember);
  if (invalid) return invalid;

  const options = opts && typeof opts === 'object' ? opts : {};
  const reason = normalizeReason(options.reason);
  const config = readConfig(guild);
  const normalized = LEADERSHIP_KINDS[String(kind ?? '').trim().toLowerCase().replace(/\s+/g, '')];
  if (!normalized) {
    return fail('INVALID_KIND', "Kies 'boss', 'underboss' of 'geen' als rol.");
  }

  const notAllowed = checkLeadershipActor(gang, targetMember, actorMember, normalized, config);
  if (notAllowed) return notAllowed;

  const problem = checkLeadership(guild, gang, targetMember, normalized);
  if (problem) return problem;

  const plan = planLeadership(gang, targetMember, normalized);
  const roleProblem = checkRoles(guild, gang, [...plan.remove, ...plan.add]);
  if (roleProblem) return roleProblem;

  // Een promotie kan iemand nieuw lid maken; dezelfde limieten gelden dan als bij hire.
  const limitProblem = checkLeadershipLimits(guild, gang, plan, normalized, config);
  if (limitProblem) return limitProblem;

  const auditReason = buildAuditReason(
    `Leiding van ${gang.name} gezet op ${LEADERSHIP_LABEL[normalized]}`,
    actorMember,
    reason,
  );
  const removed = await mutateRoles(targetMember, 'remove', plan.remove.map((entry) => entry.id), auditReason);
  if (!removed.ok) return removed;
  // De tweede mutatie MOET op het bijgewerkte lid draaien: roles.add(array) stelt de
  // volledige rollenset samen uit de rollencache van dat object, dus op het oude object
  // zou de zojuist verwijderde rol er meteen weer bij komen.
  const afterRemove = removed.member || targetMember;
  const added = await mutateRoles(afterRemove, 'add', plan.add.map((entry) => entry.id), auditReason);
  if (!added.ok) return added;
  const target = added.member || afterRemove;

  const action = recordAction(guild, {
    type: ACTION.LEADERSHIP,
    gangId: gang.id,
    gangName: gang.name,
    targetId: target.id,
    targetTag: memberTag(target),
    actorId: actorMember?.id || null,
    actorTag: memberTag(actorMember),
    // De trede staat voorop zodat het logboek laat zien WAT er veranderde; de reden van de
    // gebruiker gaat er onverkort achteraan in plaats van verloren te gaan.
    reason: truncate(
      `Leiding: ${LEADERSHIP_LABEL[normalized]}${reason ? ` - reden: ${reason}` : ''}`,
      MAX_REASON,
    ),
    leadership: normalized,
  });

  // Verse telling: mutateRoles heeft de ledencache al bijgewerkt.
  const counts = countGang(guild, gang);
  logger.info(
    `${gang.name}: ${memberTag(target)} gezet op ${LEADERSHIP_LABEL[normalized]} `
      + `door ${memberTag(actorMember) || 'de bot'}.`,
  );
  return { ok: true, action, counts, kind: normalized, changes: plan.changes };
}

// ---------------------------------------------------------------------------
// promote / demote — de ladder lid > underboss > boss
// ---------------------------------------------------------------------------

/** De treden van laag naar hoog. */
const LADDER = ['lid', 'underboss', 'boss'];

/** Nederlandse omschrijving per trede, voor meldingen. */
const LADDER_LABEL = {
  lid: 'gewoon lid',
  underboss: 'underboss',
  boss: 'boss',
};

/**
 * Op welke trede staat dit lid binnen deze gang?
 *
 * Volgorde is belangrijk: boss en underboss hebben de gangrol ook, dus die moeten vóór
 * 'lid' getoetst worden.
 *
 * @param {import('discord.js').GuildMember} member Het lid.
 * @param {object} gang Het GangRecord.
 * @returns {'lid'|'underboss'|'boss'|null} De trede, of null als het lid niet bij deze
 *   gang hoort.
 */
function currentRung(member, gang) {
  if (isBossOf(member, gang)) return 'boss';
  if (isUnderbossOf(member, gang)) return 'underboss';
  if (isMemberOf(member, gang)) return 'lid';
  return null;
}

/**
 * Zet iemand één trede hoger: lid > underboss > boss.
 *
 * De rechten komen uit setLeadership: de boss van de gang stelt zijn eigen underbosses
 * aan, maar iemand tot boss maken blijft bij staff.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} gang Het GangRecord.
 * @param {import('discord.js').GuildMember} targetMember Het doellid.
 * @param {import('discord.js').GuildMember|null} actorMember De uitvoerder.
 * @param {{reason?: string|null}} [opts] Opties; `reason` gaat mee naar het auditlogboek
 *   van Discord en naar het ActionRecord.
 * @returns {Promise<{ok: true, action: object, counts: object, van: string, naar: string}|Failure>}
 *   Het resultaat, met de trede van en naar.
 */
async function promote(guild, gang, targetMember, actorMember, opts = {}) {
  const invalid = checkBasics(guild, gang, targetMember);
  if (invalid) return invalid;

  const options = opts && typeof opts === 'object' ? opts : {};
  const rung = currentRung(targetMember, gang);
  if (!rung) {
    return fail(
      'NOT_MEMBER',
      `${describeMember(targetMember)} zit niet bij ${gang.name}. Neem die persoon eerst aan `
        + 'met `/gang aannemen` voordat je hem promoveert.',
    );
  }
  if (rung === 'boss') {
    return fail(
      'NO_CHANGE',
      `${describeMember(targetMember)} is al boss van ${gang.name}; hoger dan dat gaat niet.`,
    );
  }

  const naar = LADDER[LADDER.indexOf(rung) + 1];
  const result = await setLeadership(guild, gang, targetMember, actorMember, naar, {
    reason: options.reason,
  });
  if (!result.ok) return result;

  logger.info(
    `${gang.name}: ${memberTag(targetMember)} gepromoveerd van ${rung} naar ${naar} `
      + `door ${memberTag(actorMember) || 'de bot'}.`,
  );
  return { ...result, van: rung, naar, vanLabel: LADDER_LABEL[rung], naarLabel: LADDER_LABEL[naar] };
}

/**
 * Zet iemand één trede lager: boss > underboss > lid.
 *
 * Onder 'lid' zit niets meer; wie daaronder moet, hoort ontslagen te worden.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} gang Het GangRecord.
 * @param {import('discord.js').GuildMember} targetMember Het doellid.
 * @param {import('discord.js').GuildMember|null} actorMember De uitvoerder.
 * @param {{reason?: string|null}} [opts] Opties; `reason` gaat mee naar het auditlogboek
 *   van Discord en naar het ActionRecord.
 * @returns {Promise<{ok: true, action: object, counts: object, van: string, naar: string}|Failure>}
 *   Het resultaat, met de trede van en naar.
 */
async function demote(guild, gang, targetMember, actorMember, opts = {}) {
  const invalid = checkBasics(guild, gang, targetMember);
  if (invalid) return invalid;

  const options = opts && typeof opts === 'object' ? opts : {};
  const rung = currentRung(targetMember, gang);
  if (!rung) {
    return fail(
      'NOT_MEMBER',
      `${describeMember(targetMember)} zit niet bij ${gang.name}, dus er valt niets te degraderen.`,
    );
  }
  if (rung === 'lid') {
    const config = readConfig(guild);
    return fail(
      'NO_CHANGE',
      `${describeMember(targetMember)} is gewoon lid van ${gang.name} — lager gaat de ladder `
        + 'niet. Wil je die persoon helemaal uit de gang hebben, gebruik dan `/gang ontslaan` '
        + `of het kanaal ${fireChannelRef(config)}.`,
    );
  }

  const naar = LADDER[LADDER.indexOf(rung) - 1];
  const result = await setLeadership(
    guild,
    gang,
    targetMember,
    actorMember,
    naar === 'lid' ? 'none' : naar,
    { reason: options.reason },
  );
  if (!result.ok) return result;

  logger.info(
    `${gang.name}: ${memberTag(targetMember)} gedegradeerd van ${rung} naar ${naar} `
      + `door ${memberTag(actorMember) || 'de bot'}.`,
  );
  return { ...result, van: rung, naar, vanLabel: LADDER_LABEL[rung], naarLabel: LADDER_LABEL[naar] };
}

// ---------------------------------------------------------------------------
// revertAction
// ---------------------------------------------------------------------------

/**
 * Zoekt de gang die bij een actie hoort (eerst op id, dan op naam).
 *
 * @param {string} guildId Discord server-id.
 * @param {object} action Het ActionRecord.
 * @returns {object|null} Het GangRecord, of null.
 */
function findGangForAction(guildId, action) {
  try {
    if (action.gangId !== null && action.gangId !== undefined) {
      const byId = store.findGang(guildId, action.gangId);
      if (byId) return byId;
    }
    if (action.gangName) return store.findGang(guildId, action.gangName);
  } catch (err) {
    logger.warn('membershipService: gang bij actie opzoeken mislukt.', err);
  }
  return null;
}

/**
 * Plan voor het terugdraaien van een aanname: alle gangrollen die de persoon nog van
 * deze gang heeft gaan eraf, zodat er geen losse boss- of underbossrol achterblijft.
 *
 * @param {object} gang Het GangRecord.
 * @param {import('discord.js').GuildMember} target Het doellid.
 * @returns {{remove: Array<{kind: string, id: string}>, add: Array<{kind: string, id: string}>, notes: string[], summary: string}}
 *   Het plan met Nederlandse toelichting.
 */
function planRevertHire(gang, target) {
  const remove = heldGangRoles(target, gang);
  const notes = [];
  const leadership = remove.filter((entry) => entry.kind === ROLE_KIND.BOSS || entry.kind === ROLE_KIND.UNDERBOSS);
  if (leadership.length) {
    notes.push(
      `Ook de leidingsrol ${leadership.map((entry) => roleDisplay(gang, entry.kind)).join(' en ')} `
        + 'is verwijderd, zodat er geen losse rol achterblijft.',
    );
  }
  if (!remove.length) {
    notes.push(`${describeMember(target)} had de rollen van ${gang.name} al niet meer.`);
  }
  return {
    remove,
    add: [],
    notes,
    summary: `${describeMember(target)} is weer uit ${gang.name} gehaald.`,
  };
}

/**
 * Plan voor het terugdraaien van een ontslag: de gangrol komt terug. Leidingsrollen komen
 * NOOIT automatisch terug; dat wordt in de notities gemeld.
 *
 * @param {object} gang Het GangRecord.
 * @param {object} action Het ActionRecord van het ontslag.
 * @param {import('discord.js').GuildMember} target Het doellid.
 * @returns {{remove: Array<{kind: string, id: string}>, add: Array<{kind: string, id: string}>, notes: string[], summary: string}}
 *   Het plan met Nederlandse toelichting.
 */
function planRevertFire(gang, action, target) {
  const add = [];
  const notes = [];

  if (!hasRoleId(target, gang.roleId)) add.push({ kind: ROLE_KIND.GANG, id: gang.roleId });

  const hadLeadership = Array.isArray(action.hadLeadership) ? action.hadLeadership : [];
  if (hadLeadership.length) {
    notes.push(
      `Let op: ${describeMember(target)} was ${hadLeadership.map((kind) => LEADERSHIP_LABEL[kind] || kind).join(' en ')} `
        + `van ${gang.name}. Die rol is NIET automatisch teruggezet - zet die er met `
        + '`/gang promoveer` weer op.',
    );
  } else {
    notes.push(
      'Let op: eventuele boss- of underbossrollen worden nooit automatisch teruggezet; '
        + 'gebruik daarvoor `/gang promoveer`.',
    );
  }
  if (!add.length) notes.push(`${describeMember(target)} had de rol van ${gang.name} al weer terug.`);

  return {
    remove: [],
    add,
    notes,
    summary: `${describeMember(target)} heeft de rollen van ${gang.name} weer terug.`,
  };
}

/**
 * Controleert of een ontslag nog wel teruggedraaid MAG worden.
 *
 * WAAROM DIT MOET (niet weghalen): terugdraaien van een ontslag voegt iemand OPNIEUW
 * toe aan de gang, dus gelden dezelfde regels als bij een gewone aanname. De knop
 * "Terugdraaien" blijft onder elk oud logbericht staan, dus er kan van alles tussen
 * zitten: is de persoon inmiddels bij een andere gang aangenomen, dan zou hij in twee
 * gangs belanden (dubbel geteld, beide categorieen zichtbaar), en zat de gang
 * ondertussen vol, dan liep hij over met alleen een notitie achteraf terwijl de rollen
 * al toegekend waren.
 *
 * We hangen de controle aan het feit dat de GANGROL echt bij komt, niet aan het
 * actietype alleen: heeft de persoon die rol nog, dan telt hij al mee en zou de controle
 * een no-op blokkeren.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} gang Het GangRecord van de actie.
 * @param {object} action Het ActionRecord dat teruggedraaid wordt.
 * @param {import('discord.js').GuildMember} target Het doellid.
 * @param {{add: Array<{kind: string}>}} plan Het rolplan uit planRevertFire.
 * @param {object} config Serverconfiguratie.
 * @param {boolean} staff Is de uitvoerder staff? (bepaalt de tip in de melding)
 * @returns {Failure|null} Een OTHER_GANG- of LIMIT_REACHED-fout, of null.
 */
function checkRevertRestore(guild, gang, action, target, plan, config, staff) {
  if (action.type !== ACTION.FIRE) return null;
  if (!plan.add.some((entry) => entry.kind === ROLE_KIND.GANG)) return null;

  const actionId = action.id === null || action.id === undefined ? '?' : action.id;
  const other = findConflictingGang(guild.id, gang, target);
  if (other) {
    return fail(
      'OTHER_GANG',
      `${describeMember(target)} zit inmiddels bij ${other.name}. Laat ${other.name} die persoon `
        + `eerst ontslaan in ${fireChannelRef(config)}; daarna kun je actie #${actionId} alsnog terugdraaien.`,
    );
  }

  return checkLimits(gang, countGang(guild, gang), config, staff);
}

/**
 * Markeert de oorspronkelijke actie als teruggedraaid in de opslag.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} action Het oorspronkelijke ActionRecord.
 * @param {import('discord.js').GuildMember|null} actorMember Wie terugdraait.
 * @param {string[]} notes Notitielijst die zo nodig aangevuld wordt.
 * @returns {object} Het bijgewerkte record (of het origineel met de velden gezet).
 */
function markActionReverted(guild, action, actorMember, notes) {
  const patch = {
    reverted: true,
    revertedBy: actorMember?.id || null,
    revertedAt: Date.now(),
  };
  try {
    const saved = store.updateAction(guild.id, action.id, patch);
    if (saved) return saved;
    notes.push('De actie kon niet als teruggedraaid gemarkeerd worden (staat niet meer in de opslag).');
  } catch (err) {
    logger.error('membershipService: actie markeren als teruggedraaid mislukt.', err);
    notes.push('De actie kon niet als teruggedraaid gemarkeerd worden.');
  }
  return { ...action, ...patch };
}

/**
 * Draait een eerdere aanname of ontslag terug.
 *
 * - `hire` (en het historische `hire_meeloper`): de gangrollen worden weer weggehaald.
 * - `fire`: de gangrol komt terug; leidingsrollen komen NOOIT automatisch terug, dat
 *   staat expliciet in `notes`.
 *
 * ALLEEN STAFF. Dat is bewust één regel met de enige aanroeper: de knop 'Terugdraaien'
 * onder een logbericht is staff-only. Zou de gangleiding hier wel doorheen mogen, dan
 * kon een boss via een oude knop een ontslag van maanden geleden ongedaan maken zonder
 * dat staff er iets van merkt. Gangleiding corrigeert met /gang aannemen of
 * /gang ontslaan.
 *
 * De actie wordt gemarkeerd met `reverted`, `revertedBy` en `revertedAt`, en er wordt
 * een los `revert`-record vastgelegd voor de historie.
 *
 * Foutcodes: `INVALID_INPUT`, `ALREADY_REVERTED`, `NOT_REVERTABLE`, `GANG_MISSING`,
 * `NOT_ALLOWED`, `TARGET_LEFT`, `OTHER_GANG`, `LIMIT_REACHED`, `MISSING_ROLE`,
 * `HIERARCHY`, `DISCORD_ERROR`.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} action Het ActionRecord dat teruggedraaid moet worden.
 * @param {import('discord.js').GuildMember|null} actorMember Wie terugdraait (moet staff zijn).
 * @returns {Promise<{ok: true, action: object, revertRecord: object, gang: object, counts: object, restoredLeadership: false, notes: string[], message: string}|Failure>}
 *   Bij succes het bijgewerkte record, het nieuwe revert-record en de toelichting.
 */
async function revertAction(guild, action, actorMember) {
  if (!guild || !guild.id) {
    return fail('INVALID_INPUT', 'Deze actie kan alleen binnen een server uitgevoerd worden.');
  }
  if (!action || typeof action !== 'object') {
    return fail('INVALID_INPUT', 'Deze actie bestaat niet meer in het logboek.');
  }
  const actionId = action.id === null || action.id === undefined ? '?' : action.id;
  if (action.reverted === true) {
    const by = action.revertedBy ? ` door <@${action.revertedBy}>` : '';
    return fail('ALREADY_REVERTED', `Actie #${actionId} is al teruggedraaid${by}.`);
  }
  if (!REVERTABLE_TYPES.includes(action.type)) {
    return fail(
      'NOT_REVERTABLE',
      `Een actie van het type '${action.type}' kan niet automatisch teruggedraaid worden. `
        + 'Gebruik /gang aannemen of /gang ontslaan om dit handmatig te corrigeren.',
    );
  }

  const gang = findGangForAction(guild.id, action);
  if (!gang) {
    return fail('GANG_MISSING', `De gang ${action.gangName || 'van deze actie'} bestaat niet meer.`);
  }
  const config = readConfig(guild);
  const staff = isStaff(actorMember, config);
  if (!staff) {
    return fail(
      'NOT_ALLOWED',
      `Alleen staff mag actie #${actionId} terugdraaien. Vraag een staflid, of corrigeer het `
        + 'zelf met `/gang aannemen` of `/gang ontslaan`.',
    );
  }
  const target = await fetchMember(guild, action.targetId);
  if (!target) {
    return fail(
      'TARGET_LEFT',
      `${action.targetTag || 'Dit lid'} zit niet meer op de server, dus de rollen kunnen niet aangepast worden.`,
    );
  }

  const plan = action.type === ACTION.FIRE
    ? planRevertFire(gang, action, target)
    : planRevertHire(gang, target);
  // Iemand terugzetten in een gang is een aanname: eerst dezelfde OTHER_GANG- en
  // limietcontrole, anders belandt hij in twee gangs of loopt een volle gang over.
  const restoreProblem = checkRevertRestore(guild, gang, action, target, plan, config, staff);
  if (restoreProblem) return restoreProblem;
  const roleProblem = checkRoles(guild, gang, [...plan.remove, ...plan.add]);
  if (roleProblem) return roleProblem;

  const auditReason = buildAuditReason(`Actie #${actionId} (${action.type}) teruggedraaid`, actorMember);
  const removed = await mutateRoles(target, 'remove', plan.remove.map((entry) => entry.id), auditReason);
  if (!removed.ok) return removed;
  // Tweede mutatie op het bijgewerkte lid; zie de toelichting bij syncRoleCache.
  const afterRemove = removed.member || target;
  const added = await mutateRoles(afterRemove, 'add', plan.add.map((entry) => entry.id), auditReason);
  if (!added.ok) return added;
  const updatedTarget = added.member || afterRemove;

  return finishRevert(guild, {
    action, actionId, actorMember, gang, target: updatedTarget, plan,
  });
}

/**
 * Rondt een geslaagd terugdraaien af: opslag bijwerken, revert-record vastleggen en
 * het resultaat samenstellen. (Losgetrokken zodat revertAction kort blijft.)
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {{action: object, actionId: number|string, actorMember: object|null, gang: object, target: object, plan: object}} ctx
 *   Alles wat revertAction al heeft uitgezocht.
 * @returns {{ok: true, action: object, revertRecord: object, gang: object, counts: object, restoredLeadership: false, notes: string[], message: string}}
 *   Het succesresultaat.
 */
function finishRevert(guild, ctx) {
  const {
    action, actionId, actorMember, gang, target, plan,
  } = ctx;
  const notes = [...plan.notes];
  const updated = markActionReverted(guild, action, actorMember, notes);
  const counts = countGang(guild, gang);

  if (counts.members > counts.memberLimit) {
    notes.push(
      `Let op: ${gang.name} zit hierdoor boven de limiet (${formatCapacity(counts)}). `
        + 'Verhoog de limiet met `/gangbeheer limiet leden:<aantal>` of ontsla iemand.',
    );
  }

  const revertRecord = recordAction(guild, {
    type: ACTION.REVERT,
    gangId: gang.id,
    gangName: gang.name,
    targetId: target.id,
    targetTag: memberTag(target),
    actorId: actorMember?.id || null,
    actorTag: memberTag(actorMember),
    reason: `Actie #${actionId} (${action.type}) teruggedraaid`,
    revertedActionId: action.id === undefined ? null : action.id,
  });

  logger.info(
    `${gang.name}: actie #${actionId} (${action.type}) teruggedraaid door `
      + `${memberTag(actorMember) || 'de bot'} - ${formatCapacity(counts)}.`,
  );
  return {
    ok: true,
    action: updated,
    revertRecord,
    gang,
    counts,
    restoredLeadership: false,
    notes,
    message: truncate(`Actie #${actionId} is teruggedraaid: ${plan.summary} ${notes.join(' ')}`.trim(), 1000),
  };
}

module.exports = {
  hire,
  fire,
  setLeadership,
  promote,
  demote,
  revertAction,
};
