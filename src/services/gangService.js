// src/services/gangService.js
// Beheer van de Discord-structuur van een gang: 3 rollen, 1 categorie en 6 kanalen.
// Alles is defensief opgezet: elke cache-lookup kan undefined zijn en elke Discord-call
// kan falen. Een mislukte aanmaak wordt volledig teruggedraaid, zodat er nooit half werk
// blijft staan. Elke mutatie krijgt een Nederlandse reden mee voor het auditlogboek.

const { ChannelType, PermissionFlagsBits, OverwriteType } = require('discord.js');

const {
  CHANNEL_BLUEPRINT,
  CATEGORY_PERMS,
  LEADER_PERMS,
  CHANNEL_PERMS,
  FLOW_PERMS,
  ROLE_COLORS,
  ROLE_HOIST,
  ROLE_SUFFIX,
  ROLE_KIND,
  GANG_ROLE_COLOR,
  buildChannelName,
} = require('../lib/constants');
const { slugify, isValidEmoji, truncate } = require('../lib/parse');
const { botCanManageRole, isMemberOf, isLeaderOf } = require('../lib/permissions');
const logger = require('../lib/logger');
const store = require('../store');

// ---------------------------------------------------------------------------
// Vaste waarden
// ---------------------------------------------------------------------------

/** Minimale lengte van een gangnaam. */
const MIN_NAME_LENGTH = 2;

/** Maximale lengte van een gangnaam. */
const MAX_NAME_LENGTH = 40;

/** Harde limieten van Discord zelf. */
const MAX_GUILD_CHANNELS = 500;
const MAX_GUILD_ROLES = 250;

/** Wat een gang aan de server toevoegt: 6 kanalen + 1 categorie, en 3 rollen. */
const CHANNELS_PER_GANG = CHANNEL_BLUEPRINT.length + 1;
const ROLES_PER_GANG = 3;

/** Pauze tussen twee kanaalcreaties, om de rate limit van Discord te ontlopen. */
const CHANNEL_CREATE_PAUSE_MS = 350;

/** Discord kapt een auditlog-reden af op 512 tekens. */
const MAX_AUDIT_REASON_LENGTH = 512;

/** Discord kapt een kanaal-/categorienaam af op 100 tekens. */
const MAX_CATEGORY_NAME_LENGTH = 100;

/** Omgekeerde tabel bit -> naam, nodig om overwrites als optie-object te versturen. */
const FLAG_NAMES = new Map(
  Object.entries(PermissionFlagsBits).map(([name, bit]) => [bit, name]),
);

/**
 * Nederlandse namen van de rechten die in de gangpermissies voorkomen. Staff krijgt deze
 * labels te zien, zodat meteen duidelijk is wat er in Serverinstellingen aan moet.
 * @type {Map<bigint, string>}
 */
const PERMISSION_LABELS_NL = new Map([
  [PermissionFlagsBits.ViewChannel, 'Kanalen bekijken (View Channels)'],
  [PermissionFlagsBits.ManageChannels, 'Kanalen beheren (Manage Channels)'],
  [PermissionFlagsBits.ManageRoles, 'Rollen beheren (Manage Roles)'],
  [PermissionFlagsBits.ReadMessageHistory, 'Berichtgeschiedenis bekijken (Read Message History)'],
  [PermissionFlagsBits.SendMessages, 'Berichten versturen (Send Messages)'],
  [PermissionFlagsBits.SendMessagesInThreads, 'Berichten versturen in threads (Send Messages in Threads)'],
  [PermissionFlagsBits.CreatePublicThreads, 'Openbare threads maken (Create Public Threads)'],
  [PermissionFlagsBits.CreatePrivateThreads, 'Privethreads maken (Create Private Threads)'],
  [PermissionFlagsBits.AddReactions, 'Reacties toevoegen (Add Reactions)'],
  [PermissionFlagsBits.AttachFiles, 'Bestanden toevoegen (Attach Files)'],
  [PermissionFlagsBits.EmbedLinks, 'Links insluiten (Embed Links)'],
  [PermissionFlagsBits.UseExternalEmojis, 'Externe emoji gebruiken (Use External Emoji)'],
  [PermissionFlagsBits.ManageMessages, 'Berichten beheren (Manage Messages)'],
  [PermissionFlagsBits.Connect, 'Verbinden met spraakkanalen (Connect)'],
  [PermissionFlagsBits.Speak, 'Spreken (Speak)'],
  [PermissionFlagsBits.Stream, 'Video delen (Video)'],
  [PermissionFlagsBits.UseVAD, 'Spraakactivering gebruiken (Use Voice Activity)'],
  [PermissionFlagsBits.MuteMembers, 'Leden dempen (Mute Members)'],
  [PermissionFlagsBits.DeafenMembers, 'Leden doof zetten (Deafen Members)'],
  [PermissionFlagsBits.MoveMembers, 'Leden verplaatsen (Move Members)'],
  [PermissionFlagsBits.PrioritySpeaker, 'Voorrang bij spreken (Priority Speaker)'],
]);

/**
 * Elk permissiebit dat ergens in de gangpermissies uitgedeeld OF geweigerd wordt.
 * Discord staat in permission_overwrites alleen rechten toe die de bot ZELF op de server
 * heeft - ook weigeren mag alleen met een recht dat je zelf hebt. Deze unie leiden we af
 * uit de constanten, zodat de lijst niet uit de pas kan lopen als iemand CATEGORY_PERMS of
 * CHANNEL_PERMS aanpast.
 * @type {Array<bigint>}
 */
const ALL_OVERWRITE_BITS = [...new Set([
  ...Object.values(CATEGORY_PERMS).flatMap((bits) => (Array.isArray(bits) ? [...bits] : [])),
  // Alle lijsten van een kanaalset, niet een handjevol met de naam erbij: zo valt een
  // nieuwe sleutel (leaderDeny, staffAllow, ...) nooit buiten deze controle.
  ...Object.values(CHANNEL_PERMS).flatMap((perms) => Object.values(perms || {})
    .flatMap((bits) => (Array.isArray(bits) ? [...bits] : []))),
])];

/**
 * Rechten waar de bot niet buiten kan. ViewChannel hoort er nadrukkelijk bij: daarmee wordt
 * de @everyone-deny en de deny op het bosskanaal gezet. Zou het rechtenfilter die weigering
 * weglaten, dan kwam de gang juist voor de hele server open te staan - daarom blokkeren we
 * in dat geval liever dan te degraderen.
 * @type {Array<bigint>}
 */
const ESSENTIAL_OVERWRITE_BITS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
];

/**
 * De drie rollen van een gang, in aanmaakvolgorde (gang, underboss, boss).
 * `key` is het veld in het GangRecord, `kind` de sleutel in ROLE_COLORS/ROLE_KIND.
 *
 * @param {string} name Weergavenaam van de gang.
 * @returns {Array<{key: string, kind: string, name: string}>} De rolspecificaties.
 */
function roleSpecs(name) {
  const base = typeof name === 'string' ? name : '';
  return [
    { key: 'roleId', kind: ROLE_KIND.GANG, name: base },
    { key: 'underbossRoleId', kind: ROLE_KIND.UNDERBOSS, name: `${base} ${ROLE_SUFFIX.underboss}` },
    { key: 'bossRoleId', kind: ROLE_KIND.BOSS, name: `${base} ${ROLE_SUFFIX.boss}` },
  ];
}

/**
 * Dezelfde drie rollen, maar in de volgorde waarin ze in de rollenlijst van de server
 * horen te staan: de hoogste rang bovenaan. applyRoleOrder maakt hier per gang een blokje
 * van, zodat in Serverinstellingen > Rollen in een oogopslag te zien is welke rollen bij
 * elkaar horen.
 * @type {ReadonlyArray<string>}
 */
const ROLE_ORDER_KEYS = Object.freeze(['bossRoleId', 'underbossRoleId', 'roleId']);

// ---------------------------------------------------------------------------
// Kleine hulpjes
// ---------------------------------------------------------------------------

/**
 * Wacht een aantal milliseconden. Wordt tussen kanaalcreaties gebruikt zodat Discord
 * ons niet tijdelijk blokkeert.
 *
 * @param {number} ms Aantal milliseconden.
 * @returns {Promise<void>} Belofte die na de pauze resolvet.
 */
function sleep(ms) {
  const wait = Number.isFinite(ms) && ms > 0 ? ms : 0;
  return new Promise((resolve) => { setTimeout(resolve, wait); });
}

/**
 * Maakt een veilige auditlog-reden: altijd een string, nooit langer dan 512 tekens.
 *
 * @param {string} text De gewenste reden.
 * @returns {string} De (eventueel afgekapte) reden.
 */
function auditReason(text) {
  const value = typeof text === 'string' && text.trim() ? text.trim() : 'OWC Gangbeheer';
  return truncate(value, MAX_AUDIT_REASON_LENGTH);
}

/**
 * Normaliseert een actor-id naar een string of null.
 *
 * @param {*} value Ruwe waarde.
 * @returns {string|null} De id, of null.
 */
function asActorId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Bouwt de categorienaam: emoji, een liggend streepje en de naam.
 *
 * @param {string} emoji Emoji van de gang.
 * @param {string} name Weergavenaam van de gang.
 * @returns {string} De categorienaam, afgekapt op de Discord-limiet.
 */
function buildCategoryName(emoji, name) {
  const left = typeof emoji === 'string' ? emoji.trim() : '';
  const right = typeof name === 'string' ? name.trim() : '';
  const full = left ? `${left} | ${right}` : right;
  return truncate(full, MAX_CATEGORY_NAME_LENGTH);
}

/**
 * Haalt een kanaal (of categorie) veilig uit de cache.
 *
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @param {string|null|undefined} channelId Kanaal-id.
 * @returns {import('discord.js').GuildChannel|null} Het kanaal, of null.
 */
function resolveChannel(guild, channelId) {
  if (!guild || typeof channelId !== 'string' || !channelId) return null;
  try {
    return guild.channels?.cache?.get(channelId) || null;
  } catch {
    return null;
  }
}

/**
 * Haalt een rol veilig uit de cache.
 *
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @param {string|null|undefined} roleId Rol-id.
 * @returns {import('discord.js').Role|null} De rol, of null.
 */
function resolveRole(guild, roleId) {
  if (!guild || typeof roleId !== 'string' || !roleId) return null;
  try {
    return guild.roles?.cache?.get(roleId) || null;
  } catch {
    return null;
  }
}

/**
 * Haalt de categorie van een gang op en controleert of het echt een categorie is.
 *
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @param {object|null|undefined} gang Het GangRecord.
 * @returns {import('discord.js').CategoryChannel|null} De categorie, of null.
 */
function resolveCategory(guild, gang) {
  const channel = resolveChannel(guild, gang?.categoryId);
  if (!channel || channel.type !== ChannelType.GuildCategory) return null;
  return channel;
}

/**
 * Is de rolvolgorde van de bot te bepalen? Zonder `guild.members.me` (koude cache) geeft
 * botCanManageRole altijd false; dan zouden we een prima verwijdering onterecht blokkeren.
 * In dat geval slaan we de voorcontrole over en vangt de nacontrole op `failed` het af.
 *
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @returns {boolean} true als de hoogste botrol bekend is.
 */
function canCompareRolePositions(guild) {
  try {
    return Boolean(guild?.members?.me?.roles?.highest);
  } catch {
    return false;
  }
}

/**
 * Verwijdert een rol of kanaal en vangt fouten af.
 *
 * @param {{delete: Function}} resource De te verwijderen resource.
 * @param {string} reason Auditlog-reden.
 * @param {string[]} failed Verzamellijst met mislukte onderdelen (wordt aangevuld).
 * @param {string} label Nederlandse omschrijving voor foutmeldingen.
 * @returns {Promise<boolean>} true als het verwijderen lukte.
 */
