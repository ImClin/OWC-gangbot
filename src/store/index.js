const path = require('path');
const { JsonStore } = require('./jsonStore');
const logger = require('../lib/logger');
const config = require('../config');
const constants = require('../lib/constants');

/**
 * @typedef {object} GuildConfig
 * @property {string|null} staffRoleId
 * @property {string|null} roleFloorId Gangrollen blijven altijd boven deze rol staan.
 * @property {string[]} leaderChannelIds Kanalen die net als #aangenomen en #ontslagen op slot
 *   gaan: iedereen leest mee, alleen de leiding van elke gang mag er typen.
 * @property {string|null} hireChannelId
 * @property {string|null} fireChannelId
 * @property {string|null} logChannelId
 * @property {string[]} sharedCategoryIds
 * @property {string[]} globalRoleIds Rollen die in elke gangcategorie mogen (OWC, wapendealers).
 * @property {string|null} dashboardChannelId
 * @property {string|null} dashboardMessageId
 * @property {number} defaultMemberLimit
 * @property {number} defaultBossLimit
 * @property {number} defaultUnderbossLimit
 */

/**
 * @typedef {object} GangRecord
 * @property {number} id
 * @property {string} name
 * @property {string} slug
 * @property {string} emoji
 * @property {string|null} categoryId
 * @property {string|null} roleId
 * @property {string|null} bossRoleId
 * @property {string|null} underbossRoleId
 * @property {Record<string, string|null>} channels
 * @property {number} memberLimit
 * @property {number} bossLimit
 * @property {number} underbossLimit
 * @property {number} createdAt
 * @property {string|null} createdBy
 */

/**
 * @typedef {object} ActionRecord
 * @property {number} id
 * @property {string} type
 * @property {number|null} gangId
 * @property {string|null} gangName
 * @property {string|null} targetId
 * @property {string|null} targetTag
 * @property {string|null} actorId
 * @property {string|null} actorTag
 * @property {string|null} reason
 * @property {number} createdAt
 * @property {boolean} reverted
 * @property {string|null} revertedBy
 * @property {number|null} revertedAt
 * @property {string|null} logMessageId
 * @property {string|null} logChannelId
 */

// ---------------------------------------------------------------------------
// Hulpfuncties (bovenaan omdat de constanten hieronder ze al gebruiken)
// ---------------------------------------------------------------------------

/**
 * Controleert of een waarde een gewoon object is (dus geen array en niet null).
 *
 * @param {*} value Willekeurige waarde.
 * @returns {boolean} true als het een gewoon object is.
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * JSON-veilige diepe kopie, zodat aanroepers de in-memory cache niet per ongeluk muteren.
 *
 * @param {*} value De te kopieren waarde.
 * @returns {*} Een losstaande kopie, of null als kopieren mislukt.
 */
function clone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (err) {
    logger.warn(`store: kopieren van een record is mislukt (${err.message}).`);
    return null;
  }
}

/**
 * Zet een waarde om naar een geheel getal binnen optionele grenzen.
 *
 * @param {*} value Ruwe waarde.
 * @param {number|null} fallback Waarde bij ongeldige invoer.
 * @param {number} [min] Ondergrens (inclusief).
 * @param {number} [max] Bovengrens (inclusief).
 * @returns {number|null} Het getal, of de fallback.
 */
function toInt(value, fallback, min, max) {
  const source = value === null || value === undefined ? '' : value;
  const parsed = typeof source === 'number' ? source : Number.parseInt(String(source), 10);
  if (!Number.isFinite(parsed)) return fallback;
  let out = Math.trunc(parsed);
  if (typeof min === 'number' && out < min) out = min;
  if (typeof max === 'number' && out > max) out = max;
  return out;
}

/**
 * Controleert of een object een eigen sleutel heeft met een echte waarde. Wordt gebruikt om te
 * herkennen of een opgeslagen record nog uit de tijd van de meelopers komt.
 *
 * @param {object} target Het te onderzoeken object.
 * @param {string} key Sleutelnaam.
 * @returns {boolean} true als de sleutel bestaat en niet undefined is.
 */
function hasOwnValue(target, key) {
  return Object.prototype.hasOwnProperty.call(target, key) && target[key] !== undefined;
}