async function safeDelete(resource, reason, failed, label) {
  try {
    await resource.delete(reason);
    return true;
  } catch (err) {
    logger.warn(`gangService: verwijderen van ${label} mislukt (${err.message}).`);
    if (Array.isArray(failed)) failed.push(label);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Permissie-overwrites
// ---------------------------------------------------------------------------

/**
 * Nederlandse naam van een permissiebit; valt terug op de Engelse naam van Discord.
 *
 * @param {bigint} bit Het permissiebit.
 * @returns {string} De naam die staff te zien krijgt.
 */
function permissionLabel(bit) {
  return PERMISSION_LABELS_NL.get(bit) || FLAG_NAMES.get(bit) || 'onbekend recht';
}

/**
 * De serverrechten van de bot, of null als ze niet vast te stellen zijn (koude cache).
 * Null betekent bewust "niet filteren": liever een call die Discord weigert dan stilletjes
 * alle rechten uit de overwrites slopen omdat we het even niet weten.
 *
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @returns {import('discord.js').PermissionsBitField|null} De rechten van de bot, of null.
 */
function botGuildPermissions(guild) {
  try {
    const permissions = guild?.members?.me?.permissions;
    return permissions && typeof permissions.has === 'function' ? permissions : null;
  } catch {
    return null;
  }
}

/**
 * Heeft de bot dit recht? Bij onbekende rechten gaan we uit van ja (zie botGuildPermissions).
 *
 * @param {import('discord.js').PermissionsBitField|null} permissions Rechten van de bot.
 * @param {bigint} bit Het te controleren bit.
 * @returns {boolean} true als het recht er is (of niet te bepalen viel).
 */
function botHasBit(permissions, bit) {
  if (!permissions) return true;
  try {
    return permissions.has(bit);
  } catch {
    return true;
  }
}

/**
 * Filtert een allow-/deny-lijst tot de bits die de bot zelf heeft.
 *
 * WAAROM DIT MOET BLIJVEN: Discord weigert een complete channels.create of
 * permissionOverwrites.edit met 50013 zodra je een recht uitdeelt OF weigert dat je zelf
 * niet hebt. Zonder dit filter mislukt /gangbeheer aanmaken volledig (en wordt de hele gang
 * teruggedraaid) op elke server waar de botrol geen MuteMembers, DeafenMembers,
 * MoveMembers, PrioritySpeaker of ManageMessages heeft - en dat erft de bot nooit via
 * @everyone. Wat wegvalt wordt gemeld via overwritePermissionNotice; stil strippen mag
 * niet, want dan denken bosses dat ze die rechten hebben.
 *
 * @param {import('discord.js').PermissionsBitField|null} permissions Rechten van de bot.
 * @param {ReadonlyArray<bigint>|null|undefined} bits De gewenste bits.
 * @returns {Array<bigint>} Alleen de bits die de bot daadwerkelijk mag uitdelen.
 */
function allowedBits(permissions, bits) {
  const list = Array.isArray(bits) ? [...bits] : [];
  if (!permissions) return list;
  return list.filter((bit) => botHasBit(permissions, bit));
}

/**
 * Welke van de rechten uit ALL_OVERWRITE_BITS mist de bot?
 *
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @returns {string[]} Nederlandse labels van de ontbrekende rechten (leeg = alles in orde).
 */
function missingOverwritePermissions(guild) {
  const permissions = botGuildPermissions(guild);
  if (!permissions) return [];
  return ALL_OVERWRITE_BITS.filter((bit) => !botHasBit(permissions, bit)).map(permissionLabel);
}

/**
 * Welke onmisbare rechten (ESSENTIAL_OVERWRITE_BITS) mist de bot?
 *
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @returns {string[]} Nederlandse labels van de ontbrekende rechten (leeg = alles in orde).
 */
function missingEssentialPermissions(guild) {
  const permissions = botGuildPermissions(guild);
  if (!permissions) return [];
  return ESSENTIAL_OVERWRITE_BITS.filter((bit) => !botHasBit(permissions, bit)).map(permissionLabel);
}

/**
 * Foutmelding voor het geval de bot een onmisbaar recht mist.
 *
 * @param {string[]} missing Ontbrekende rechten.
 * @returns {string} Nederlandse melding met de oplossing erbij.
 */
function essentialPermissionError(missing) {
  return `De bot mist ${missing.join(', ')}. Zonder die rechten weigert Discord de`
    + ' kanaalpermissies van de gang en zou de categorie voor de hele server zichtbaar'
    + ' worden. Geef de botrol deze rechten via Serverinstellingen > Rollen (of nodig de bot'
    + ' opnieuw uit met alle rechten) en probeer het daarna opnieuw.';
}

/**
 * Waarschuwing over rechten die de bot zelf mist en die daarom uit de overwrites gefilterd
 * worden. Zo weet staff precies wat er aangezet moet worden.
 *
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @returns {string|null} De melding, of null als er niets weggefilterd wordt.
 */
function overwritePermissionNotice(guild) {
  const missing = missingOverwritePermissions(guild);
  if (!missing.length) return null;
  return `Let op: de bot heeft deze serverrechten zelf niet: ${missing.join(', ')}.`
    + ' Discord staat niet toe dat de bot ze uitdeelt, dus ze zijn overgeslagen in de'
    + ' kanaalpermissies. Zet ze aan bij Serverinstellingen > Rollen en voer daarna'
    + ' /gangbeheer herstel uit om ze alsnog te zetten.';
}

/**
 * Aanwijzing bij een mislukte Discord-call. Bij 50013 noemen we het recht dat echt
 * ontbreekt, in plaats van standaard naar "Rollen beheren" en "Kanalen beheren" te wijzen -
 * die twee heeft de bot in dit scenario juist wel, dus die tip stuurt de verkeerde kant op.
 *
 * @param {{code?: number}|null|undefined} err De opgetreden fout.
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @returns {string} Nederlandse aanwijzing met de oplossing erbij.
 */
function permissionHint(err, guild) {
  if (err && err.code === 50013) {
    const missing = missingOverwritePermissions(guild);
    if (missing.length) {
      return 'Discord weigert dit omdat de bot deze rechten zelf niet heeft:'
        + ` ${missing.join(', ')}. Zet ze aan bij Serverinstellingen > Rollen en probeer het`
        + ' opnieuw.';
    }
    return 'Discord meldde "ontbrekende rechten" (50013). Controleer of de botrol boven de'
      + ' gangrollen staat en of de bot in deze categorie mag beheren.';
  }
  return 'Controleer of de bot de rechten "Rollen beheren" en "Kanalen beheren" heeft en of'
    + ' de botrol boven de gangrollen staat.';
}

/**
 * Combineert een lijst permissiebits tot een bitfield.
 *
 * @param {Array<bigint>} bits Permissiebits.
 * @returns {bigint} Het gecombineerde bitfield.
 */
function combineBits(bits) {
  if (!Array.isArray(bits)) return 0n;
  return bits.reduce((acc, bit) => acc | BigInt(bit), 0n);
}

/**
 * Maakt een overwrite-item schoon: dubbele bits eruit, en een bit dat zowel toegestaan
 * als geweigerd is telt als geweigerd (kanaalregels gaan boven categorieregels).
 *
 * @param {{id: string, type: number, allow: Array<bigint>, deny: Array<bigint>}} entry Ruw item.
 * @returns {{id: string, type: number, allow: Array<bigint>, deny: Array<bigint>}} Schoon item.
 */
function normalizeEntry(entry) {
  const deny = [...new Set(Array.isArray(entry.deny) ? entry.deny : [])];
  const denySet = new Set(deny);
  const allow = [...new Set(Array.isArray(entry.allow) ? entry.allow : [])]
    .filter((bit) => !denySet.has(bit));
  return { id: entry.id, type: entry.type, allow, deny };
}

/**
 * Zet een overwrite-item om naar het optie-object dat `permissionOverwrites.edit` verwacht.
 *
 * @param {{allow: Array<bigint>, deny: Array<bigint>}} entry Schoon overwrite-item.
 * @returns {Record<string, boolean>} Bijvoorbeeld `{ ViewChannel: true, SendMessages: false }`.
 */
function toOverwriteOptions(entry) {
  const options = {};
  for (const bit of entry.allow) {
    const name = FLAG_NAMES.get(bit);
    if (name) options[name] = true;
  }
  for (const bit of entry.deny) {
    const name = FLAG_NAMES.get(bit);
    if (name) options[name] = false;
  }
  return options;
}

/**
 * Zet een overwrite-item om naar de vorm die `channels.create` verwacht.
 *
 * @param {{id: string, type: number, allow: Array<bigint>, deny: Array<bigint>}} entry Schoon item.
 * @returns {{id: string, type: number, allow: Array<bigint>, deny: Array<bigint>}} Create-vorm.
 */
function toCreateOverwrite(entry) {
  return {
    id: entry.id, type: entry.type, allow: entry.allow, deny: entry.deny,
  };
}

/**
 * Controleert of de bestaande overwrite het gewenste resultaat al oplevert. Zo ja, dan
 * slaan we de API-call over; dat maakt applyCategoryPermissions idempotent en zuinig
 * met rate limits.
 *
 * @param {import('discord.js').PermissionOverwrites|null} existing Huidige overwrite.
 * @param {{allow: Array<bigint>, deny: Array<bigint>}} entry Gewenste stand.
 * @returns {boolean} true als er niets te doen valt.
 */
function isSatisfied(existing, entry) {
  const wantAllow = combineBits(entry.allow);
  const wantDeny = combineBits(entry.deny);
  if (!existing) return wantAllow === 0n && wantDeny === 0n;

  let allowBits = 0n;
  let denyBits = 0n;
  try {
    allowBits = BigInt(existing.allow?.bitfield ?? 0n);
    denyBits = BigInt(existing.deny?.bitfield ?? 0n);
  } catch {
    return false;
  }

  return (allowBits & wantAllow) === wantAllow
    && (denyBits & wantDeny) === wantDeny
    && (allowBits & wantDeny) === 0n
    && (denyBits & wantAllow) === 0n;
}

/**
 * Is de rollijst van de server bruikbaar? Bij een lege of ontbrekende cache weten we niet
 * of een rol nog bestaat; dan filteren we liever niets weg dan een terechte toegangsregel
 * stilletjes te laten vallen.
 *
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @returns {boolean} true als de rollen van de server te controleren zijn.
 */
function rolesCacheUsable(guild) {
  try {
    const cache = guild?.roles?.cache;
    return Boolean(cache && typeof cache.get === 'function' && (cache.size ?? 0) > 0);
  } catch {
    return false;
  }
}

/**
 * De id's uit globalRoleIds die niet (meer) bij een bestaande rol horen. Leeg zolang de
 * rollijst niet te lezen is - dan weten we het simpelweg niet.
 *
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @param {object|null|undefined} guildConfig De serverconfiguratie.
 * @returns {string[]} Rol-id's uit de configuratie die op de server niet bestaan.
 */
function missingGlobalRoleIds(guild, guildConfig) {
  const raw = Array.isArray(guildConfig?.globalRoleIds) ? guildConfig.globalRoleIds : [];
  if (!raw.length || !rolesCacheUsable(guild)) return [];
  const weg = [];
  for (const id of raw) {
    if (typeof id !== 'string' || !id || resolveRole(guild, id)) continue;
    if (!weg.includes(id)) weg.push(id);
  }
  return weg;
}

/**
 * Melding over extrarollen uit /setup extrarollen die van de server verdwenen zijn. Zonder
 * deze regel vraagt staff zich af waarom de OWC-rol opeens nergens meer bij kan.
 *
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @param {object|null|undefined} guildConfig De serverconfiguratie.
 * @returns {string|null} De melding, of null als alle extrarollen nog bestaan.
 */
function missingGlobalRoleNotice(guild, guildConfig) {
  const weg = missingGlobalRoleIds(guild, guildConfig);
  if (!weg.length) return null;
  return `Let op: ${weg.length} rol(len) uit /setup extrarollen bestaan niet meer op de server`
    + ` (id ${weg.join(', ')}) en zijn overgeslagen. Is de rol opnieuw aangemaakt, voeg hem dan`
    + ' opnieuw toe met /setup extrarollen; het oude id wordt verder genegeerd.';
}

/**
 * De server-brede rollen die in élke gangcategorie thuishoren (OWC, wapendealers).
 *
 * Een id dat hier doorheen komt krijgt een EIGEN overwrite. Alles wat al langs een andere
 * weg een overwrite krijgt valt daarom af: `edit` doet een merge, dus een tweede overwrite
 * op hetzelfde id verruimt de eerste stilletjes, en `channels.create` zou twee entries met
 * hetzelfde id meekrijgen. Concreet vallen af:
 *   - de staffrol: die heeft haar eigen, ruimere permissieset;
 *   - @everyone: een allow ViewChannel bovenop de deny zou de hele gangcategorie voor de
 *     complete server openzetten (/setup extrarollen weigert @everyone al, maar een met de
 *     hand aangepaste data/owc.json niet);
 *   - de drie rollen van DEZE gang: die hebben hun eigen set, met bewust géén Speak in de
 *     eigen categorie. Bij een ANDERE gang blijft zo'n rol gewoon een normale extrarol.
 * Rollen die van de server verwijderd zijn vallen ook af: Discord weigert een overwrite voor
 * een onbekend id, en dan mislukt een complete /gangbeheer aanmaken (inclusief rollback).
 *
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @param {object|null|undefined} gang Het GangRecord (of concept) waar de overwrites bij horen.
 * @param {object|null|undefined} guildConfig De serverconfiguratie.
 * @returns {string[]} Unieke rol-id's die veilig een eigen overwrite kunnen krijgen.
 */
function collectGlobalRoleIds(guild, gang, guildConfig) {
  const raw = Array.isArray(guildConfig?.globalRoleIds) ? guildConfig.globalRoleIds : [];
  if (!raw.length) return [];

  const bezet = new Set([
    guild?.roles?.everyone?.id,
    guildConfig?.staffRoleId,
    gang?.roleId,
    gang?.bossRoleId,
    gang?.underbossRoleId,
  ].filter((id) => typeof id === 'string' && id));

  const controleerbaar = rolesCacheUsable(guild);
  const uniek = [];
  for (const id of raw) {
    if (typeof id !== 'string' || !id || bezet.has(id)) continue;
    if (controleerbaar && !resolveRole(guild, id)) continue;
    if (!uniek.includes(id)) uniek.push(id);
  }
  return uniek;
}

/**
 * Bouwt de overwrites van de gangcategorie volgens de permissiematrix uit de spec: de
 * weigering voor iedereen, de drie gangrollen, de staffrol, de server-brede extrarollen en
 * de bot zelf. Alleen rollen die daadwerkelijk bekend zijn komen in de lijst terecht, en
 * elk id komt hoogstens een keer voor (zie collectGlobalRoleIds).
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} gang GangRecord (of een concept daarvan).
 * @param {{staffRoleId?: string|null, globalRoleIds?: string[]}} guildConfig Serverconfiguratie.
 * @returns {Array<{id: string, type: number, allow: Array<bigint>, deny: Array<bigint>}>} De overwrites.
 */
function buildCategoryOverwrites(guild, gang, guildConfig) {
  const entries = [];
  // Discord weigert een overwrite die rechten uitdeelt of weigert die de bot zelf niet
  // heeft (50013) en laat dan de HELE call mislukken. Daarom gaat elke allow- en deny-lijst
  // eerst door de serverrechten van de bot; wat wegvalt meldt overwritePermissionNotice.
  const botPerms = botGuildPermissions(guild);
  const push = (id, type, allow, deny) => {
    if (typeof id === 'string' && id) {
      entries.push(normalizeEntry({
        id,
        type,
        allow: allowedBits(botPerms, allow),
        deny: allowedBits(botPerms, deny),
      }));
    }
  };

  push(guild?.roles?.everyone?.id, OverwriteType.Role, [], [...CATEGORY_PERMS.everyoneDeny]);
  push(gang?.roleId, OverwriteType.Role, [...CATEGORY_PERMS.gang], []);
  push(gang?.underbossRoleId, OverwriteType.Role, [...CATEGORY_PERMS.underboss], []);
  push(gang?.bossRoleId, OverwriteType.Role, [...CATEGORY_PERMS.boss], []);
  push(guildConfig?.staffRoleId, OverwriteType.Role, [...CATEGORY_PERMS.staff], []);
  for (const roleId of collectGlobalRoleIds(guild, gang, guildConfig)) {
    push(roleId, OverwriteType.Role, [...CATEGORY_PERMS.global], []);
  }
  push(
    guild?.members?.me?.id || guild?.client?.user?.id,
    OverwriteType.Member,
    [...CATEGORY_PERMS.bot],
    [],
  );

  return entries;
}

/**
 * Bouwt de overwrites van een gangkanaal: de categorieregels plus de kanaal-specifieke
 * uitzonderingen uit CHANNEL_PERMS (mededeling, boss, dark). Kanalen zonder eigen regels
 * krijgen simpelweg de categorieregels terug.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} gang GangRecord (of een concept daarvan).
 * @param {string} kind Blueprint-soort, bijvoorbeeld 'mededeling'.
 * @param {{staffRoleId?: string|null}} guildConfig Serverconfiguratie.
 * @returns {Array<{id: string, type: number, allow: Array<bigint>, deny: Array<bigint>}>} De overwrites.
 */
function buildChannelOverwrites(guild, gang, kind, guildConfig) {
  const base = buildCategoryOverwrites(guild, gang, guildConfig);
  const extra = CHANNEL_PERMS[kind];
  if (!extra) return base;

  const map = new Map(base.map((entry) => [
    entry.id,
    { ...entry, allow: [...entry.allow], deny: [...entry.deny] },
  ]));
  const ensure = (id, type) => {
    if (typeof id !== 'string' || !id) return null;
    if (!map.has(id)) map.set(id, { id, type, allow: [], deny: [] });
    return map.get(id);
  };

  // Zelfde reden als in buildCategoryOverwrites: alleen bits die de bot zelf heeft, anders
  // weigert Discord het hele kanaal (50013). Het mededelingenkanaal geeft leiders bijv.
  // ManageMessages, en dat recht erft de bot nooit via @everyone.
  const botPerms = botGuildPermissions(guild);

  /**
   * Weigert een aantal rechten op een rol, en haalt ze eerst uit de allow van diezelfde
   * overwrite. Zonder dat laatste zou een recht tegelijk toegestaan en geweigerd staan -
   * de categorie deelt bijvoorbeeld Speak uit aan de extrarollen, terwijl het oortje het
   * juist dichtzet.
   *
   * @param {{allow: Array<bigint>, deny: Array<bigint>}|null} entry De overwrite.
   * @param {ReadonlyArray<bigint>} bits De te weigeren rechten.
   * @returns {void}
   */
  const weiger = (entry, bits) => {
    if (!entry) return;
    const teWeigeren = allowedBits(botPerms, bits);
    if (!teWeigeren.length) return;
    const set = new Set(teWeigeren);
    entry.allow = entry.allow.filter((bit) => !set.has(bit));
    entry.deny.push(...teWeigeren);
  };

  if (extra.everyoneDeny?.length) {
    weiger(ensure(guild?.roles?.everyone?.id, OverwriteType.Role), extra.everyoneDeny);
  }

  if (extra.gangDeny?.length) {
    weiger(ensure(gang?.roleId, OverwriteType.Role), extra.gangDeny);
  }

  if (extra.globalDeny?.length) {
    for (const roleId of collectGlobalRoleIds(guild, gang, guildConfig)) {
      weiger(ensure(roleId, OverwriteType.Role), extra.globalDeny);
    }
  }

  if (extra.leaderDeny?.length) {
    for (const leaderRoleId of [gang?.bossRoleId, gang?.underbossRoleId]) {
      weiger(ensure(leaderRoleId, OverwriteType.Role), extra.leaderDeny);
    }
  }

  if (extra.leaderAllow?.length) {
    for (const leaderRoleId of [gang?.bossRoleId, gang?.underbossRoleId]) {
      const leaderEntry = ensure(leaderRoleId, OverwriteType.Role);
      if (leaderEntry) leaderEntry.allow.push(...allowedBits(botPerms, extra.leaderAllow));
    }
  }

  // De staffrol als laatste: wat staff hier mag, mag hij ondanks alle weigeringen hierboven.
  if (extra.staffAllow?.length) {
    const staffEntry = ensure(guildConfig?.staffRoleId, OverwriteType.Role);
    if (staffEntry) {
      const bits = allowedBits(botPerms, extra.staffAllow);
      const set = new Set(bits);
      staffEntry.deny = staffEntry.deny.filter((bit) => !set.has(bit));
      staffEntry.allow.push(...bits);
    }
  }

  return [...map.values()].map(normalizeEntry);
}

/**
 * Past een lijst overwrites toe op een kanaal of categorie. Bestaande overwrites worden
 * bijgewerkt (`edit` doet een merge) in plaats van blind toegevoegd, en wat al klopt
 * wordt overgeslagen.
 *
 * @param {import('discord.js').GuildChannel} channel Het kanaal of de categorie.
 * @param {Array<{id: string, type: number, allow: Array<bigint>, deny: Array<bigint>}>} entries De overwrites.
 * @param {string} reason Auditlog-reden.
 * @returns {Promise<{updated: number, mislukt: number}>} Aantal gewijzigde overwrites en het
 *   aantal dat Discord geweigerd heeft.
 *
 * WAAROM `mislukt` ERBIJ MOET: een geweigerde edit betekent dat het kanaal NIET dichtstaat.
 * Alleen loggen en `ok: true` teruggeven laat de beheerder in de waan dat het geregeld is,
 * terwijl iedereen er gewoon in kan typen. Elke aanroeper hoort dit getal te gebruiken.
 */
async function applyOverwrites(channel, entries, reason) {
  let updated = 0;
  let mislukt = 0;
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) continue;

    let existing = null;
    try {
      existing = channel.permissionOverwrites?.cache?.get(entry.id) || null;
    } catch {
      existing = null;
    }
    if (isSatisfied(existing, entry)) continue;

    try {
      await channel.permissionOverwrites.edit(
        entry.id,
        toOverwriteOptions(entry),
        { type: entry.type, reason },
      );
      updated += 1;
    } catch (err) {
      mislukt += 1;
      logger.warn(`gangService: overwrite voor ${entry.id} op kanaal ${channel?.id} mislukt (${err.message}).`);
    }
  }
  return { updated, mislukt };
}

/**
 * Verwijdert rol-overwrites die niet in de gewenste eindstand voorkomen.
 *
 * WAAROM DIT ER MOET ZIJN: applyOverwrites doet alleen `edit` (een merge) en verwijdert
 * nooit iets. Zonder deze stap kan /gangbeheer herstel te RUIME rechten niet dichtzetten: de
 * overwrite van een oude staffrol, of een rol die iemand met de hand aan het bosskanaal
 * heeft toegevoegd, blijft dan voor altijd staan terwijl de bot meldt "alles was al in orde".
 *
 * Wat hier wel weg mag: rol-overwrites op de categorie en de zes kanalen van deze gang die
 * niet in `entries` staan. Elke verwijdering wordt gemeld in `removed`, zodat staff ziet
 * wat er weg is en het desnoods bewust terug kan zetten.
 *
 * Wat bewust BLIJFT staan (niet stiekem gaan opruimen):
 * - alle member-overwrites: die vallen buiten het gangmodel. Denk aan de bot zelf en aan
 *   per-lid uitzonderingen die met opzet gezet zijn (bijvoorbeeld een lid dat dark-chat
 *   niet mag zien, of een gast die tijdelijk toegang kreeg).
 * - @everyone en de huidige staffrol: die staan sowieso in de gewenste stand.
 * - beheerde rollen (`role.managed`): bot- en boostrollen, zoals de rol van een muziekbot
 *   op het oortje. Die zet de bot nooit zelf en horen niet bij het gangmodel.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {import('discord.js').GuildChannel} channel Het kanaal of de categorie.
 * @param {Array<{id: string}>} entries De gewenste eindstand (uit build*Overwrites).
 * @param {string} reason Auditlog-reden.
 * @param {string[]} removed Verzamellijst met Nederlandse meldingen (wordt aangevuld).
 * @returns {Promise<number>} Aantal verwijderde overwrites.
 */
async function pruneRoleOverwrites(guild, channel, entries, reason, removed) {
  let cache = null;
  try {
    cache = channel?.permissionOverwrites?.cache;
  } catch {
    cache = null;
  }
  if (!cache || typeof cache.values !== 'function') return 0;

  const wanted = new Set((Array.isArray(entries) ? entries : []).map((entry) => entry?.id));
  const everyoneId = guild?.roles?.everyone?.id || null;
  let count = 0;

  for (const overwrite of [...cache.values()]) {
    if (!overwrite || overwrite.type !== OverwriteType.Role) continue;

    const id = overwrite.id;
    if (typeof id !== 'string' || !id || id === everyoneId || wanted.has(id)) continue;

    const role = resolveRole(guild, id);
    if (role?.managed) continue;

    try {
      await channel.permissionOverwrites.delete(id, reason);
      count += 1;
      removed.push(
        `Overbodige rechten van ${role ? role.name : `rol ${id}`} verwijderd op ${channel.name}.`,
      );
    } catch (err) {
      logger.warn(`gangService: overwrite ${id} opruimen op kanaal ${channel?.id} mislukt (${err.message}).`);
    }
  }

  return count;
}

// ---------------------------------------------------------------------------
// Overwrites uitlezen
// ---------------------------------------------------------------------------

/**
 * Leest een bestaande overwrite als twee bitfields. Elke stap kan undefined zijn.
 *
 * @param {import('discord.js').GuildChannel} channel Het kanaal.
 * @param {string} id Rol- of lid-id.
 * @returns {{allow: bigint, deny: bigint}|null} De bitfields, of null als er niets staat.
 */
function readOverwriteBits(channel, id) {
  try {
    const existing = channel?.permissionOverwrites?.cache?.get(id);
    if (!existing) return null;
    return {
      allow: BigInt(existing.allow?.bitfield ?? 0n),
      deny: BigInt(existing.deny?.bitfield ?? 0n),
    };
  } catch {
    return null;
  }
}

/**
 * Het lid-id van de bot zelf.
 *
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @returns {string|null} Het id, of null.
 */