/**
 * Rekent de oude drieledige limiet (leden + meelopers, met een hard totaal eroverheen) om naar
 * de ene ledenlimiet van nu: precies het aantal personen dat er voor de wijziging in mocht.
 *
 * @param {number} leden Oude ledenlimiet.
 * @param {number} meelopers Oude meeloperlimiet.
 * @param {number} totaal Oud hard totaal.
 * @returns {number} De nieuwe ledenlimiet, minimaal 1.
 */
function mergedMemberLimit(leden, meelopers, totaal) {
  return Math.max(1, Math.min(totaal, leden + meelopers));
}

/**
 * Normaliseert een Discord-snowflake naar een getrimde string.
 *
 * @param {*} value Ruwe waarde (string of getal).
 * @returns {string|null} De id, of null als er geen bruikbare waarde is.
 */
function asId(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Normaliseert vrije tekst naar een getrimde string of null.
 *
 * @param {*} value Ruwe waarde.
 * @param {number} [max=400] Maximale lengte.
 * @returns {string|null} De tekst, of null.
 */
function asText(value, max = 400) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Maakt een lijst met unieke id-strings.
 *
 * @param {*} value Ruwe waarde (bij voorkeur een array).
 * @returns {string[]} Unieke ids, volgorde behouden.
 */
function uniqueIds(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const id = asId(item);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Vangnet-slug voor oude records zonder slug. De canonieke slugify staat in lib/parse.js;
 * die wordt hier bewust niet gebruikt om de store los te houden van andere modules.
 *
 * @param {string} name Gangnaam.
 * @returns {string} Slug van a-z0-9 en koppeltekens, max 60 tekens.
 */
function fallbackSlug(name) {
  if (typeof name !== 'string') return '';
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

/**
 * Haalt de snowflake uit een mention (rol, kanaal of gebruiker).
 *
 * @param {string} raw Ruwe invoer.
 * @returns {string|null} De id, of null als het geen mention is.
 */
function mentionToId(raw) {
  const match = /^<(?:@[&!]?|#)(\d{1,30})>$/.exec(String(raw).trim());
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Constanten (defensief: val terug op de spec-waarden als constants.js afwijkt)
// ---------------------------------------------------------------------------

const FALLBACK_CHANNEL_KINDS = ['mededeling', 'boss', 'chat', 'media', 'dark', 'oortje'];

const CHANNEL_KINDS = Array.isArray(constants.CHANNEL_BLUEPRINT) && constants.CHANNEL_BLUEPRINT.length
  ? constants.CHANNEL_BLUEPRINT
    .map((item) => (item && typeof item.kind === 'string' ? item.kind : null))
    .filter((kind) => typeof kind === 'string' && kind.length > 0)
  : FALLBACK_CHANNEL_KINDS;

const DEFAULT_MEMBER_LIMIT = toInt(constants.DEFAULT_MEMBER_LIMIT, 22, 1);
const DEFAULT_BOSS_LIMIT = toInt(constants.DEFAULT_BOSS_LIMIT, 2, 1);
const DEFAULT_UNDERBOSS_LIMIT = toInt(constants.DEFAULT_UNDERBOSS_LIMIT, 2, 0);
const MAX_ACTIONS_KEPT = toInt(constants.MAX_ACTIONS_KEPT, 5000, 1);

const DATA_DIR = typeof config.dataDir === 'string' && config.dataDir.trim()
  ? config.dataDir
  : path.join(__dirname, '..', '..', 'data');

const DATA_FILE = path.join(DATA_DIR, 'owc.json');

const store = new JsonStore(DATA_FILE, { guilds: {} });

// ---------------------------------------------------------------------------
// Normalisatie: vult ontbrekende velden aan, ook bij bestaande opgeslagen data
// ---------------------------------------------------------------------------

/**
 * Bouwt een verse serverconfiguratie met alle standaardwaarden.
 *
 * @returns {GuildConfig} Nieuwe configuratie.
 */
function defaultGuildConfig() {
  return {
    staffRoleId: null,
    roleFloorId: null,
    leaderChannelIds: [],
    hireChannelId: null,
    fireChannelId: null,
    logChannelId: null,
    sharedCategoryIds: [],
    globalRoleIds: [],
    dashboardChannelId: null,
    dashboardMessageId: null,
    defaultMemberLimit: DEFAULT_MEMBER_LIMIT,
    defaultBossLimit: DEFAULT_BOSS_LIMIT,
    defaultUnderbossLimit: DEFAULT_UNDERBOSS_LIMIT,
  };
}

/**
 * Zet de oude serverstandaard (defaultMemberLimit + defaultMeeloperLimit, afgetopt op
 * defaultTotalLimit) om naar de ene defaultMemberLimit en verwijdert de oude velden.
 * De aanwezigheid van die velden is het signaal: zijn ze weg, dan doet een tweede ronde niets
 * meer en blijft de uitkomst dus gelijk.
 *
 * @param {object} cfg Configuratie in bewerking; wordt ter plekke aangepast.
 * @returns {void}
 */
function migrateConfigLimits(cfg) {
  if (!hasOwnValue(cfg, 'defaultMeeloperLimit') && !hasOwnValue(cfg, 'defaultTotalLimit')) return;
  const oudLeden = cfg.defaultMemberLimit;
  const oudMeelopers = toInt(cfg.defaultMeeloperLimit, 0, 0);
  const oudTotaal = toInt(cfg.defaultTotalLimit, oudLeden + oudMeelopers, 1);
  cfg.defaultMemberLimit = mergedMemberLimit(oudLeden, oudMeelopers, oudTotaal);
  delete cfg.defaultMeeloperLimit;
  delete cfg.defaultTotalLimit;
  logger.info(
    'store: de serverstandaard is omgezet naar een enkele ledenlimiet. '
    + `${oudLeden} leden + ${oudMeelopers} meelopers met een hard totaal van ${oudTotaal} `
    + `wordt ${cfg.defaultMemberLimit} leden. Aanpassen kan met /setup limieten leden:<aantal>.`,
  );
}

/**
 * Zet de oude gangslimiet (memberLimit + meeloperLimit, afgetopt op totalLimit) om naar de ene
 * memberLimit en verwijdert de oude velden. Werkt net als migrateConfigLimits op de aanwezigheid
 * van die velden, dus een tweede leesronde verandert er niets meer aan.
 *
 * @param {object} gang Gangrecord in bewerking; wordt ter plekke aangepast.
 * @returns {void}
 */
function migrateGangLimits(gang) {
  if (!hasOwnValue(gang, 'meeloperLimit') && !hasOwnValue(gang, 'totalLimit')) return;
  const oudLeden = gang.memberLimit;
  const oudMeelopers = toInt(gang.meeloperLimit, 0, 0);
  const oudTotaal = toInt(gang.totalLimit, oudLeden + oudMeelopers, 1);
  gang.memberLimit = mergedMemberLimit(oudLeden, oudMeelopers, oudTotaal);
  delete gang.meeloperLimit;
  delete gang.totalLimit;
  logger.info(
    `store: gang "${gang.name || gang.id}" is omgezet naar een enkele ledenlimiet. `
    + `${oudLeden} leden + ${oudMeelopers} meelopers met een hard totaal van ${oudTotaal} `
    + `wordt ${gang.memberLimit} leden. Aanpassen kan met /gang limiet leden:<aantal>.`,
  );
}

/**
 * Normaliseert een (mogelijk verouderde) configuratie en vult ontbrekende velden aan.
 * Een configuratie van voor deze versie wordt hier meteen omgerekend naar de ene ledenlimiet.
 *
 * @param {*} raw Opgeslagen configuratie.
 * @returns {GuildConfig} Genormaliseerde configuratie.
 */
function normalizeConfig(raw) {
  const out = { ...defaultGuildConfig(), ...(isPlainObject(raw) ? raw : {}) };
  out.staffRoleId = asId(out.staffRoleId);
  out.roleFloorId = asId(out.roleFloorId);
  out.leaderChannelIds = uniqueIds(out.leaderChannelIds);
  out.hireChannelId = asId(out.hireChannelId);
  out.fireChannelId = asId(out.fireChannelId);
  out.logChannelId = asId(out.logChannelId);
  out.dashboardChannelId = asId(out.dashboardChannelId);
  out.dashboardMessageId = asId(out.dashboardMessageId);
  out.sharedCategoryIds = uniqueIds(out.sharedCategoryIds);
  out.globalRoleIds = uniqueIds(out.globalRoleIds);
  out.defaultMemberLimit = toInt(out.defaultMemberLimit, DEFAULT_MEMBER_LIMIT, 1);
  migrateConfigLimits(out);
  out.defaultBossLimit = toInt(out.defaultBossLimit, DEFAULT_BOSS_LIMIT, 1);
  out.defaultUnderbossLimit = toInt(out.defaultUnderbossLimit, DEFAULT_UNDERBOSS_LIMIT, 0);
  return out;
}

/**
 * Normaliseert het kanalen-object van een gang: elke blueprint-soort krijgt een id of null.
 *
 * @param {*} raw Opgeslagen kanalen-object.
 * @returns {Record<string, string|null>} Genormaliseerde kanalen.
 */
function normalizeChannels(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const out = {};
  for (const kind of CHANNEL_KINDS) out[kind] = asId(src[kind]);
  for (const key of Object.keys(src)) {
    if (!(key in out)) out[key] = asId(src[key]);
  }
  return out;
}

/**
 * Normaliseert een GangRecord. Oudere records krijgen hier automatisch de velden die later
 * zijn toegevoegd (onder andere channels en slug) en worden omgerekend naar de ene ledenlimiet.
 *
 * @param {*} raw Opgeslagen gang.
 * @param {GuildConfig} cfg Serverconfiguratie met de standaardlimieten.
 * @returns {GangRecord} Genormaliseerde gang.
 */
function normalizeGang(raw, cfg) {
  const src = isPlainObject(raw) ? raw : {};
  const out = { ...src };
  out.id = toInt(src.id, 0, 0);
  out.name = typeof src.name === 'string' ? src.name.trim() : '';
  out.slug = typeof src.slug === 'string' && src.slug.trim()
    ? src.slug.trim().toLowerCase()
    : fallbackSlug(out.name);
  out.emoji = typeof src.emoji === 'string' ? src.emoji.trim() : '';
  out.categoryId = asId(src.categoryId);
  out.roleId = asId(src.roleId);
  out.bossRoleId = asId(src.bossRoleId);
  out.underbossRoleId = asId(src.underbossRoleId);
  // meeloperRoleId is geen veld van een gang meer, maar blijft bij oude records staan zolang de
  // achtergebleven Discord-rol nog opgeruimd moet worden. /gang herstel en /gang verwijder ruimen
  // die rol op en zetten het veld daarna op null, waarna het hier definitief verdwijnt.
  const legacyMeeloperRoleId = asId(out.meeloperRoleId);
  if (legacyMeeloperRoleId) out.meeloperRoleId = legacyMeeloperRoleId;
  else delete out.meeloperRoleId;
  out.channels = normalizeChannels(src.channels);
  out.memberLimit = toInt(src.memberLimit, cfg.defaultMemberLimit, 1);
  migrateGangLimits(out);
  out.bossLimit = toInt(src.bossLimit, cfg.defaultBossLimit, 1);
  out.underbossLimit = toInt(src.underbossLimit, cfg.defaultUnderbossLimit, 0);
  out.createdAt = toInt(src.createdAt, Date.now(), 0);
  out.createdBy = asId(src.createdBy);
  return out;
}

/**
 * Normaliseert een ActionRecord en vult ontbrekende velden aan.
 *
 * @param {*} raw Opgeslagen actie.
 * @returns {ActionRecord} Genormaliseerde actie.
 */
function normalizeAction(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const out = { ...src };
  out.id = toInt(src.id, 0, 0);
  out.type = typeof src.type === 'string' && src.type.trim() ? src.type.trim() : 'manual';
  out.gangId = toInt(src.gangId, null, 0);
  out.gangName = asText(src.gangName, 100);
  out.targetId = asId(src.targetId);
  out.targetTag = asText(src.targetTag, 100);
  out.actorId = asId(src.actorId);
  out.actorTag = asText(src.actorTag, 100);
  out.reason = asText(src.reason, 400);
  out.createdAt = toInt(src.createdAt, Date.now(), 0);
  out.reverted = src.reverted === true;
  out.revertedBy = asId(src.revertedBy);
  out.revertedAt = toInt(src.revertedAt, null, 0);
  out.logMessageId = asId(src.logMessageId);
  out.logChannelId = asId(src.logChannelId);
  return out;
}

/**
 * Trimt de actielijst tot MAX_ACTIONS_KEPT; de oudste acties vallen af.
 *
 * @param {ActionRecord[]} actions De actielijst; wordt ter plekke ingekort.
 * @returns {ActionRecord[]} Dezelfde array, ingekort.
 */
function trimActions(actions) {
  if (actions.length <= MAX_ACTIONS_KEPT) return actions;
  actions.sort((a, b) => (a.createdAt - b.createdAt) || (a.id - b.id));
  actions.splice(0, actions.length - MAX_ACTIONS_KEPT);
  return actions;
}

/**
 * Zorgt dat ids uniek en oplopend zijn, ook bij records die zonder id zijn opgeslagen.
 *
 * @param {Array<{id: number}>} records Genormaliseerde records.
 * @param {*} storedNext De opgeslagen teller.
 * @returns {number} De volgende bruikbare id.
 */
function repairIds(records, storedNext) {
  let next = toInt(storedNext, 1, 1);
  const highest = records.reduce((max, item) => (item.id > max ? item.id : max), 0);
  if (next <= highest) next = highest + 1;
  for (const item of records) {
    if (!(item.id > 0)) {
      item.id = next;
      next += 1;
    }
  }
  return next;
}

/**
 * Normaliseert de volledige opslag van een server.
 *
 * @param {*} raw Opgeslagen serverblok (mag ontbreken).
 * @returns {{config: GuildConfig, gangs: GangRecord[], actions: ActionRecord[], nextGangId: number, nextActionId: number}}
 *   Genormaliseerd serverblok.
 */
function normalizeGuild(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const cfg = normalizeConfig(src.config);
  const gangs = (Array.isArray(src.gangs) ? src.gangs : []).map((gang) => normalizeGang(gang, cfg));
  const actions = (Array.isArray(src.actions) ? src.actions : []).map((action) => normalizeAction(action));
  const nextGangId = repairIds(gangs, src.nextGangId);
  const nextActionId = repairIds(actions, src.nextActionId);
  trimActions(actions);
  return { config: cfg, gangs, actions, nextGangId, nextActionId };
}

// ---------------------------------------------------------------------------
// Toegang tot de store
// ---------------------------------------------------------------------------

/**
 * Leest en normaliseert het serverblok. De normalisatie landt in de in-memory cache en
 * wordt bij de eerstvolgende schrijfactie mee bewaard.
 *
 * @param {string} guildId Discord server-id.
 * @returns {{config: GuildConfig, gangs: GangRecord[], actions: ActionRecord[], nextGangId: number, nextActionId: number}}
 *   Het serverblok (een leeg blok bij een ongeldige guildId).
 */
function readGuild(guildId) {
  const key = asId(guildId);
  if (!key) {
    logger.warn('store: aanroep zonder geldige guildId; leeg serverblok teruggegeven.');
    return normalizeGuild(null);
  }
  const data = store.read();
  if (!isPlainObject(data.guilds)) data.guilds = {};
  const guild = normalizeGuild(data.guilds[key]);
  data.guilds[key] = guild;
  return guild;
}

/**
 * Muteert het serverblok en schrijft het atomisch weg.
 *
 * @template T
 * @param {string} guildId Discord server-id.
 * @param {(guild: object) => T} mutator Krijgt het genormaliseerde serverblok mee.
 * @returns {T|null} De returnwaarde van de mutator, of null bij een ongeldige guildId.
 */
function mutateGuild(guildId, mutator) {
  const key = asId(guildId);
  if (!key) {
    logger.warn('store: schrijfactie zonder geldige guildId genegeerd.');
    return null;
  }
  let result = null;
  store.write((data) => {
    if (!isPlainObject(data.guilds)) data.guilds = {};
    const guild = normalizeGuild(data.guilds[key]);
    data.guilds[key] = guild;
    result = mutator(guild);
  });
  return result;
}

/**
 * Zoekt de index van een gang op id.
 *
 * @param {GangRecord[]} gangs Lijst met gangs.
 * @param {number|string} gangId Gang-id.
 * @returns {number} De index, of -1.
 */
function indexOfGang(gangs, gangId) {
  const id = toInt(gangId, null, 0);
  if (id === null) return -1;
  return gangs.findIndex((gang) => gang.id === id);
}

/**
 * Zoekt de index van een actie op id.
 *
 * @param {ActionRecord[]} actions Lijst met acties.
 * @param {number|string} actionId Actie-id.
 * @returns {number} De index, of -1.
 */
function indexOfAction(actions, actionId) {
  const id = toInt(actionId, null, 0);
  if (id === null) return -1;
  return actions.findIndex((action) => action.id === id);
}

// ---------------------------------------------------------------------------
// Publieke API
// ---------------------------------------------------------------------------

/**
 * Geeft de configuratie van een server, met alle standaardwaarden ingevuld.
 *
 * @param {string} guildId Discord server-id.
 * @returns {GuildConfig} De configuratie (een kopie).
 */
function getGuildConfig(guildId) {
  return clone(readGuild(guildId).config) || defaultGuildConfig();
}

/**
 * Werkt de serverconfiguratie bij met een patch: alleen de meegegeven velden wijzigen.
 *
 * @param {string} guildId Discord server-id.
 * @param {Partial<GuildConfig>} patch De te wijzigen velden.
 * @returns {GuildConfig} De nieuwe configuratie (een kopie).
 */
function setGuildConfig(guildId, patch) {
  const updated = mutateGuild(guildId, (guild) => {
    guild.config = normalizeConfig({ ...guild.config, ...(isPlainObject(patch) ? patch : {}) });
    return clone(guild.config);
  });
  return updated || defaultGuildConfig();
}

/**
 * Geeft alle gangs van een server in opslagvolgorde.
 *
 * @param {string} guildId Discord server-id.
 * @returns {GangRecord[]} De gangs (kopieen).
 */
function listGangs(guildId) {
  return clone(readGuild(guildId).gangs) || [];
}

/**
 * Zoekt een gang op id, slug, naam, rol-id of categorie-id (hoofdletterongevoelig).
 * Mentions zoals een rolmention of kanaalmention worden ook herkend.
 *
 * @param {string} guildId Discord server-id.
 * @param {number|string} needle Zoekterm.
 * @returns {GangRecord|null} De gang, of null.
 */
function findGang(guildId, needle) {
  const gangs = readGuild(guildId).gangs;
  const raw = needle === null || needle === undefined ? '' : String(needle).trim();
  if (!raw || !gangs.length) return null;
  const lower = raw.toLowerCase();
  // Een mention wordt uitgepakt tot de kale id; anders zoeken we op de tekst zelf.
  const id = mentionToId(raw) || raw;

  const exact = gangs.find((gang) => String(gang.id) === lower
    || (gang.slug && gang.slug.toLowerCase() === lower)
    || (gang.name && gang.name.toLowerCase() === lower)
    || (gang.roleId !== null && gang.roleId === id)
    || (gang.categoryId !== null && gang.categoryId === id));
  if (exact) return clone(exact);

  // Tweede ronde: een ingetypte naam mag ook de bijbehorende slug vinden.
  const slug = fallbackSlug(raw);
  const loose = slug ? gangs.find((gang) => gang.slug && gang.slug.toLowerCase() === slug) : null;
  return loose ? clone(loose) : null;
}

/**
 * Zoekt de gang waar een rol-id bij hoort: gangRole, bossRole of underbossRole.
 *
 * @param {string} guildId Discord server-id.
 * @param {string} roleId Discord rol-id.
 * @returns {GangRecord|null} De gang, of null.
 */
function getGangByRoleId(guildId, roleId) {
  const id = asId(roleId);
  if (!id) return null;
  const gang = readGuild(guildId).gangs.find((item) => item.roleId === id
    || item.bossRoleId === id
    || item.underbossRoleId === id);
  return gang ? clone(gang) : null;
}

/**
 * Voegt een gang toe; id en createdAt worden ingevuld als ze ontbreken.
 *
 * @param {string} guildId Discord server-id.
 * @param {Partial<GangRecord>} partialGangRecord De gangvelden.
 * @returns {GangRecord|null} De opgeslagen gang (een kopie), of null bij een ongeldige guildId.
 */
function addGang(guildId, partialGangRecord) {
  return mutateGuild(guildId, (guild) => {
    const src = isPlainObject(partialGangRecord) ? partialGangRecord : {};
    const id = guild.nextGangId;
    guild.nextGangId = id + 1;
    const record = normalizeGang({ ...src, id, createdAt: src.createdAt || Date.now() }, guild.config);
    guild.gangs.push(record);
    return clone(record);
  });
}

/**
 * Werkt een gang bij. Het veld channels wordt samengevoegd in plaats van vervangen.
 *
 * @param {string} guildId Discord server-id.
 * @param {number|string} gangId Gang-id.
 * @param {Partial<GangRecord>} patch De te wijzigen velden.
 * @returns {GangRecord|null} De bijgewerkte gang (een kopie), of null als die niet bestaat.
 */
function updateGang(guildId, gangId, patch) {
  return mutateGuild(guildId, (guild) => {
    const index = indexOfGang(guild.gangs, gangId);
    if (index === -1) return null;
    const current = guild.gangs[index];
    const src = isPlainObject(patch) ? patch : {};
    const merged = { ...current, ...src, id: current.id };
    if (isPlainObject(src.channels)) merged.channels = { ...current.channels, ...src.channels };
    const record = normalizeGang(merged, guild.config);
    guild.gangs[index] = record;
    return clone(record);
  });
}

/**
 * Verwijdert een gang uit de opslag. Rollen en kanalen in Discord blijven ongemoeid.
 *
 * @param {string} guildId Discord server-id.
 * @param {number|string} gangId Gang-id.
 * @returns {boolean} true als er een gang verwijderd is.
 */
function removeGang(guildId, gangId) {
  const removed = mutateGuild(guildId, (guild) => {
    const index = indexOfGang(guild.gangs, gangId);
    if (index === -1) return false;
    guild.gangs.splice(index, 1);
    return true;
  });
  return removed === true;
}

/**
 * Legt een actie vast; id, createdAt en reverted worden ingevuld.
 * Daarna wordt de lijst getrimd tot MAX_ACTIONS_KEPT, waarbij de oudste acties afvallen.
 *
 * @param {string} guildId Discord server-id.
 * @param {Partial<ActionRecord>} partialAction De actievelden.
 * @returns {ActionRecord|null} De opgeslagen actie (een kopie), of null bij een ongeldige guildId.
 */
function addAction(guildId, partialAction) {
  return mutateGuild(guildId, (guild) => {
    const src = isPlainObject(partialAction) ? partialAction : {};
    const id = guild.nextActionId;
    guild.nextActionId = id + 1;
    const record = normalizeAction({
      ...src,
      id,
      createdAt: src.createdAt || Date.now(),
      reverted: src.reverted === true,
    });
    guild.actions.push(record);
    trimActions(guild.actions);
    return clone(record);
  });
}

/**
 * Haalt een actie op.
 *
 * @param {string} guildId Discord server-id.
 * @param {number|string} actionId Actie-id.
 * @returns {ActionRecord|null} De actie (een kopie), of null.
 */
function getAction(guildId, actionId) {
  const actions = readGuild(guildId).actions;
  const index = indexOfAction(actions, actionId);
  return index === -1 ? null : clone(actions[index]);
}

/**
 * Werkt een actie bij, bijvoorbeeld om hem als teruggedraaid te markeren.
 *
 * @param {string} guildId Discord server-id.
 * @param {number|string} actionId Actie-id.
 * @param {Partial<ActionRecord>} patch De te wijzigen velden.
 * @returns {ActionRecord|null} De bijgewerkte actie (een kopie), of null als die niet bestaat.
 */
function updateAction(guildId, actionId, patch) {
  return mutateGuild(guildId, (guild) => {
    const index = indexOfAction(guild.actions, actionId);
    if (index === -1) return null;
    const current = guild.actions[index];
    const record = normalizeAction({ ...current, ...(isPlainObject(patch) ? patch : {}), id: current.id });
    guild.actions[index] = record;
    return clone(record);
  });
}

/**
 * Geeft acties terug, nieuwste eerst, optioneel gefilterd op gang, lid en aantal.
 *
 * @param {string} guildId Discord server-id.
 * @param {{gangId?: number|string, targetId?: string, limit?: number}} [options={}] Filters.
 * @returns {ActionRecord[]} De acties (kopieen), nieuwste eerst.
 */
function listActions(guildId, options = {}) {
  const opts = isPlainObject(options) ? options : {};
  let actions = readGuild(guildId).actions.slice();

  const gangId = toInt(opts.gangId, null, 0);
  if (gangId !== null) actions = actions.filter((action) => action.gangId === gangId);

  const targetId = asId(opts.targetId);
  if (targetId) actions = actions.filter((action) => action.targetId === targetId);

  actions.sort((a, b) => (b.createdAt - a.createdAt) || (b.id - a.id));

  const limit = toInt(opts.limit, null, 1);
  if (limit !== null) actions = actions.slice(0, limit);

  return clone(actions) || [];
}

module.exports = {
  getGuildConfig,
  setGuildConfig,
  listGangs,
  findGang,
  getGangByRoleId,
  addGang,
  updateGang,
  removeGang,
  addAction,
  getAction,
  updateAction,
  listActions,
};