function botMemberId(guild) {
  try {
    return guild?.members?.me?.id || guild?.client?.user?.id || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Validatie
// ---------------------------------------------------------------------------

/**
 * Normaliseert een limietwaarde: geheel getal met een ondergrens, anders de terugval.
 *
 * @param {*} value Ruwe waarde.
 * @param {number} fallback Terugvalwaarde.
 * @param {number} min Ondergrens.
 * @returns {number} Een bruikbaar geheel getal.
 */
function limitOrDefault(value, fallback, min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.floor(number));
}

/**
 * Minimale en maximale lengte van een afkorting, in tekens zoals ze ingetikt worden.
 * De slug die eruit komt wordt daarna nog door slugify afgetopt.
 */
const MIN_ABBREVIATION_LENGTH = 2;
const MAX_ABBREVIATION_LENGTH = 20;

/**
 * Controleert naam, emoji en de optionele afkorting, en of de naam en de bijbehorende slug
 * nog vrij zijn.
 *
 * De slug bepaalt de kanaalnamen. Zonder afkorting komt die uit de volledige naam; met
 * afkorting uit de afkorting, zodat "Grove Street Family" kanalen als `gsf-chat` krijgt in
 * plaats van `grove-street-family-chat`. De rollen en de categorie houden altijd de
 * volledige naam - daar is de lengte geen probleem.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {string} rawName Ingevoerde naam.
 * @param {string} rawEmoji Ingevoerde emoji.
 * @param {number|null} ignoreGangId Gang-id die bij de uniekheidscheck overgeslagen wordt.
 * @param {string} [rawAbbreviation] Ingevoerde afkorting ('' of weglaten = geen afkorting).
 * @returns {{ok: true, name: string, emoji: string, slug: string, abbreviation: string}|{ok: false, error: string}} Resultaat.
 */
function validateNameAndEmoji(guild, rawName, rawEmoji, ignoreGangId, rawAbbreviation) {
  const name = typeof rawName === 'string' ? rawName.trim().replace(/\s+/g, ' ') : '';
  if (name.length < MIN_NAME_LENGTH || name.length > MAX_NAME_LENGTH) {
    return {
      ok: false,
      error: `De gangnaam moet tussen ${MIN_NAME_LENGTH} en ${MAX_NAME_LENGTH} tekens lang zijn`
        + ` (nu ${name.length}). Kies een langere of kortere naam.`,
    };
  }

  const emoji = typeof rawEmoji === 'string' ? rawEmoji.trim() : '';
  if (!isValidEmoji(emoji)) {
    return {
      ok: false,
      error: 'Geef precies 1 emoji op. Een gewone emoji of een server-emoji in de vorm'
        + ' <:naam:123456789012345678> werkt; meerdere tekens of losse tekst niet.',
    };
  }

  const abbreviation = typeof rawAbbreviation === 'string' ? rawAbbreviation.trim().replace(/\s+/g, ' ') : '';
  if (abbreviation
    && (abbreviation.length < MIN_ABBREVIATION_LENGTH || abbreviation.length > MAX_ABBREVIATION_LENGTH)) {
    return {
      ok: false,
      error: `De afkorting moet tussen ${MIN_ABBREVIATION_LENGTH} en ${MAX_ABBREVIATION_LENGTH} tekens`
        + ` lang zijn (nu ${abbreviation.length}). Laat de afkorting weg om de volledige naam in de`
        + ' kanaalnamen te gebruiken.',
    };
  }

  // Met afkorting bepaalt die de kanaalnamen, anders de volledige naam.
  const slug = slugify(abbreviation || name);
  if (!slug) {
    return {
      ok: false,
      error: abbreviation
        ? `Uit de afkorting "${abbreviation}" is geen bruikbare kanaalnaam te maken.`
          + ' Gebruik minstens een letter of cijfer in de afkorting.'
        : `Uit de naam "${name}" is geen bruikbare kanaalnaam te maken.`
          + ' Gebruik minstens een letter of cijfer in de naam.',
    };
  }

  const gangs = store.listGangs(guild.id).filter((gang) => gang.id !== ignoreGangId);
  if (gangs.some((gang) => (gang.name || '').toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: `Er bestaat al een gang met de naam ${name}. Kies een andere naam.` };
  }
  if (gangs.some((gang) => gang.slug === slug)) {
    return {
      ok: false,
      error: abbreviation
        ? `De afkorting ${abbreviation} levert de kanaalnaam "${slug}" op en die is al in gebruik`
          + ' door een andere gang. Kies een andere afkorting.'
        : `De naam ${name} levert de kanaalnaam "${slug}" op en die is al in gebruik door een`
          + ' andere gang. Kies een naam die duidelijker verschilt, of geef een afkorting op.',
    };
  }

  return {
    ok: true, name, emoji, slug, abbreviation,
  };
}

/**
 * Controleert of de server nog ruimte heeft voor een extra gang (7 kanalen en 3 rollen).
 *
 * @param {import('discord.js').Guild} guild De server.
 * @returns {{ok: true}|{ok: false, error: string}} Resultaat.
 */
function validateGuildCapacity(guild) {
  const channelCount = guild.channels?.cache?.size ?? 0;
  if (channelCount + CHANNELS_PER_GANG > MAX_GUILD_CHANNELS) {
    return {
      ok: false,
      error: `De server heeft al ${channelCount} kanalen; een gang heeft er ${CHANNELS_PER_GANG} nodig`
        + ` en Discord staat er maximaal ${MAX_GUILD_CHANNELS} toe. Ruim eerst kanalen op.`,
    };
  }

  const roleCount = guild.roles?.cache?.size ?? 0;
  if (roleCount + ROLES_PER_GANG > MAX_GUILD_ROLES) {
    return {
      ok: false,
      error: `De server heeft al ${roleCount} rollen; een gang heeft er ${ROLES_PER_GANG} nodig`
        + ` en Discord staat er maximaal ${MAX_GUILD_ROLES} toe. Verwijder eerst rollen.`,
    };
  }

  return { ok: true };
}

/**
 * Zoekt de gang waar dit lid al in zit: de gangrol of een van de leidersrollen.
 * Dit is dezelfde regel die membershipService.findConflictingGang hanteert; we gebruiken
 * hier de predicaten uit lib/permissions, zodat er één definitie van "zit al in een gang"
 * blijft bestaan.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {import('discord.js').GuildMember|null|undefined} member Het te controleren lid.
 * @returns {object|null} Het GangRecord van de andere gang, of null.
 */
function findGangOfMember(guild, member) {
  // Op een partial member ontbreekt roles.cache; dan slaan we de controle over in plaats
  // van te crashen (SPEC: de bot mag nooit stuklopen op iets wat een gebruiker typt).
  if (!member || !member.roles?.cache) return null;
  try {
    return store.listGangs(guild.id).find((gang) => gang && (
      isMemberOf(member, gang) || isLeaderOf(member, gang)
    )) || null;
  } catch {
    return null;
  }
}

/**
 * Nederlandse aanduiding van een lid voor in een melding.
 *
 * @param {import('discord.js').GuildMember|null|undefined} member Het lid.
 * @returns {string} De naam, of een neutrale omschrijving.
 */
function describeMember(member) {
  const naam = member?.user?.tag || member?.user?.username || member?.displayName;
  return typeof naam === 'string' && naam.trim() ? naam.trim() : 'Dat lid';
}

/**
 * Volledige voorcontrole van createGang: naam, emoji, uniciteit, serverlimieten, de
 * botrechten, de opgegeven boss en de ledenlimiet.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} opts Opties zoals meegegeven aan createGang.
 * @returns {{ok: true, name: string, emoji: string, slug: string, abbreviation: string, memberLimit: number}|{ok: false, error: string}} Resultaat.
 */
function validateCreateOptions(guild, opts) {
  if (!guild || !guild.id) {
    return { ok: false, error: 'Interne fout: er is geen server meegegeven aan createGang.' };
  }

  const named = validateNameAndEmoji(guild, opts?.name, opts?.emoji, null, opts?.abbreviation);
  if (!named.ok) return named;

  const capacity = validateGuildCapacity(guild);
  if (!capacity.ok) return capacity;

  if (opts?.bossMember && opts.bossMember.user?.bot) {
    return { ok: false, error: 'Een bot kan geen boss van een gang zijn. Kies een echt lid.' };
  }

  // Zonder deze rechten weigert Discord de kanaalpermissies (50013) en zou het rechtenfilter
  // zelfs de @everyone-deny weglaten, waardoor de gang voor iedereen zichtbaar wordt. Toetsen
  // vóór stap 2 (rolcreatie), zodat er niets aangemaakt en teruggedraaid hoeft te worden.
  const essential = missingEssentialPermissions(guild);
  if (essential.length) return { ok: false, error: essentialPermissionError(essential) };

  // Dezelfde regel als bij /gang aannemen en /gang promoveer: niemand zit in twee gangs
  // tegelijk. Zonder deze check is /gangbeheer aanmaken de enige route waarlangs de bot dat zelf
  // veroorzaakt (dubbele tellingen, twee #aangenomen-kanalen, 'Welke gang bedoel je?').
  const bossConflict = findGangOfMember(guild, opts?.bossMember);
  if (bossConflict) {
    return {
      ok: false,
      error: `${describeMember(opts.bossMember)} zit al bij ${bossConflict.name}. Laat die persoon`
        + ` eerst uit ${bossConflict.name} halen met /gang ontslaan (of in het ontslagkanaal)`
        + ` en maak hem daarna boss van ${named.name}.`,
    };
  }

  const guildConfig = store.getGuildConfig(guild.id);
  return {
    ok: true,
    name: named.name,
    emoji: named.emoji,
    slug: named.slug,
    abbreviation: named.abbreviation,
    memberLimit: limitOrDefault(opts?.memberLimit, guildConfig.defaultMemberLimit, 1),
  };
}

// ---------------------------------------------------------------------------
// Bouwstenen voor createGang
// ---------------------------------------------------------------------------

/**
 * Maakt de drie rollen aan in de volgorde gang, underboss, boss.
 * Alles wat gelukt is wordt in `created` bijgehouden voor een eventuele rollback.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {string} name Weergavenaam van de gang.
 * @param {string} reason Auditlog-reden.
 * @param {Array<{type: string, object: object, label: string}>} created Rollback-lijst.
 * @returns {Promise<Record<string, string>>} De drie rol-id's, per GangRecord-veld.
 * @throws {Error} Als Discord het aanmaken weigert.
 */
async function createGangRoles(guild, name, reason, created) {
  const ids = {};
  for (const spec of roleSpecs(name)) {
    const role = await guild.roles.create({
      name: spec.name,
      colors: { primaryColor: ROLE_COLORS[spec.kind] ?? GANG_ROLE_COLOR },
      hoist: ROLE_HOIST[spec.kind] === true,
      mentionable: true,
      permissions: [],
      reason,
    });
    created.push({ type: 'role', object: role, label: `rol ${spec.name}` });
    ids[spec.key] = role.id;
  }
  return ids;
}

/**
 * Maakt de categorie van de gang aan, meteen met de juiste overwrites.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} draft Conceptgang met de rol-id's al ingevuld.
 * @param {object} guildConfig Serverconfiguratie.
 * @param {string} reason Auditlog-reden.
 * @param {Array<{type: string, object: object, label: string}>} created Rollback-lijst.
 * @returns {Promise<import('discord.js').CategoryChannel>} De nieuwe categorie.
 * @throws {Error} Als Discord het aanmaken weigert.
 */
async function createGangCategory(guild, draft, guildConfig, reason, created) {
  const category = await guild.channels.create({
    name: buildCategoryName(draft.emoji, draft.name),
    type: ChannelType.GuildCategory,
    permissionOverwrites: buildCategoryOverwrites(guild, draft, guildConfig).map(toCreateOverwrite),
    reason,
  });
  created.push({ type: 'channel', object: category, label: `categorie ${category.name}` });
  return category;
}

/**
 * Maakt de zes kanalen in blueprint-volgorde aan, met een korte pauze ertussen tegen de
 * rate limit. Kanalen zonder eigen uitzonderingen krijgen geen expliciete overwrites mee
 * en erven daardoor netjes van de categorie.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} draft Conceptgang met rol-id's en slug.
 * @param {object} guildConfig Serverconfiguratie.
 * @param {string} categoryId Id van de zojuist gemaakte categorie.
 * @param {string} reason Auditlog-reden.
 * @param {Array<{type: string, object: object, label: string}>} created Rollback-lijst.
 * @returns {Promise<Record<string, string>>} Kanaal-id per blueprint-soort.
 * @throws {Error} Als Discord het aanmaken weigert.
 */
async function createGangChannels(guild, draft, guildConfig, categoryId, reason, created) {
  const channels = {};
  for (let index = 0; index < CHANNEL_BLUEPRINT.length; index += 1) {
    const item = CHANNEL_BLUEPRINT[index];
    if (index > 0) await sleep(CHANNEL_CREATE_PAUSE_MS);

    const payload = {
      name: buildChannelName(item, draft.slug),
      type: item.type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText,
      parent: categoryId,
      reason,
    };
    if (CHANNEL_PERMS[item.kind]) {
      payload.permissionOverwrites = buildChannelOverwrites(guild, draft, item.kind, guildConfig)
        .map(toCreateOverwrite);
    }

    const channel = await guild.channels.create(payload);
    created.push({ type: 'channel', object: channel, label: `kanaal ${channel.name}` });
    channels[item.kind] = channel.id;
  }
  return channels;
}

/**
 * Geeft het opgegeven lid de gangrol en de bossrol.
 *
 * @param {import('discord.js').GuildMember|null|undefined} bossMember Het toekomstige bosslid.
 * @param {object} draft Conceptgang met de rol-id's.
 * @param {string} reason Auditlog-reden.
 * @returns {Promise<boolean>} true als er rollen toegekend zijn.
 * @throws {Error} Als Discord het toekennen weigert (bijvoorbeeld door de rolhierarchie).
 */
async function assignBossMember(bossMember, draft, reason) {
  if (!bossMember || !bossMember.roles) return false;
  const roleIds = [draft.roleId, draft.bossRoleId].filter((id) => typeof id === 'string' && id);
  if (!roleIds.length) return false;
  await bossMember.roles.add(roleIds, reason);
  return true;
}

/**
 * Draait een mislukte aanmaak terug: alles wat al bestond wordt in omgekeerde volgorde
 * verwijderd, elk in een eigen try/catch zodat een fout de rest niet blokkeert.
 *
 * @param {Array<{type: string, object: {delete: Function}, label: string}>} created Rollback-lijst.
 * @param {string} reason Auditlog-reden.
 * @returns {Promise<void>} Belofte die resolvet als alles geprobeerd is.
 */
async function rollbackCreated(created, reason) {
  for (let index = created.length - 1; index >= 0; index -= 1) {
    const item = created[index];
    if (!item || typeof item.object?.delete !== 'function') continue;
    try {
      await item.object.delete(reason);
      logger.debug(`gangService: ${item.label} teruggedraaid.`);
    } catch (err) {
      logger.warn(`gangService: terugdraaien van ${item.label} mislukt (${err.message}).`);
    }
  }
}

/**
 * Bouwt de foutmelding die de gebruiker ziet als het aanmaken mislukt is.
 *
 * @param {Error} err De opgetreden fout.
 * @returns {string} Nederlandse melding met een concrete oplossingsrichting.
 */
function createFailureMessage(err, guild) {
  const detail = err?.message ? err.message : 'onbekende fout';
  // permissionHint noemt bij 50013 het recht dat de bot echt mist; de oude vaste tekst wees
  // naar "Rollen beheren"/"Kanalen beheren" en stuurde de beheerder dus de verkeerde kant op.
  return `Het aanmaken is mislukt en alles is teruggedraaid (${detail}). ${permissionHint(err, guild)}`;
}

// ---------------------------------------------------------------------------
// Rolvolgorde: per gang een blokje, hoogste rang bovenaan
// ---------------------------------------------------------------------------

/**
 * De hoogste rol van de bot. Zonder die rol (koude cache) valt niet te bepalen waar de
 * gangrollen mogen staan, en dan verplaatsen we liever niets.
 *
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @returns {import('discord.js').Role|null} De hoogste botrol, of null.
 */
function highestBotRole(guild) {
  try {
    const role = guild?.members?.me?.roles?.highest;
    return role && Number.isFinite(Number(role.position)) ? role : null;
  } catch {
    return null;
  }
}

/**
 * De laagste positie die de onderste gangrol mag innemen.
 *
 * Standaard 1: positie 0 is van @everyone en die blijft altijd onderaan. Is er met
 * /setup bodemrol een bodemrol ingesteld, dan ligt de grens een plek boven die rol,
 * zodat nieuwe gangrollen daar nooit onder belanden.
 *
 * De bodemrol zelf kan nooit meetellen als grens voor zichzelf: is hij (per ongeluk) ook
 * een gangrol, dan vallen we terug op 1 in plaats van een eis die niet te halen valt.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {import('discord.js').Role[]} gangRollen De gangrollen die geordend worden.
 * @returns {number} De laagste toegestane positie, minimaal 1.
 */
function roleFloorPosition(guild, gangRollen) {
  let floorId = null;
  try {
    floorId = store.getGuildConfig(guild.id)?.roleFloorId || null;
  } catch (err) {
    logger.warn(`gangService: de bodemrol kon niet gelezen worden (${err.message}).`);
    return 1;
  }
  if (!floorId) return 1;

  const floorRole = resolveRole(guild, floorId);
  if (!floorRole) {
    logger.warn(`gangService: de ingestelde bodemrol (${floorId}) bestaat niet meer; `
      + 'de gangrollen worden alleen boven @everyone gehouden.');
    return 1;
  }
  if (gangRollen.some((role) => role.id === floorRole.id)) {
    logger.warn(`gangService: de bodemrol "${floorRole.name}" is zelf een gangrol; `
      + 'hij wordt als ondergrens genegeerd.');
    return 1;
  }

  const positie = Number(floorRole.position);
  return Number.isFinite(positie) && positie >= 0 ? positie + 1 : 1;
}

/**
 * Nederlandse melding voor het geval de gangrollen niet tussen de bodemrol en de botrol passen.
 *
 * @param {number} aantal Aantal gangrollen dat geordend moest worden.
 * @param {number} bodem De laagste toegestane positie (1 = geen bodemrol ingesteld).
 * @returns {string} De melding, met de oplossing erbij.
 */
function roleOrderTooLowError(aantal, bodem) {
  const bodemUitleg = bodem > 1
    ? ' Er is ook een bodemrol ingesteld waar ze boven moeten blijven; haal die weg met'
      + ' /setup bodemrol zonder rol als je hem niet meer nodig hebt.'
    : '';
  return `De rol van de bot staat te laag in de rollenlijst: de ${aantal} gangrollen passen er`
    + ' niet allemaal onder, dus de volgorde is niet aangepast (er is niets verplaatst).'
    + ' Sleep in Serverinstellingen > Rollen de rol van de bot boven alle gangrollen en voer'
    + ` daarna /gangbeheer herstel uit.${bodemUitleg}`;
}

/**
 * Zet de rollen van alle gangs op volgorde: per gang een blokje met de hoogste rang
 * bovenaan (Boss, Underboss, gangrol), en de gangs onderling op oplopende gang-id
 * (aanmaakvolgorde), zodat de lijst voorspelbaar blijft.
 *
 * Het blok blijft staan waar de gangrollen nu al staan: de hoogste gangrol bepaalt de
 * bovenkant en daaronder komen de andere aaneengesloten te staan. Zo schuiven de rollen
 * niet ineens boven de staff- en moderatierollen uit.
 *
 * Alles gebeurt met EEN `guild.roles.setPositions()`-aanroep: per rol een losse call kost
 * onnodig veel API-verzoeken en laat tussenstanden zien in de rollenlijst.
 *
 * Idempotent: staat alles al goed, dan komt er `verplaatst: 0` terug zonder API-call.
 * Rollen die niet meer bestaan worden overgeslagen. Gooit nooit.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @returns {Promise<{ok: boolean, verplaatst: number, error?: string|null}>} Wat er verplaatst
 *   is, of een Nederlandse uitleg waarom dat niet kon.
 */
async function applyRoleOrder(guild) {
  if (!guild || !guild.id || typeof guild.roles?.setPositions !== 'function') {
    return {
      ok: false,
      verplaatst: 0,
      error: 'Interne fout: er is geen bruikbare server meegegeven aan applyRoleOrder.',
    };
  }

  let gangs = [];
  try {
    gangs = (store.listGangs(guild.id) || [])
      .slice()
      .sort((a, b) => (Number(a?.id) || 0) - (Number(b?.id) || 0));
  } catch (err) {
    logger.warn(`gangService: gangs ophalen voor de rolvolgorde mislukt (${err.message}).`);
    return {
      ok: false,
      verplaatst: 0,
      error: 'De gangs konden niet uit data/owc.json gelezen worden, dus de rolvolgorde is'
        + ' niet aangepast. Controleer het bestand en voer /gangbeheer herstel uit.',
    };
  }

  // De gewenste stand, van boven naar beneden. Een rol die niet meer bestaat slaan we over.
  const gewenst = [];
  for (const gang of gangs) {
    for (const key of ROLE_ORDER_KEYS) {
      const role = resolveRole(guild, gang?.[key]);
      if (role) gewenst.push(role);
    }
  }
  // Zonder gangrollen valt er niets te ordenen. Een enkele rol wel: die moet nog steeds
  // boven de bodemrol komen te staan.
  if (!gewenst.length) return { ok: true, verplaatst: 0, error: null };

  const botRole = highestBotRole(guild);
  if (!botRole) {
    return {
      ok: false,
      verplaatst: 0,
      error: 'De bot kan zijn eigen plek in de rollenlijst nu niet bepalen (de server is nog'
        + ' niet volledig ingeladen), dus er is niets verplaatst. Probeer het zo opnieuw met'
        + ' /gangbeheer herstel.',
    };
  }

  // Elke gangrol moet onder de hoogste botrol staan; wat daarboven staat mag de bot van
  // Discord niet aanraken (50013).
  const botPositie = Number(botRole.position);
  const teHoog = gewenst.filter((role) => !(Number(role.position) < botPositie));
  if (teHoog.length) {
    return { ok: false, verplaatst: 0, error: roleOrderTooLowError(gewenst.length, 1) };
  }

  // Onderkant van het blok: boven @everyone, en boven de bodemrol als die is ingesteld.
  const bodem = roleFloorPosition(guild, gewenst);
  // De onderste gangrol staat op (top - lengte + 1), dus dit is de laagste bruikbare top.
  const laagsteTop = bodem + gewenst.length - 1;

  // Bovenkant van het blok: de hoogste plek die de gangrollen nu al innemen, maar nooit
  // boven de botrol. Zo blijven de blokjes staan waar ze al stonden en schuiven ze niet
  // ineens boven de staff- en moderatierollen uit.
  const plafond = botPositie - 1;
  const hoogste = gewenst.reduce((max, role) => Math.max(max, Number(role.position) || 0), 0);
  let top = Math.min(plafond, hoogste);

  // Passen ze daar niet allemaal boven de ondergrens (verse rollen komen bij Discord onderaan
  // te staan, dus vlak boven @everyone), dan schuift het blok net zo ver omhoog als nodig is.
  if (top < laagsteTop) top = Math.min(plafond, laagsteTop);
  if (top < laagsteTop) {
    return { ok: false, verplaatst: 0, error: roleOrderTooLowError(gewenst.length, bodem) };
  }

  const wijzigingen = [];
  gewenst.forEach((role, index) => {
    const doel = top - index;
    if (Number(role.position) !== doel) wijzigingen.push({ role: role.id, position: doel });
  });
  if (!wijzigingen.length) return { ok: true, verplaatst: 0, error: null };

  try {
    await guild.roles.setPositions(wijzigingen);
  } catch (err) {
    logger.warn(`gangService: de rolvolgorde zetten mislukt (${err?.message || err}).`);
    return {
      ok: false,
      verplaatst: 0,
      error: `De rollen konden niet op volgorde gezet worden (${err?.message || 'onbekende fout'}).`
        + ' Controleer of de bot het recht "Rollen beheren" heeft en of de botrol boven alle'
        + ' gangrollen staat in Serverinstellingen > Rollen.',
    };
  }

  logger.debug(`gangService: ${wijzigingen.length} gangrol(len) op volgorde gezet.`);
  return { ok: true, verplaatst: wijzigingen.length, error: null };
}

/**
 * Roept applyRoleOrder aan zonder dat een fout de hoofdactie kan laten mislukken: de gang
 * is dan al aangemaakt, hernoemd of verwijderd en dat mag niet stuklopen op een rollenlijst
 * die net niet klopt.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {string} watGebeurde Korte omschrijving voor in het logboek.
 * @returns {Promise<{ok: boolean, verplaatst: number, error?: string|null}>} Het resultaat van
 *   applyRoleOrder; bij een onverwachte fout `ok: false`.
 */
async function orderRolesQuietly(guild, watGebeurde) {
  try {
    const result = await applyRoleOrder(guild);
    if (!result.ok && result.error) {
      logger.warn(`gangService: de rolvolgorde is niet bijgewerkt na ${watGebeurde}. ${result.error}`);
    }
    return result;
  } catch (err) {
    logger.warn(
      `gangService: de rolvolgorde bijwerken na ${watGebeurde} liep vast`
      + ` (${err?.message || 'onbekende fout'}). De actie zelf is gewoon gelukt.`,
    );
    return { ok: false, verplaatst: 0, error: null };
  }
}

/**
 * Ruimt de achtergebleven `<Gang> Meeloper`-rol op. Die rol had sinds dark-chat leiding-only
 * werd geen enkel eigen recht meer en telt sinds deze versie ook niet meer apart mee; wie hem
 * droeg houdt zijn gangrol en is dus gewoon lid.
 *
 * Mislukt het verwijderen, dan is dat geen blokkade: warn loggen en doorgaan. Het id blijft
 * dan in de opslag staan, zodat een volgende /gangbeheer herstel het opnieuw kan proberen.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} gang Het GangRecord (mogelijk nog met het oude rol-id erin).
 * @param {string} reason Auditlog-reden.
 * @returns {Promise<{opgeruimd: boolean, naam: string|null}>} Of de rol weg is, en hoe hij heette.
 */
async function cleanupLegacyRole(guild, gang, reason) {
  const role = resolveRole(guild, gang?.meeloperRoleId);
  if (!role) return { opgeruimd: false, naam: null };

  const naam = role.name || 'de oude rol';
  try {
    await role.delete(reason);
    logger.info(`gangService: de achtergebleven rol ${naam} is opgeruimd.`);
    return { opgeruimd: true, naam };
  } catch (err) {
    logger.warn(
      `gangService: de achtergebleven rol ${naam} kon niet verwijderd worden (${err?.message || err}).`
      + ' Verwijder hem met de hand in Serverinstellingen > Rollen, of probeer /gangbeheer herstel opnieuw.',
    );
    return { opgeruimd: false, naam };
  }
}

// ---------------------------------------------------------------------------
// Publieke API
// ---------------------------------------------------------------------------

/**
 * Maakt een complete gang aan: 3 rollen, 1 categorie, 6 kanalen, toegang tot de gedeelde
 * categorieen en optioneel meteen een boss. Faalt er iets halverwege, dan wordt alles wat
 * al aangemaakt was weer verwijderd en blijft de server schoon achter.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {{name: string, emoji: string, bossMember?: import('discord.js').GuildMember|null, memberLimit?: number, actorId?: string}} opts Opties.
 * @returns {Promise<{ok: true, gang: object, warning: string|null}|{ok: false, error: string}>} Het GangRecord (met eventueel een waarschuwing over ontbrekende botrechten) of een Nederlandse foutmelding.
 */
async function createGang(guild, opts) {
  const validation = validateCreateOptions(guild, opts);
  if (!validation.ok) return { ok: false, error: validation.error };

  const actorId = asActorId(opts?.actorId);
  const reason = auditReason(`Gang ${validation.name} aangemaakt door ${actorId || 'onbekend'}`);
  const undoReason = auditReason(`Mislukte aanmaak van gang ${validation.name} teruggedraaid`);
  const guildConfig = store.getGuildConfig(guild.id);
  const created = [];

  const draft = {
    name: validation.name,
    slug: validation.slug,
    abbreviation: validation.abbreviation,
    emoji: validation.emoji,
    categoryId: null,
    roleId: null,
    bossRoleId: null,
    underbossRoleId: null,
    channels: {},
    memberLimit: validation.memberLimit,
    createdBy: actorId,
  };

  try {
    Object.assign(draft, await createGangRoles(guild, draft.name, reason, created));

    const category = await createGangCategory(guild, draft, guildConfig, reason, created);
    draft.categoryId = category.id;

    draft.channels = await createGangChannels(guild, draft, guildConfig, category.id, reason, created);

    const shared = await syncSharedCategories(guild, draft);
    if (!shared.ok || shared.error) {
      logger.warn(`gangService: gedeelde categorieen niet volledig bijgewerkt (${shared.error}).`);
    }

    await assignBossMember(opts?.bossMember, draft, reason);

    const gang = store.addGang(guild.id, draft);
    if (!gang) throw new Error('het GangRecord kon niet opgeslagen worden in data/owc.json');

    // Pas hierna kan de rolvolgorde gezet worden: applyRoleOrder leest de gangs uit de
    // opslag, dus voor store.addGang is deze gang daar nog niet te vinden.
    await orderRolesQuietly(guild, `het aanmaken van ${gang.name}`);

    // Zijn er rechten uit de overwrites gefilterd, dan moet staff dat weten: anders denken
    // bosses dat ze bijvoorbeeld mute-rechten hebben terwijl die nooit gezet zijn. Hetzelfde
    // geldt voor een extrarol die niet meer bestaat: die is stil overgeslagen.
    const warning = [overwritePermissionNotice(guild), missingGlobalRoleNotice(guild, guildConfig)]
      .filter((regel) => typeof regel === 'string' && regel)
      .join(' ') || null;
    if (warning) logger.warn(`gangService: ${warning}`);

    // De nieuwe boss- en underbossrol moeten meteen in #aangenomen en #ontslagen kunnen typen;
    // anders kan een kersverse boss zijn eigen leden pas aannemen na een /gangbeheer herstel. Een fout
    // hier mag de aanmaak NOOIT terugdraaien: de gang staat er al en werkt verder gewoon.
    try {
      const flow = await applyFlowChannelPermissions(guild);
      if (!flow.ok && flow.error) logger.warn(`gangService: ${flow.error}`);
      for (const regel of (Array.isArray(flow.waarschuwingen) ? flow.waarschuwingen : [])) {
        logger.warn(`gangService: ${regel}`);
      }
    } catch (flowErr) {
      logger.warn(
        'gangService: de schrijfrechten van de aangenomen-/ontslagen-kanalen konden niet'
        + ` bijgewerkt worden na het aanmaken van ${draft.name}`
        + ` (${flowErr?.message || 'onbekende fout'}). De gang zelf is gewoon aangemaakt;`
        + ' voer /gangbeheer herstel uit om dit alsnog recht te zetten.',
      );
    }

    logger.info(`Gang ${gang.name} (#${gang.id}) aangemaakt door ${actorId || 'onbekend'}.`);
    return { ok: true, gang, warning };
  } catch (err) {
    logger.error(`gangService: aanmaken van gang ${draft.name} mislukt; alles wordt teruggedraaid.`, err);
    await rollbackCreated(created, undoReason);
    return { ok: false, error: createFailureMessage(err, guild) };
  }
}

/**
 * Verwijdert een gang: eerst de zes kanalen, dan de categorie en optioneel de drie rollen.
 *
 * Het GangRecord verdwijnt ALLEEN uit de opslag als alles daadwerkelijk opgeruimd is. Lukte
 * er iets niet, dan blijft het record staan en komt er `ok: false` terug met wat er handmatig
 * of na een rechtenfix nog moet gebeuren - anders blijven er weesrollen achter die met geen
 * enkel commando meer op te ruimen zijn (/gangbeheer verwijderen en /gangbeheer herstel vinden de gang
 * dan niet meer).
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} gang Het GangRecord.
 * @param {{deleteRoles?: boolean, actorId?: string}} opts Opties; `deleteRoles` staat standaard aan.
 * @returns {Promise<{ok: boolean, error: string|null, failed: string[]}>} Resultaat met eventuele restproblemen.
 */
async function deleteGang(guild, gang, opts) {
  if (!guild || !guild.id || !gang) {
    return { ok: false, error: 'Interne fout: gang of server ontbreekt bij deleteGang.', failed: [] };
  }

  const actorId = asActorId(opts?.actorId);
  const reason = auditReason(`Gang ${gang.name} verwijderd door ${actorId || 'onbekend'}`);
  const deleteRoles = opts?.deleteRoles !== false;
  const failed = [];

  // Voorcontrole: kan de bot de gangrollen überhaupt verwijderen? Staat de botrol eronder
  // (dat gebeurt zodra staff de gangrollen netjes bovenaan sleept), dan faalt elke roldelete
  // met 50013 terwijl de kanalen al weg zijn. Nu breken we af vóór de eerste delete, zodat
  // /gangbeheer verwijderen gewoon herhaalbaar blijft zodra de rolvolgorde klopt.
  if (deleteRoles && canCompareRolePositions(guild)) {
    const blocked = [];
    for (const roleId of [gang.bossRoleId, gang.underbossRoleId, gang.roleId]) {
      const role = resolveRole(guild, roleId);
      if (role && !botCanManageRole(guild, roleId)) blocked.push(role.name);
    }
    if (blocked.length) {
      return {
        ok: false,
        error: `De bot kan de rollen ${blocked.join(', ')} niet verwijderen omdat de botrol`
          + ' eronder staat (of het beheerde rollen zijn). Er is nog niets verwijderd. Sleep in'
          + ' Serverinstellingen > Rollen de rol van de bot boven de gangrollen en voer'
          + ' /gangbeheer verwijderen opnieuw uit, of kies rollen_verwijderen: Nee.',
        failed: blocked,
      };
    }
  }

  for (const item of CHANNEL_BLUEPRINT) {
    const channel = resolveChannel(guild, gang.channels?.[item.kind]);
    if (channel) await safeDelete(channel, reason, failed, `kanaal ${channel.name}`);
  }

  // Kanalen die niet in het GangRecord staan laten we bewust staan: die kunnen door staff
  // zelf toegevoegd zijn. Ze raken alleen hun categorie kwijt; we melden het wel.
  const category = resolveCategory(guild, gang);
  let leftovers = 0;
  if (category) {
    try {
      leftovers = guild.channels.cache.filter((child) => child.parentId === category.id).size;
    } catch {
      leftovers = 0;
    }
    await safeDelete(category, reason, failed, `categorie ${category.name}`);
  }

  if (deleteRoles) {
    for (const roleId of [gang.bossRoleId, gang.underbossRoleId, gang.roleId]) {
      const role = resolveRole(guild, roleId);
      if (role) await safeDelete(role, reason, failed, `rol ${role.name}`);
    }
  }

  // De achtergebleven `<Gang> Meeloper`-rol gaat sowieso mee, ook als de andere rollen
  // blijven staan: het begrip bestaat niet meer, en zodra het GangRecord weg is kent niemand
  // het rol-id nog. Mislukt dat, dan blokkeert het de verwijdering niet (zie cleanupLegacyRole).
  const legacy = await cleanupLegacyRole(guild, gang, reason);
  if (legacy.opgeruimd) store.updateGang(guild.id, gang.id, { meeloperRoleId: null });

  const notes = [];
  if (leftovers) {
    notes.push(`Er stonden nog ${leftovers} extra kanalen in de categorie; die zijn blijven bestaan.`);
  }
  if (legacy.opgeruimd) {
    notes.push(`De oude rol ${legacy.naam} bestond nog en is ook verwijderd.`);
  }

  // Is er iets blijven staan, dan houden we het GangRecord: zonder record is de gang met geen
  // enkel commando meer te bereiken en blijven de rollen (met alle leden erin) voor altijd
  // achter. Met het record erbij kan staff het na een rechtenfix gewoon opnieuw proberen.
  if (failed.length) {
    logger.warn(
      `gangService: gang ${gang.name} (#${gang.id}) is niet volledig verwijderd; het GangRecord blijft staan.`,
    );
    return {
      ok: false,
      error: `Niet alles kon verwijderd worden: ${failed.join(', ')}. De gang blijft daarom in de`
        + ' opslag staan, dus er is niets kwijt: los de rechten of de rolvolgorde op en voer'
        + ' /gangbeheer verwijderen opnieuw uit (of /gangbeheer herstel om de rest terug te zetten).'
        + (notes.length ? ` ${notes.join(' ')}` : ''),
      failed,
    };
  }

  if (!store.removeGang(guild.id, gang.id)) {
    logger.warn(`gangService: gang #${gang.id} stond niet (meer) in de opslag.`);
  }

  // De gang is uit de opslag; de overwrites van HAAR rollen horen mee weg uit #aangenomen en
  // #ontslagen. Opruimen mag hier wel (in tegenstelling tot applyFlowChannelPermissions zelf):
  // dit zijn precies de rol-id's die de bot ooit zelf heeft aangemaakt. Daarna nog een keer
  // zetten, zodat een rol die ook bij een ANDERE gang of bij /setup extrarollen hoort meteen
  // haar allow terugkrijgt.
  try {
    await removeFlowOverwrites(
      guild,
      [gang.bossRoleId, gang.underbossRoleId, gang.roleId],
      reason,
    );
    const flow = await applyFlowChannelPermissions(guild);
    if (!flow.ok && flow.error) logger.warn(`gangService: ${flow.error}`);
  } catch (flowErr) {
    logger.warn(
      'gangService: de schrijfrechten van de aangenomen-/ontslagen-kanalen konden niet'
      + ` opgeruimd worden na het verwijderen van ${gang.name}`
      + ` (${flowErr?.message || 'onbekende fout'}). Voer /gangbeheer herstel uit op een andere gang`
      + ' om ze opnieuw te laten zetten.',
    );
  }

  // De rollen van deze gang zijn weg; de blokjes van de overgebleven gangs sluiten weer aan.
  await orderRolesQuietly(guild, `het verwijderen van ${gang.name}`);

  logger.info(`Gang ${gang.name} (#${gang.id}) verwijderd door ${actorId || 'onbekend'}.`);
  return { ok: true, error: notes.length ? notes.join(' ') : null, failed };
}

/**
 * Hernoemt de drie rollen die bij een gang horen.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} gang Het GangRecord met de huidige rol-id's.
 * @param {string} name De nieuwe weergavenaam.
 * @param {string} reason Auditlog-reden.
 * @param {string[]} failed Verzamellijst met mislukte onderdelen.
 * @returns {Promise<number>} Aantal daadwerkelijk hernoemde rollen.
 */
async function renameGangRoles(guild, gang, name, reason, failed) {
  let renamed = 0;
  for (const spec of roleSpecs(name)) {
    const role = resolveRole(guild, gang[spec.key]);
    if (!role) {
      failed.push(`rol ${spec.name} (bestaat niet meer)`);
      continue;
    }
    if (role.name === spec.name) continue;
    try {
      await role.setName(spec.name, reason);
      renamed += 1;
    } catch (err) {
      logger.warn(`gangService: hernoemen van rol ${role.id} mislukt (${err.message}).`);
      failed.push(`rol ${spec.name}`);
    }
  }
  return renamed;
}

/**
 * Hernoemt de kanalen die de slug in hun naam dragen (mededeling, boss, chat en oortje).
 * Media en dark-chat houden hun vaste naam en worden overgeslagen.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} gang Het GangRecord met de huidige kanaal-id's.
 * @param {string} slug De nieuwe slug.
 * @param {string} reason Auditlog-reden.
 * @param {string[]} failed Verzamellijst met mislukte onderdelen.
 * @returns {Promise<number>} Aantal daadwerkelijk hernoemde kanalen.
 */
async function renameGangChannels(guild, gang, slug, reason, failed) {
  let renamed = 0;
  for (const item of CHANNEL_BLUEPRINT) {
    if (!item.useSlug) continue;

    const wanted = buildChannelName(item, slug);
    const channel = resolveChannel(guild, gang.channels?.[item.kind]);
    if (!channel) {
      failed.push(`kanaal ${wanted} (bestaat niet meer)`);
      continue;
    }
    if (channel.name === wanted) continue;

    try {
      await channel.setName(wanted, reason);
      renamed += 1;
    } catch (err) {
      logger.warn(`gangService: hernoemen van kanaal ${channel.id} mislukt (${err.message}).`);
      failed.push(`kanaal ${wanted}`);
    }
  }
  return renamed;
}

/**
 * Hernoemt de categorie van een gang.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} gang Het GangRecord.
 * @param {string} name De nieuwe weergavenaam.
 * @param {string} emoji De nieuwe emoji.
 * @param {string} reason Auditlog-reden.
 * @param {string[]} failed Verzamellijst met mislukte onderdelen.
 * @returns {Promise<boolean>} true als de categorie nu de juiste naam draagt.
 */
async function renameGangCategory(guild, gang, name, emoji, reason, failed) {
  const category = resolveCategory(guild, gang);
  if (!category) {
    failed.push('categorie (bestaat niet meer)');
    return false;
  }

  const wanted = buildCategoryName(emoji, name);
  if (category.name === wanted) return true;

  try {
    await category.setName(wanted, reason);
    return true;
  } catch (err) {
    logger.warn(`gangService: hernoemen van categorie ${category.id} mislukt (${err.message}).`);
    failed.push('categorie');
    return false;
  }
}

/**
 * Hernoemt een gang: de categorie, de drie rollen en de kanalen met de slug in hun naam.
 * `name`, `emoji` en `abbreviation` zijn allemaal optioneel; wat niet meegegeven wordt
 * blijft ongewijzigd. `clearAbbreviation` haalt een bestaande afkorting weg, waarna de
 * kanaalnamen weer uit de volledige naam komen.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} gang Het huidige GangRecord.
 * @param {{name?: string, emoji?: string, abbreviation?: string, clearAbbreviation?: boolean, actorId?: string}} opts Wijzigingen.
 * @returns {Promise<{ok: true, gang: object, error: string|null}|{ok: false, error: string}>} Resultaat.
 */
async function renameGang(guild, gang, opts) {
  if (!guild || !guild.id || !gang) {
    return { ok: false, error: 'Interne fout: gang of server ontbreekt bij renameGang.' };
  }

  const rawName = typeof opts?.name === 'string' && opts.name.trim() ? opts.name : gang.name;
  const rawEmoji = typeof opts?.emoji === 'string' && opts.emoji.trim() ? opts.emoji : gang.emoji;
  // Weghalen wint van een meegegeven afkorting: wie allebei opgeeft bedoelt vrijwel zeker
  // het laatste, en zo levert die combinatie in elk geval geen stille verrassing op.
  let rawAbbreviation;
  if (opts?.clearAbbreviation) rawAbbreviation = '';
  else if (typeof opts?.abbreviation === 'string' && opts.abbreviation.trim()) rawAbbreviation = opts.abbreviation;
  else rawAbbreviation = gang.abbreviation || '';

  const validation = validateNameAndEmoji(guild, rawName, rawEmoji, gang.id, rawAbbreviation);
  if (!validation.ok) return validation;

  const { name, emoji, slug, abbreviation } = validation;
  if (name === gang.name && emoji === gang.emoji && slug === gang.slug
    && abbreviation === (gang.abbreviation || '')) {
    return { ok: true, gang, error: null };
  }

  const actorId = asActorId(opts?.actorId);
  const reason = auditReason(`Gang ${gang.name} hernoemd naar ${name} door ${actorId || 'onbekend'}`);
  const failed = [];

  await renameGangCategory(guild, gang, name, emoji, reason, failed);
  await renameGangRoles(guild, gang, name, reason, failed);
  if (slug !== gang.slug) await renameGangChannels(guild, gang, slug, reason, failed);

  const updated = store.updateGang(guild.id, gang.id, {
    name, slug, emoji, abbreviation,
  });
  const result = updated || {
    ...gang, name, slug, emoji, abbreviation,
  };

  // Een hernoemde rol kan door Discord ergens anders in de lijst belanden; het blokje van
  // deze gang hoort daarna weer netjes bij elkaar te staan.
  await orderRolesQuietly(guild, `het hernoemen van ${gang.name}`);

  logger.info(`Gang #${gang.id} hernoemd naar ${name} door ${actorId || 'onbekend'}.`);

  return {
    ok: true,
    gang: result,
    error: failed.length
      ? `Niet alles kon hernoemd worden: ${failed.join(', ')}. Voer /gangbeheer herstel uit.`
      : null,
  };
}

/**
 * Maakt ontbrekende rollen van een gang opnieuw aan en vult de patch aan.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} current Werkkopie van het GangRecord (wordt ter plekke bijgewerkt).
 * @param {object} patch Patch voor store.updateGang (wordt ter plekke aangevuld).
 * @param {string[]} changes Lijst met herstelde onderdelen (wordt ter plekke aangevuld).
 * @param {string} reason Auditlog-reden.
 * @returns {Promise<void>} Belofte die resolvet als alle drie de rollen bestaan.
 * @throws {Error} Als Discord het aanmaken van een rol weigert.
 */
async function repairGangRoles(guild, current, patch, changes, reason) {
  for (const spec of roleSpecs(current.name)) {
    if (resolveRole(guild, current[spec.key])) continue;

    const role = await guild.roles.create({
      name: spec.name,
      colors: { primaryColor: ROLE_COLORS[spec.kind] ?? GANG_ROLE_COLOR },
      hoist: ROLE_HOIST[spec.kind] === true,
      mentionable: true,
      permissions: [],
      reason,
    });
    current[spec.key] = role.id;
    patch[spec.key] = role.id;
    changes.push(`Rol ${spec.name} opnieuw aangemaakt.`);
  }

  // Rollen die al bestonden kunnen nog de oude weergave hebben, of iemand heeft het vinkje
  // met de hand omgezet. Hier rechttrekken, zodat /gangbeheer herstel ook dit dekt.
  await fixRoleHoist(guild, current, reason, changes);
}

/**
 * Zet bij de drie rollen van een gang de weergave-instelling goed: wat in ROLE_HOIST op
 * true staat komt apart in de ledenlijst, de rest niet.
 *
 * Idempotent en stil bij een rol die al goed staat. Mislukt een enkele rol (te hoog in de
 * lijst, of geen recht), dan wordt dat gemeld en gaat de rest gewoon door: een halve
 * ledenlijst is beter dan een afgebroken herstel.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} gang Het GangRecord.
 * @param {string} reason Auditlog-reden.
 * @param {string[]} [changes] Lijst met meldingen (wordt ter plekke aangevuld).
 * @returns {Promise<number>} Aantal rollen dat daadwerkelijk aangepast is.
 */
async function fixRoleHoist(guild, gang, reason, changes) {
  let aangepast = 0;
  for (const spec of roleSpecs(gang?.name || '')) {
    const role = resolveRole(guild, gang?.[spec.key]);
    if (!role) continue;

    const gewenst = ROLE_HOIST[spec.kind] === true;
    if (Boolean(role.hoist) === gewenst) continue;

    try {
      await role.setHoist(gewenst, reason);
      aangepast += 1;
      if (Array.isArray(changes)) {
        changes.push(gewenst
          ? `Rol ${role.name} wordt nu apart in de ledenlijst getoond.`
          : `Rol ${role.name} wordt niet meer apart in de ledenlijst getoond.`);
      }
    } catch (err) {
      logger.warn(`gangService: weergave van rol ${role.id} zetten mislukt (${err.message}).`);
      if (Array.isArray(changes)) {
        changes.push(`De weergave van ${role.name} kon niet aangepast worden: `
          + `${err.message}. Staat de botrol wel boven deze rol?`);
      }
    }
  }
  return aangepast;
}

/**
 * Zorgt dat de categorie van de gang bestaat; maakt hem anders opnieuw aan.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} current Werkkopie van het GangRecord.
 * @param {object} guildConfig Serverconfiguratie.
 * @param {object} patch Patch voor store.updateGang.
 * @param {string[]} changes Lijst met herstelde onderdelen.
 * @param {string} reason Auditlog-reden.
 * @returns {Promise<import('discord.js').CategoryChannel>} De (eventueel nieuwe) categorie.
 * @throws {Error} Als Discord het aanmaken weigert.
 */
async function repairGangCategory(guild, current, guildConfig, patch, changes, reason) {
  const existing = resolveCategory(guild, current);
  if (existing) return existing;

  const category = await guild.channels.create({
    name: buildCategoryName(current.emoji, current.name),
    type: ChannelType.GuildCategory,
    permissionOverwrites: buildCategoryOverwrites(guild, current, guildConfig).map(toCreateOverwrite),
    reason,
  });
  current.categoryId = category.id;
  patch.categoryId = category.id;
  changes.push(`Categorie ${category.name} opnieuw aangemaakt.`);
  return category;
}

/**
 * Zorgt dat de zes kanalen bestaan en onder de juiste categorie hangen.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} current Werkkopie van het GangRecord.
 * @param {object} guildConfig Serverconfiguratie.
 * @param {import('discord.js').CategoryChannel} category De categorie van de gang.
 * @param {object} patch Patch voor store.updateGang.
 * @param {string[]} changes Lijst met herstelde onderdelen.
 * @param {string} reason Auditlog-reden.
 * @returns {Promise<void>} Belofte die resolvet als alle kanalen bestaan.
 * @throws {Error} Als Discord het aanmaken van een kanaal weigert.
 */
async function repairGangChannels(guild, current, guildConfig, category, patch, changes, reason) {
  let createdCount = 0;

  for (const item of CHANNEL_BLUEPRINT) {
    const existing = resolveChannel(guild, current.channels?.[item.kind]);
    if (existing) {
      if (existing.parentId !== category.id) {
        try {
          await existing.setParent(category.id, { lockPermissions: false, reason });
          changes.push(`Kanaal ${existing.name} teruggezet in de categorie.`);
        } catch (err) {
          logger.warn(`gangService: kanaal ${existing.id} verplaatsen mislukt (${err.message}).`);
        }
      }
      continue;
    }

    if (createdCount > 0) await sleep(CHANNEL_CREATE_PAUSE_MS);

    const payload = {
      name: buildChannelName(item, current.slug),
      type: item.type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText,
      parent: category.id,
      reason,
    };
    if (CHANNEL_PERMS[item.kind]) {
      payload.permissionOverwrites = buildChannelOverwrites(guild, current, item.kind, guildConfig)
        .map(toCreateOverwrite);
    }

    const channel = await guild.channels.create(payload);
    if (!current.channels || typeof current.channels !== 'object') current.channels = {};
    current.channels[item.kind] = channel.id;
    if (!patch.channels) patch.channels = {};
    patch.channels[item.kind] = channel.id;
    changes.push(`Kanaal ${channel.name} opnieuw aangemaakt.`);
    createdCount += 1;
  }
}

/**
 * Controleert elk opgeslagen id tegen de server, maakt ontbrekende rollen en kanalen
 * opnieuw aan, werkt het GangRecord bij en zet alle permissies terug.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} gang Het GangRecord.
 * @param {{actorId?: string}} opts Opties.
 * @returns {Promise<{ok: boolean, changes: string[], gang?: object, error?: string}>} Wat er hersteld is.
 */
async function repairGang(guild, gang, opts) {
  if (!guild || !guild.id || !gang) {
    return { ok: false, changes: [], error: 'Interne fout: gang of server ontbreekt bij repairGang.' };
  }

  // Herstel struikelt over exact dezelfde 50013 als createGang. Eerst toetsen, dan pas
  // kanalen en rollen aanmaken; anders stopt het herstel halverwege.
  const essential = missingEssentialPermissions(guild);
  if (essential.length) {
    return { ok: false, changes: [], error: essentialPermissionError(essential) };
  }

  const actorId = asActorId(opts?.actorId);
  const reason = auditReason(`Gang ${gang.name} hersteld door ${actorId || 'onbekend'}`);
  const guildConfig = store.getGuildConfig(guild.id);
  const changes = [];
  const patch = {};
  const current = { ...gang, channels: { ...(gang.channels || {}) } };

  try {
    // Eerst opruimen wat er niet meer hoort te zijn: de `<Gang> Meeloper`-rol uit de oude
    // opzet. Lukt dat, dan verdwijnt het id ook uit het GangRecord.
    const legacy = await cleanupLegacyRole(guild, current, reason);
    if (legacy.opgeruimd) {
      current.meeloperRoleId = null;
      patch.meeloperRoleId = null;
      changes.push(
        `De oude rol ${legacy.naam} bestond nog en is verwijderd; wie hem had houdt de gangrol`
        + ' en telt gewoon als lid.',
      );
    }

    await repairGangRoles(guild, current, patch, changes, reason);
    const category = await repairGangCategory(guild, current, guildConfig, patch, changes, reason);
    await repairGangChannels(guild, current, guildConfig, category, patch, changes, reason);

    const saved = Object.keys(patch).length ? store.updateGang(guild.id, gang.id, patch) : null;
    const target = saved || current;

    const perms = await applyCategoryPermissions(guild, target);
    if (!perms.ok) {
      changes.push(`Let op: de permissies konden niet gezet worden (${perms.error}).`);
    } else if (perms.updated > 0) {
      changes.push(`Permissies opnieuw ingesteld (${perms.updated} aanpassingen).`);
    }

    // Laat concreet zien welke te ruime rechten dichtgezet zijn, zodat een overwrite die
    // bewust gezet was en hier tussen zat, gericht teruggezet kan worden.
    for (const regel of (Array.isArray(perms.removed) ? perms.removed : [])) changes.push(regel);

    const shared = await syncSharedCategories(guild, target);
    if (shared.ok && shared.added > 0) {
      changes.push(`Toegang tot ${shared.added} gedeelde categorie(en) hersteld.`);
    }
    // Verdwenen gedeelde categorieen werden hier eerder stil ingeslikt; staff moet weten dat
    // de lijst uit /setup gedeelde-categorie bijgewerkt moet worden.
    if (shared.error) changes.push(shared.error);

    // Zijn er rechten uit de overwrites gefilterd omdat de bot ze zelf niet heeft, meld dat
    // dan hier: anders lijkt het herstel geslaagd terwijl leiders hun rechten missen.
    const notice = overwritePermissionNotice(guild);
    if (notice) changes.push(notice);

    const weggevallen = missingGlobalRoleNotice(guild, guildConfig);
    if (weggevallen) changes.push(weggevallen);

    // /gangbeheer herstel zet ook de twee registerkanalen recht: alleen bosses en underbosses
    // (plus staff, de extrarollen en de bot) mogen daar posten. Zo hoeft de beheerder daar
    // geen apart commando voor te onthouden.
    const flow = await applyFlowChannelPermissions(guild);
    if (!flow.ok && flow.error) {
      changes.push(`Let op: ${flow.error}`);
    } else if (flow.updated > 0) {
      changes.push(
        `Schrijfrechten van ${flow.kanalen.join(' en ') || 'de registerkanalen'} bijgewerkt`
        + ` (${flow.updated} aanpassingen): alleen bosses, underbosses, staff en de bot kunnen`
        + ' daar nog typen.',
      );
    }
    // Alleen melden wat er echt aan de hand is. Dat er (nog) geen registerkanaal gekoppeld
    // is, is geen gebrek van deze gang: zou dat hier meetellen, dan verscheen "Alles was al
    // in orde" nooit meer op een server die die kanalen niet gebruikt. De lijst wordt
    // begrensd, net als in commands/setup.js, zodat hij in een embedveld past.
    const ongekoppeld = new Set(Array.isArray(flow.ongekoppeld) ? flow.ongekoppeld : []);
    const teMelden = (Array.isArray(flow.waarschuwingen) ? flow.waarschuwingen : [])
      .filter((regel) => !ongekoppeld.has(regel));
    for (const regel of limitFlowWarnings(teMelden)) changes.push(regel);

    // De rollen kunnen net opnieuw aangemaakt zijn en staan dan onderaan de rollenlijst;
    // hier komt het blokje van deze gang weer op zijn plek.
    const volgorde = await orderRolesQuietly(guild, `het herstellen van ${current.name}`);
    if (volgorde.ok && volgorde.verplaatst > 0) {
      changes.push(
        `Rolvolgorde rechtgezet (${volgorde.verplaatst} rol(len) verplaatst): per gang staan`
        + ' Boss, Underboss en de gangrol weer als blok onder elkaar.',
      );
    } else if (!volgorde.ok && volgorde.error) {
      changes.push(`Let op: ${volgorde.error}`);
    }

    if (!changes.length) changes.push('Alles was al in orde; er hoefde niets hersteld te worden.');
    logger.info(`Gang ${current.name} (#${gang.id}) hersteld door ${actorId || 'onbekend'}.`);
    return { ok: true, changes, gang: target };
  } catch (err) {
    logger.error(`gangService: herstellen van gang ${gang.name} mislukt.`, err);
    return {
      ok: false,
      changes,
      error: `Het herstellen is halverwege gestopt (${err?.message || 'onbekende fout'}).`
        + ` ${permissionHint(err, guild)}`,
    };
  }
}

/**
 * Geeft de gangrol toegang tot alle gedeelde (server-brede) categorieen uit de
 * serverconfiguratie. Bestaande overwrites worden bijgewerkt, niet gedupliceerd.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} gang Het GangRecord (of een concept met minimaal `roleId` en `name`).
 * @returns {Promise<{ok: boolean, added: number, error?: string|null}>} Aantal bijgewerkte
 *   categorieen; `ok: false` zodra Discord een overwrite geweigerd heeft.
 */
async function syncSharedCategories(guild, gang) {
  if (!guild || !guild.id || !gang) {
    return {
      ok: false,
      added: 0,
      error: 'Interne fout: gang of server ontbreekt bij syncSharedCategories.',
    };
  }
  if (typeof gang.roleId !== 'string' || !gang.roleId) {
    return {
      ok: false,
      added: 0,
      error: `De gangrol van ${gang.name || 'deze gang'} ontbreekt. Voer eerst /gangbeheer herstel uit.`,
    };
  }

  const guildConfig = store.getGuildConfig(guild.id);
  const categoryIds = Array.isArray(guildConfig.sharedCategoryIds) ? guildConfig.sharedCategoryIds : [];
  if (!categoryIds.length) return { ok: true, added: 0, error: null };

  const reason = auditReason(`Gedeelde categorie opengezet voor gang ${gang.name || gang.slug || gang.roleId}`);
  // Ook hier alleen rechten die de bot zelf heeft: anders weigert Discord de hele overwrite
  // met 50013 en krijgt de gang geen toegang tot de gedeelde categorie.
  const botPerms = botGuildPermissions(guild);

  const entries = [normalizeEntry({
    id: gang.roleId,
    type: OverwriteType.Role,
    allow: allowedBits(botPerms, CATEGORY_PERMS.shared),
    deny: allowedBits(botPerms, CATEGORY_PERMS.sharedDeny),
  })];

  // De staffrol voert hier als enige het woord. Hij stond er tot nu toe helemaal niet in:
  // de bot zette alleen de gangrol neer, dus staff was afhankelijk van een regel die iemand
  // met de hand op de categorie gezet had.
  if (guildConfig.staffRoleId) {
    entries.push(normalizeEntry({
      id: guildConfig.staffRoleId,
      type: OverwriteType.Role,
      allow: allowedBits(botPerms, CATEGORY_PERMS.sharedStaff),
      deny: [],
    }));
  }

  let added = 0;
  let mislukt = 0;
  const missing = [];
  for (const categoryId of categoryIds) {
    const category = resolveChannel(guild, categoryId);
    if (!category || category.type !== ChannelType.GuildCategory) {
      missing.push(categoryId);
      continue;
    }
    const result = await applyOverwrites(category, entries, reason);
    added += result.updated;
    mislukt += result.mislukt;
  }

  const problemen = [];
  if (missing.length) {
    problemen.push(
      `${missing.length} gedeelde categorie(en) bestaan niet meer.`
      + ' Werk de lijst bij met /setup gedeelde-categorie.',
    );
  }
  if (mislukt) {
    problemen.push(
      `In ${mislukt} gedeelde categorie(en) weigerde Discord de toegang voor`
      + ` ${gang.name || 'deze gang'} te zetten, dus daar kan de gang nog niet bij.`
      + ` ${permissionHint(null, guild)}`,
    );
  }

  return {
    ok: mislukt === 0,
    added,
    error: problemen.length ? problemen.join(' ') : null,
  };
}

/**
 * (Her)zet alle overwrites van een gang: eerst de categorie, daarna elk van de zes kanalen
 * met hun eigen uitzonderingen. Idempotent: bestaande overwrites worden bijgewerkt en wat
 * al klopt wordt overgeslagen, dus deze functie mag zo vaak aangeroepen worden als nodig.
 *
 * Naast toevoegen wordt hier ook opgeruimd (pruneRoleOverwrites): rol-overwrites die niet in
 * het gangmodel horen gaan eraf, want `edit` alleen kan te ruime rechten nooit dichtzetten.
 * Member-overwrites en beheerde (bot-)rollen blijven met rust - zie pruneRoleOverwrites.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} gang Het GangRecord.
 * @returns {Promise<{ok: boolean, updated: number, removed: string[], error?: string|null}>} Aantal
 *   gewijzigde overwrites en wat er opgeruimd is. `ok` is false zodra Discord een overwrite
 *   geweigerd heeft: dan staan de kanalen niet zoals ze horen te staan.
 */
async function applyCategoryPermissions(guild, gang) {
  if (!guild || !guild.id || !gang) {
    return {
      ok: false,
      updated: 0,
      error: 'Interne fout: gang of server ontbreekt bij applyCategoryPermissions.',
    };
  }

  const category = resolveCategory(guild, gang);
  if (!category) {
    return {
      ok: false,
      updated: 0,
      error: `De categorie van ${gang.name || 'deze gang'} bestaat niet meer. Voer /gangbeheer herstel uit.`,
    };
  }

  const guildConfig = store.getGuildConfig(guild.id);
  const reason = auditReason(`Permissies van gang ${gang.name || gang.slug} opnieuw ingesteld`);
  let updated = 0;
  let mislukt = 0;
  const removed = [];

  // Eerst zetten, dan pas opruimen: zo staat de gewenste stand er al voordat we de rest
  // weghalen, en gooien we nooit een overwrite weg die we net zelf gezet hebben.
  const categoryEntries = buildCategoryOverwrites(guild, gang, guildConfig);
  const categoryResult = await applyOverwrites(category, categoryEntries, reason);
  updated += categoryResult.updated;
  mislukt += categoryResult.mislukt;
  updated += await pruneRoleOverwrites(guild, category, categoryEntries, reason, removed);

  const missing = [];
  for (const item of CHANNEL_BLUEPRINT) {
    const channel = resolveChannel(guild, gang.channels?.[item.kind]);
    if (!channel) {
      missing.push(item.kind);
      continue;
    }
    const channelEntries = buildChannelOverwrites(guild, gang, item.kind, guildConfig);
    const channelResult = await applyOverwrites(channel, channelEntries, reason);
    updated += channelResult.updated;
    mislukt += channelResult.mislukt;
    updated += await pruneRoleOverwrites(guild, channel, channelEntries, reason, removed);
  }

  const problemen = [];
  if (missing.length) {
    problemen.push(`Deze kanalen ontbreken en zijn overgeslagen: ${missing.join(', ')}. Voer /gangbeheer herstel uit.`);
  }
  // Een geweigerde overwrite is geen detail: dan kan een kanaal openstaan of juist dicht
  // blijven voor wie er wel in hoort. Dat moet terug naar de gebruiker, niet alleen het log in.
  if (mislukt) {
    problemen.push(
      `${mislukt} rechtenregel(s) konden niet gezet worden, dus de kanalen van`
      + ` ${gang.name || 'deze gang'} staan niet zoals ze horen te staan. ${permissionHint(null, guild)}`,
    );
  }

  return {
    ok: mislukt === 0,
    updated,
    removed,
    error: problemen.length ? problemen.join(' ') : null,
  };
}

// ---------------------------------------------------------------------------
// De flow-kanalen: #aangenomen en #ontslagen
// ---------------------------------------------------------------------------

/**
 * De twee server-brede kanalen waar aannames en ontslagen gemeld worden.
 * `key` is het veld in de serverconfiguratie, `optie` de optienaam van /setup kanalen.
 * @type {ReadonlyArray<{key: string, label: string, optie: string}>}
 */
const FLOW_CHANNELS = Object.freeze([
  Object.freeze({ key: 'hireChannelId', label: 'aangenomen', optie: 'aangenomen' }),
  Object.freeze({ key: 'fireChannelId', label: 'ontslagen', optie: 'ontslagen' }),
]);

/** Elk permissiebit dat in FLOW_PERMS of LEADER_PERMS uitgedeeld of geweigerd wordt. */
const ALL_FLOW_BITS = [...new Set(
  [...Object.values(FLOW_PERMS), ...Object.values(LEADER_PERMS)]
    .flatMap((bits) => (Array.isArray(bits) ? [...bits] : [])),
)];

/**
 * Maximaal aantal registerwaarschuwingen dat de bot in een antwoord zet, plus het
 * tekenbudget daarvoor. Dezelfde grenzen als in commands/setup.js: een embedveld van
 * Discord kapt af op 1024 tekens en deze meldingen zijn lang.
 */
const MAX_FLOW_WARNINGS = 3;
const FLOW_WARNING_BUDGET = 780;

/**
 * Kort een lijst meldingen in zodat hij zeker in een embedveld past. Wat niet getoond
 * wordt, wordt geteld in een slotregel; de volledige tekst staat in het logboek.
 *
 * @param {string[]} regels De meldingen.
 * @returns {string[]} De te tonen regels, eventueel met een slotregel over de rest.
 */
function limitFlowWarnings(regels) {
  const veilig = (Array.isArray(regels) ? regels : []).filter(Boolean).map(String);
  const gekozen = [];
  let lengte = 0;

  for (const regel of veilig) {
    if (gekozen.length >= MAX_FLOW_WARNINGS) break;
    if (lengte + regel.length > FLOW_WARNING_BUDGET) break;
    gekozen.push(regel);
    lengte += regel.length + 1;
  }

  // Past zelfs de eerste melding niet, toon hem dan ingekort in plaats van helemaal niets.
  if (!gekozen.length && veilig.length) {
    gekozen.push(`${veilig[0].slice(0, FLOW_WARNING_BUDGET)}…`);
  }

  const rest = veilig.length - gekozen.length;
  if (rest > 0) gekozen.push(`… en nog ${rest} melding(en); die staan in de botlogs.`);
  return gekozen;
}

/**
 * Bouwt de gewenste overwrites voor een flow-kanaal: @everyone dicht, en een allow voor
 * iedereen die er wel in mag posten (boss en underboss van elke gang, staff, de
 * server-brede extrarollen en de bot zelf).
 *
 * Elk id komt hoogstens een keer voor: `permissionOverwrites.edit` doet een merge, dus een
 * tweede entry op hetzelfde id zou de eerste stilletjes verruimen. Een rol die zowel
 * gangleiding als extrarol is krijgt daarom een samengevoegde entry.
 *
 * Rol-id's die niet meer bij een bestaande rol horen vallen af: Discord weigert een
 * overwrite voor een onbekend id en laat dan de hele call mislukken.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {{staffRoleId?: string|null, globalRoleIds?: string[]}} guildConfig Serverconfiguratie.
 * @returns {Array<{id: string, type: number, allow: Array<bigint>, deny: Array<bigint>}>} De overwrites.
 */
function buildFlowChannelOverwrites(guild, guildConfig) {
  // Zelfde reden als in buildCategoryOverwrites: Discord weigert de HELE call met 50013
  // zodra je een recht uitdeelt of weigert dat de bot zelf niet heeft. FLOW_PERMS deelt
  // onder andere ManageMessages uit, en dat erft de bot nooit via @everyone.
  const botPerms = botGuildPermissions(guild);
  const controleerbaar = rolesCacheUsable(guild);
  const map = new Map();

  const push = (id, type, allow, deny) => {
    if (typeof id !== 'string' || !id) return;
    if (type === OverwriteType.Role && controleerbaar && id !== guild?.roles?.everyone?.id
      && !resolveRole(guild, id)) return;
    const entry = map.get(id) || { id, type, allow: [], deny: [] };
    entry.allow.push(...allowedBits(botPerms, allow));
    entry.deny.push(...allowedBits(botPerms, deny));
    map.set(id, entry);
  };

  // Eerst de weigering voor iedereen; de allows hieronder winnen daarvan op rolniveau.
  push(guild?.roles?.everyone?.id, OverwriteType.Role, [], [...FLOW_PERMS.everyoneDeny]);

  let gangs = [];
  try {
    gangs = store.listGangs(guild.id) || [];
  } catch (err) {
    logger.warn(`gangService: gangs ophalen voor de flow-kanalen mislukt (${err.message}).`);
    gangs = [];
  }
  for (const gang of gangs) {
    // De gangrol eerst: iedereen in de gang mag het register zien en teruglezen. Daarna de
    // leiding, die op hetzelfde kanaal ook mag typen. Staat iemand in beide (een boss heeft
    // ook de gangrol), dan tellen de allows gewoon bij elkaar op.
    push(gang?.roleId, OverwriteType.Role, [...FLOW_PERMS.gangAllow], []);
    for (const roleId of [gang?.bossRoleId, gang?.underbossRoleId]) {
      push(roleId, OverwriteType.Role, [...FLOW_PERMS.leaderAllow], []);
    }
  }

  push(guildConfig?.staffRoleId, OverwriteType.Role, [...FLOW_PERMS.staffAllow], []);

  // collectGlobalRoleIds zonder gang: hier is geen enkele gang "de eigenaar" van het kanaal,
  // dus alleen @everyone en de staffrol vallen af (die hebben hun eigen entry hierboven).
  for (const roleId of collectGlobalRoleIds(guild, null, guildConfig)) {
    push(roleId, OverwriteType.Role, [...FLOW_PERMS.leaderAllow], []);
  }

  // De bot zelf, als MEMBER-overwrite. Zonder deze regel treft de @everyone-deny ook de bot
  // en kan hij niet meer antwoorden of reageren in het register.
  push(botMemberId(guild), OverwriteType.Member, [...FLOW_PERMS.botAllow], []);

  return [...map.values()].map(normalizeEntry);
}

/**
 * Bouwt de gewenste overwrites voor een leidingkanaal: @everyone helemaal dicht (ook
 * kijken), en alleen boss en underboss van elke gang, de staffrol, de server-brede
 * extrarollen en de bot zelf erin - die mogen er allemaal ook typen.
 *
 * Verschil met buildFlowChannelOverwrites: de gangrol komt hier NIET in voor. Een gewoon
 * gangslid ziet een leidingkanaal dus niet staan.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {{staffRoleId?: string|null, globalRoleIds?: string[]}} guildConfig Serverconfiguratie.
 * @returns {Array<{id: string, type: number, allow: Array<bigint>, deny: Array<bigint>}>} De overwrites.
 */
function buildLeaderChannelOverwrites(guild, guildConfig) {
  const botPerms = botGuildPermissions(guild);
  const controleerbaar = rolesCacheUsable(guild);
  const map = new Map();

  const push = (id, type, allow, deny) => {
    if (typeof id !== 'string' || !id) return;
    if (type === OverwriteType.Role && controleerbaar && id !== guild?.roles?.everyone?.id
      && !resolveRole(guild, id)) return;
    const entry = map.get(id) || { id, type, allow: [], deny: [] };
    entry.allow.push(...allowedBits(botPerms, allow));
    entry.deny.push(...allowedBits(botPerms, deny));
    map.set(id, entry);
  };

  push(guild?.roles?.everyone?.id, OverwriteType.Role, [], [...LEADER_PERMS.everyoneDeny]);

  let gangs = [];
  try {
    gangs = store.listGangs(guild.id) || [];
  } catch (err) {
    logger.warn(`gangService: gangs ophalen voor de leidingkanalen mislukt (${err.message}).`);
    gangs = [];
  }
  for (const gang of gangs) {
    for (const roleId of [gang?.bossRoleId, gang?.underbossRoleId]) {
      push(roleId, OverwriteType.Role, [...LEADER_PERMS.leaderAllow], []);
    }
  }

  push(guildConfig?.staffRoleId, OverwriteType.Role, [...LEADER_PERMS.staffAllow], []);

  for (const roleId of collectGlobalRoleIds(guild, null, guildConfig)) {
    push(roleId, OverwriteType.Role, [...LEADER_PERMS.leaderAllow], []);
  }

  push(botMemberId(guild), OverwriteType.Member, [...LEADER_PERMS.botAllow], []);

  return [...map.values()].map(normalizeEntry);
}

/**
 * Zoekt rollen die op een flow-kanaal een EIGEN allow op "Berichten versturen" hebben
 * terwijl ze geen gangleiding, staff of extrarol zijn.
 *
 * WAAROM ALLEEN MELDEN EN NIET OPRUIMEN: #aangenomen en #ontslagen zijn algemene
 * serverkanalen die de beheerder zelf heeft ingericht. Daar kunnen bewuste overwrites op
 * staan voor rollen die niets met gangs te maken hebben (een moderatorrol, een botrol).
 * Die weghalen zou echte toegang stukmaken. Maar zo'n rol kan wel gewoon in het register
 * typen, en dat moet de beheerder weten.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {import('discord.js').GuildChannel} channel Het flow-kanaal.
 * @param {Array<{id: string}>} entries De gewenste eindstand uit buildFlowChannelOverwrites.
 * @param {string} kanaalNaam Leesbare kanaalnaam voor in de melding.
 * @returns {string[]} Nederlandse meldingen, een per rol (leeg als er niets vreemds staat).
 */
function flowStrangerWarnings(guild, channel, entries, kanaalNaam) {
  const regels = [];
  let cache = null;
  try {
    cache = channel?.permissionOverwrites?.cache;
  } catch {
    cache = null;
  }
  if (!cache || typeof cache.values !== 'function') return regels;

  const bekend = new Set((Array.isArray(entries) ? entries : []).map((entry) => entry?.id));
  const everyoneId = guild?.roles?.everyone?.id || null;
  const send = PermissionFlagsBits.SendMessages;

  for (const overwrite of [...cache.values()]) {
    if (!overwrite || overwrite.type !== OverwriteType.Role) continue;

    const id = overwrite.id;
    if (typeof id !== 'string' || !id || id === everyoneId || bekend.has(id)) continue;

    const bits = readOverwriteBits(channel, id);
    if (!bits || (bits.allow & send) !== send) continue;

    const role = resolveRole(guild, id);
    const naam = role ? `de rol ${role.name}` : `de verwijderde rol met id ${id}`;
    regels.push(
      `Let op: ${naam} heeft in ${kanaalNaam} een eigen recht "Berichten versturen" en kan daar`
      + ' dus alsnog in typen, terwijl het geen gangleiding, staffrol of extrarol is. Die'
      + ' instelling is bewust blijven staan. Hoort de rol er niet in thuis, haal het recht dan'
      + ` weg via Kanaalinstellingen > Rechten van ${kanaalNaam}; hoort hij er wel bij, voeg hem`
      + ' dan toe met /setup extrarollen zodat de bot hem voortaan zelf beheert.',
    );
  }

  return regels;
}

/**
 * Verwijdert gericht de overwrites van een aantal bekende rol-id's uit beide flow-kanalen.
 * Alleen bedoeld voor rol-id's die de bot ZELF heeft aangemaakt (de boss- en underbossrol
 * van een verwijderde gang); alle andere overwrites blijven met rust.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {Array<string|null|undefined>} roleIds De op te ruimen rol-id's.
 * @param {string} reason Auditlog-reden.
 * @returns {Promise<number>} Aantal verwijderde overwrites.
 */
async function removeFlowOverwrites(guild, roleIds, reason) {
  const ids = [...new Set((Array.isArray(roleIds) ? roleIds : [])
    .filter((id) => typeof id === 'string' && id))];
  if (!ids.length || !guild?.id) return 0;

  let guildConfig = null;
  try {
    guildConfig = store.getGuildConfig(guild.id);
  } catch {
    guildConfig = null;
  }
  if (!guildConfig) return 0;

  let removed = 0;
  for (const item of FLOW_CHANNELS) {
    const channel = resolveChannel(guild, guildConfig[item.key]);
    if (!channel) continue;
    for (const id of ids) {
      // Staat er niets, dan hoeven we Discord niet lastig te vallen.
      if (!readOverwriteBits(channel, id)) continue;
      try {
        await channel.permissionOverwrites.delete(id, reason);
        removed += 1;
      } catch (err) {
        logger.warn(`gangService: overwrite ${id} opruimen op flow-kanaal ${channel?.id} mislukt (${err.message}).`);
      }
    }
  }
  return removed;
}

/**
 * Zet de schrijfrechten van #aangenomen, #ontslagen en de leidingkanalen goed: iedereen mag
 * ze zien en teruglezen, maar alleen boss en underboss van een gang, staff, de server-brede
 * extrarollen en de bot zelf mogen er iets in posten.
 *
 * Leidingkanalen (/setup leidingkanaal) krijgen exact dezelfde overwrites als de twee
 * registers. Het verschil zit alleen in wat de bot met de berichten doet: in een register
 * leest hij aannames en ontslagen mee, in een leidingkanaal niet - daar regelt hij alleen
 * wie er mag typen.
 *
 * WAAROM DIT NODIG IS: de bot weigerde een fout bericht pas ACHTERAF, waardoor het bericht
 * al in het register stond en daar bleef staan zodra het opruimen misging (bot offline,
 * rate limit, geen ManageMessages). Met deze overwrites houdt Discord het bericht al tegen
 * bij het verzenden.
 *
 * Terughoudend met opruimen: dit zijn algemene serverkanalen die de beheerder zelf heeft
 * ingericht, dus bestaande overwrites van vreemde rollen blijven staan. Ze worden wel
 * gemeld via `waarschuwingen` (zie flowStrangerWarnings).
 *
 * Idempotent en veilig om zo vaak aan te roepen als nodig; gooit nooit.
 *
 * `ok` is alleen true als het vergrendelen ECHT gelukt is. Weigert Discord ook maar een
 * overwrite, dan kan iedereen daar nog typen en hoort de beheerder dat te horen in plaats
 * van een groen vinkje te zien.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @returns {Promise<{ok: boolean, updated: number, kanalen: string[], waarschuwingen: string[], ongekoppeld: string[], error: string|null}>}
 *   Wat er gezet is, in welke kanalen, en waar de beheerder naar moet kijken. `ongekoppeld`
 *   bevat de waarschuwingen die alleen zeggen dat een registerkanaal nog niet ingesteld is;
 *   dat is geen mankement, dus /gangbeheer herstel laat die regels weg.
 */
async function applyFlowChannelPermissions(guild) {
  if (!guild || !guild.id) {
    return {
      ok: false,
      updated: 0,
      kanalen: [],
      waarschuwingen: [],
      ongekoppeld: [],
      error: 'Interne fout: de server ontbreekt bij applyFlowChannelPermissions.',
    };
  }

  let guildConfig = null;
  try {
    guildConfig = store.getGuildConfig(guild.id);
  } catch (err) {
    logger.warn(`gangService: serverinstellingen lezen mislukt (${err.message}).`);
    guildConfig = null;
  }
  if (!guildConfig) {
    return {
      ok: false,
      updated: 0,
      kanalen: [],
      waarschuwingen: [],
      ongekoppeld: [],
      error: 'De serverinstellingen konden niet gelezen worden, dus de schrijfrechten van'
        + ' #aangenomen en #ontslagen zijn niet aangepast. Controleer data/owc.json en voer'
        + ' /setup toon uit.',
    };
  }

  const reason = auditReason(
    'Schrijfrechten van de aangenomen- en ontslagen-kanalen bijgewerkt: alleen gangleiding,'
    + ' staff en de bot mogen daar posten',
  );
  const registerEntries = buildFlowChannelOverwrites(guild, guildConfig);
  const leidingEntries = buildLeaderChannelOverwrites(guild, guildConfig);
  const waarschuwingen = [];
  const ongekoppeld = [];
  const kanalen = [];
  const nietDicht = [];
  let updated = 0;
  let mislukt = 0;

  // Rechten die de bot zelf mist zijn uit de overwrites gefilterd (anders weigert Discord de
  // hele call met 50013). Stil laten gebeuren mag niet: dan denkt de beheerder dat het
  // kanaal dichtstaat terwijl er niets veranderd is.
  const botPerms = botGuildPermissions(guild);
  const gemist = ALL_FLOW_BITS.filter((bit) => !botHasBit(botPerms, bit)).map(permissionLabel);
  if (gemist.length) {
    waarschuwingen.push(
      `De bot mist zelf ${gemist.join(', ')}, dus die rechten zijn overgeslagen in de register- en`
      + ' leidingkanalen. Zet ze aan bij Serverinstellingen > Rollen > de rol van de bot en voer'
      + ' /gangbeheer herstel opnieuw uit, anders staat het kanaal niet echt dicht.',
    );
  }

  // De twee registers plus de leidingkanalen uit /setup leidingkanaal. Ze krijgen precies
  // dezelfde overwrites, dus ze lopen door dezelfde lus.
  const leidingkanalen = Array.isArray(guildConfig.leaderChannelIds) ? guildConfig.leaderChannelIds : [];
  const doelen = [
    ...FLOW_CHANNELS.map((item) => ({
      id: guildConfig[item.key],
      label: `${item.label}-kanaal`,
      hint: `/setup kanalen ${item.optie}: #kanaal`,
      entries: registerEntries,
      meldOngekoppeld: true,
    })),
    ...leidingkanalen.map((id) => ({
      id,
      label: 'leidingkanaal',
      hint: '/setup leidingkanaal kanaal:#kanaal',
      entries: leidingEntries,
      // Een leidingkanaal staat alleen in de lijst als het bewust gekoppeld is, dus
      // "nog niet ingesteld" bestaat hier niet en hoort ook niet in de checklist.
      meldOngekoppeld: false,
    })),
  ];

  for (const item of doelen) {
    const channelId = item.id;
    if (typeof channelId !== 'string' || !channelId) {
      if (!item.meldOngekoppeld) continue;
      const regel = `Er is nog geen ${item.label} ingesteld, dus daar is niets dichtgezet.`
        + ` Koppel het met ${item.hint}.`;
      waarschuwingen.push(regel);
      ongekoppeld.push(regel);
      continue;
    }

    const channel = resolveChannel(guild, channelId);
    if (!channel) {
      waarschuwingen.push(
        `Het ${item.label} (id ${channelId}) bestaat niet meer, dus daar is niets`
        + ` dichtgezet. Koppel het juiste kanaal met ${item.hint}.`,
      );
      continue;
    }

    const kanaalNaam = `#${channel.name || item.label}`;
    try {
      const result = await applyOverwrites(channel, item.entries, reason);
      updated += result.updated;
      if (result.mislukt) {
        // Deels gelukt is hier niet goed genoeg: één geweigerde regel kan het verschil zijn
        // tussen een dichtgezet register en een kanaal waar iedereen in kan typen. Daarom
        // komt dit kanaal NIET in `kanalen` te staan als "dichtgezet".
        mislukt += result.mislukt;
        nietDicht.push(kanaalNaam);
      } else {
        kanalen.push(kanaalNaam);
      }
    } catch (err) {
      logger.warn(`gangService: schrijfrechten zetten op ${kanaalNaam} mislukt (${err.message}).`);
      mislukt += 1;
      nietDicht.push(kanaalNaam);
      waarschuwingen.push(
        `De schrijfrechten van ${kanaalNaam} konden niet gezet worden (${err.message}). Geef de bot`
        + ' in Kanaalinstellingen > Rechten de rechten "Kanaal bekijken" en "Rollen beheren" en'
        + ' voer /gangbeheer herstel opnieuw uit.',
      );
      continue;
    }

    for (const regel of flowStrangerWarnings(guild, channel, item.entries, kanaalNaam)) {
      waarschuwingen.push(regel);
    }
  }

  // Eerlijk melden wat er misging: zonder dit zag de beheerder `ok: true` terwijl er in
  // werkelijkheid niets dichtgezet was.
  const error = mislukt
    ? `Het dichtzetten van ${nietDicht.join(' en ')} is niet gelukt: Discord weigerde`
      + ` ${mislukt} rechtenregel(s), dus daar kan op dit moment nog iedereen in typen.`
      + ` ${permissionHint(null, guild)} Geef de botrol ook in Kanaalinstellingen > Rechten van`
      + ' dat kanaal "Kanaal bekijken" en "Rollen beheren", en voer /gangbeheer herstel opnieuw uit.'
    : null;

  return {
    ok: mislukt === 0, updated, kanalen, waarschuwingen, ongekoppeld, error,
  };
}

/**
 * Voegt twee overwrite-lijsten samen tot een lijst waarin elk id een keer voorkomt, met de
 * allow- en deny-bits van beide. Gebruikt om een kanaal vrij te geven zonder te hoeven
 * weten of het als register- of als leidingkanaal dichtgezet was.
 *
 * @param {...Array<{id: string, type: number, allow: Array<bigint>, deny: Array<bigint>}>} lijsten De lijsten.
 * @returns {Array<{id: string, type: number, allow: Array<bigint>, deny: Array<bigint>}>} De samengevoegde lijst.
 */
function mergeOverwriteEntries(...lijsten) {
  const map = new Map();
  for (const lijst of lijsten) {
    for (const entry of (Array.isArray(lijst) ? lijst : [])) {
      if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
      const samen = map.get(entry.id) || { id: entry.id, type: entry.type, allow: [], deny: [] };
      samen.allow.push(...(entry.allow || []));
      samen.deny.push(...(entry.deny || []));
      map.set(entry.id, samen);
    }
  }
  return [...map.values()].map(normalizeEntry);
}

/**
 * Zet een overwrite-item om naar een optie-object dat elk gebruikt recht WIST (null =
 * niet ingesteld, dus terugvallen op de categorie en de serverrechten).
 *
 * @param {{allow: Array<bigint>, deny: Array<bigint>}} entry Schoon overwrite-item.
 * @returns {Record<string, null>} Bijvoorbeeld `{ ViewChannel: null, SendMessages: null }`.
 */
function toResetOptions(entry) {
  const options = {};
  for (const bit of [...(entry?.allow || []), ...(entry?.deny || [])]) {
    const name = FLAG_NAMES.get(bit);
    if (name) options[name] = null;
  }
  return options;
}

/**
 * Heft de vergrendeling van een registerkanaal weer op: alles wat de bot daar zelf gezet
 * heeft gaat eraf.
 *
 * WAAROM DIT ER MOET ZIJN: wijzigt staff het registerkanaal (van #aangenomen-oud naar
 * #aangenomen-nieuw), dan blijft het oude kanaal anders voor altijd dichtstaan. Niemand kan
 * daar nog typen en geen enkel commando zet dat terug, want applyFlowChannelPermissions kijkt
 * alleen naar het kanaal dat NU gekoppeld is. commands/setup.js roept deze functie aan
 * zodra er een ander kanaal gekoppeld wordt.
 *
 * Alleen de rechten die de bot zelf uitdeelt worden gewist. Zat er meer in een overwrite
 * (iets wat iemand bewust heeft ingesteld), dan blijft dat staan; is de overwrite daarna
 * helemaal leeg, dan gaat hij er in zijn geheel af. Idempotent: staat er niets van de bot,
 * dan gaat er geen enkele call uit. Gooit nooit.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {string} channelId Id van het kanaal dat geen register meer is.
 * @returns {Promise<{ok: boolean, verwijderd: number, kanaal: string|null, error: string|null}>}
 *   Hoeveel overwrites teruggedraaid zijn, of een Nederlandse uitleg waarom dat niet lukte.
 */
async function releaseFlowChannel(guild, channelId) {
  const id = typeof channelId === 'string' ? channelId.trim() : '';
  if (!guild || !guild.id || !id) {
    return {
      ok: false,
      verwijderd: 0,
      kanaal: null,
      error: 'Interne fout: server of kanaal ontbreekt bij releaseFlowChannel.',
    };
  }

  const channel = resolveChannel(guild, id);
  // Bestaat het kanaal niet meer, dan staat er ook niets meer dicht: niets te doen.
  if (!channel) return { ok: true, verwijderd: 0, kanaal: null, error: null };

  let guildConfig = null;
  try {
    guildConfig = store.getGuildConfig(guild.id);
  } catch (err) {
    logger.warn(`gangService: serverinstellingen lezen mislukt (${err.message}).`);
    guildConfig = null;
  }
  if (!guildConfig) {
    return {
      ok: false,
      verwijderd: 0,
      kanaal: `#${channel.name || id}`,
      error: 'De serverinstellingen konden niet gelezen worden, dus de vergrendeling van'
        + ` #${channel.name || id} is niet opgeheven. Haal in Kanaalinstellingen > Rechten de`
        + ' regel voor @everyone weg, of voer dit commando opnieuw uit.',
    };
  }

  // Dezelfde lijsten die het kanaal dichtgezet kunnen hebben: precies dat draaien we terug.
  // Register- en leidingkanalen lopen allebei langs deze functie, en welke van de twee het
  // was weten we hier niet meer, dus we nemen beide sets. Een bit dat er niet op stond
  // wissen is geen probleem: toResetOptions zet hem op null, oftewel "niet ingesteld".
  const entries = mergeOverwriteEntries(
    buildFlowChannelOverwrites(guild, guildConfig),
    buildLeaderChannelOverwrites(guild, guildConfig),
  );
  const kanaalNaam = `#${channel.name || id}`;
  const reason = auditReason(
    `Vergrendeling van ${kanaalNaam} opgeheven: dit kanaal is geen register- of leidingkanaal meer`,
  );

  let verwijderd = 0;
  let mislukt = 0;
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) continue;

    const bits = readOverwriteBits(channel, entry.id);
    if (!bits) continue;

    const botAllow = combineBits(entry.allow);
    const botDeny = combineBits(entry.deny);
    // Staat er niets van de bot in, dan blijft deze overwrite ongemoeid (idempotent).
    if ((bits.allow & botAllow) === 0n && (bits.deny & botDeny) === 0n) continue;

    const restAllow = bits.allow & ~botAllow;
    const restDeny = bits.deny & ~botDeny;

    try {
      if (restAllow === 0n && restDeny === 0n) {
        // Er blijft niets over: geen lege overwrite laten staan.
        await channel.permissionOverwrites.delete(entry.id, reason);
      } else {
        // Iemand heeft hier zelf iets bij gezet; alleen onze eigen bits wissen.
        await channel.permissionOverwrites.edit(
          entry.id,
          toResetOptions(entry),
          { type: entry.type, reason },
        );
      }
      verwijderd += 1;
    } catch (err) {
      mislukt += 1;
      logger.warn(
        `gangService: overwrite ${entry.id} terugdraaien op ${kanaalNaam} mislukt (${err?.message || err}).`,
      );
    }
  }

  if (verwijderd) {
    logger.info(`gangService: ${verwijderd} overwrite(s) van de bot teruggedraaid op ${kanaalNaam}.`);
  }

  return {
    ok: mislukt === 0,
    verwijderd,
    kanaal: kanaalNaam,
    error: mislukt
      ? `${mislukt} rechtenregel(s) van ${kanaalNaam} konden niet teruggedraaid worden, dus daar`
        + ` kan mogelijk nog steeds niemand typen. ${permissionHint(null, guild)} Haal de regel`
        + ` voor @everyone anders met de hand weg bij Kanaalinstellingen > Rechten van ${kanaalNaam}.`
      : null,
  };
}

module.exports = {
  createGang,
  deleteGang,
  renameGang,
  repairGang,
  syncSharedCategories,
  applyCategoryPermissions,
  // De schrijfrechten van #aangenomen en #ontslagen. Discord houdt een fout bericht daarmee
  // al tegen bij het verzenden, in plaats van dat de bot het achteraf weigert.
  applyFlowChannelPermissions,
  // Het spiegelbeeld daarvan: een kanaal dat geen register meer is weer vrijgeven, zodat er
  // na het koppelen van een ander kanaal geen dichtgezet kanaal achterblijft.
  releaseFlowChannel,
  // De rollenlijst van de server: per gang een blokje met Boss, Underboss en de gangrol
  // onder elkaar, gangs onderling op aanmaakvolgorde.
  applyRoleOrder,
};
