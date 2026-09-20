// src/lib/memberCache.js
// Houdt `guild.members.cache` compleet. Alles wat met ledenaantallen te maken heeft
// hangt daaraan: lib/capacity.js telt via `role.members`, en dat is niet meer dan een
// filter over die cache. Zit daar maar een deel van de server in, dan telt de bot te
// weinig leden (19 man in de gang, "9/22 leden" in de melding) en laat hij aannames
// door die in werkelijkheid over de limiet gaan.
//
// WAAROM DE CACHE ONVOLLEDIG RAAKT (en dit bestand dus moet bestaan):
//
//  1. Herverbinding met de gateway. Valt de verbinding weg en lukt RESUME niet, dan
//     stuurt Discord na de nieuwe IDENTIFY eerst READY (alle servers gemarkeerd als
//     `unavailable`) en daarna opnieuw GUILD_CREATE. discord.js voert dan
//     `Guild#_patch` uit, en daarin staat letterlijk:
//
//         if (data.members) {
//           this.members.cache.clear();
//           for (const guildUser of data.members) this.members._add(guildUser);
//         }
//
//     De volledige ledencache wordt dus weggegooid en gevuld met alleen de leden uit
//     dat ene frame - maximaal `large_threshold` (standaard 50), in de praktijk veel
//     minder. De bot draait daarna gewoon door met een te lage telling en niemand
//     merkt er iets van, want er komt geen foutmelding bij.
//
//  2. Een mislukte `members.fetch()` bij het opstarten. Op een server met een trage of
//     haperende verbinding (`Connect Timeout Error ... discord.com:443`) loopt die
//     aanroep in een time-out; ready.js logde dat alleen en ging door met een vrijwel
//     lege cache.
//
// In beide gevallen was `ready.js` de enige plek die de cache vulde, en die draait met
// `once: true` - dus precies een keer per proces. Vandaar deze module: hij bewaakt de
// cache op een plek en haalt de leden opnieuw op zodra `guild.members.cache.size` niet
// meer klopt met `guild.memberCount`.
//
// Deze module gooit nooit: hij logt en geeft een resultaatobject terug.

const logger = require('./logger');

/**
 * Hoe lang een server met rust gelaten wordt na een mislukte ophaalpoging. Zonder deze
 * pauze zou elk binnenkomend bericht een nieuwe fetch starten zolang Discord onbereikbaar
 * is, en dat maakt het alleen maar erger.
 */
const RETRY_COOLDOWN_MS = 30 * 1000;

/**
 * Minimale pauze tussen twee GESLAAGDE ophaalacties.
 *
 * Normaal is deze pauze niet te merken: na een geslaagde fetch is de cache compleet en
 * komt niemand hier nog langs. Hij is er voor het randgeval dat `guild.memberCount` en
 * `guild.members.cache.size` net niet op elkaar uitkomen - bijvoorbeeld doordat iemand
 * tijdens het ophalen de server verliet. Zonder deze pauze zou de cache dan bij elk
 * binnenkomend bericht "onvolledig" lijken en zou de bot de hele server telkens opnieuw
 * ophalen.
 */
const SUCCESS_COOLDOWN_MS = 60 * 1000;

/** Maximale wachttijd op een chunk van `members.fetch()` voordat de poging faalt. */
const FETCH_TIMEOUT_MS = 60 * 1000;

/** Wachttijd tussen twee pogingen binnen dezelfde aanroep. */
const RETRY_DELAY_MS = 2 * 1000;

/**
 * Lopende ophaalacties per server-id. Komen er tien events tegelijk binnen, dan wachten
 * die allemaal op dezelfde fetch in plaats van er tien te starten.
 * @type {Map<string, Promise<boolean>>}
 */
const inFlight = new Map();

/**
 * Tijdstip (ms) waarop een server op zijn vroegst weer opgehaald mag worden.
 * @type {Map<string, number>}
 */
const cooldownUntil = new Map();

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
 * Hoeveel leden de server volgens Discord heeft. Dit getal komt uit `member_count` in
 * GUILD_CREATE en wordt door discord.js bijgehouden bij elke join en elk vertrek.
 *
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @returns {number|null} Het aantal, of null als het onbekend is.
 */
function expectedMemberCount(guild) {
  const count = Number(guild?.memberCount);
  if (!Number.isFinite(count) || count < 0) return null;
  return count;
}

/**
 * Hoeveel leden er op dit moment in de cache staan.
 *
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @returns {number} Het aantal; 0 als er geen cache is.
 */
function cachedMemberCount(guild) {
  const size = Number(guild?.members?.cache?.size);
  return Number.isFinite(size) && size > 0 ? size : 0;
}

/**
 * Staat de hele server in de ledencache? Is `memberCount` onbekend, dan valt er niets
 * te vergelijken en gaan we uit van 'compleet' - beter dan bij elke aanroep opnieuw de
 * hele server ophalen.
 *
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @returns {boolean} true als de telling betrouwbaar is.
 */
function isCacheComplete(guild) {
  if (!guild || !guild.members) return false;
  const expected = expectedMemberCount(guild);
  if (expected === null) return true;
  return cachedMemberCount(guild) >= expected;
}

/**
 * Wacht een aantal milliseconden.
 *
 * @param {number} ms De wachttijd.
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * Haalt alle leden van een server op, met een beperkt aantal pogingen. Gooit nooit.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {number} attempts Aantal pogingen (minimaal 1).
 * @returns {Promise<boolean>} true als het ophalen lukte.
 */
async function fetchAll(guild, attempts) {
  let lastError = null;

  for (let poging = 1; poging <= attempts; poging += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- pogingen horen na elkaar.
      await guild.members.fetch({ time: FETCH_TIMEOUT_MS });
      cooldownUntil.set(guild.id, Date.now() + SUCCESS_COOLDOWN_MS);
      logger.debug(
        `memberCache: ledencache van ${describeGuild(guild)} gevuld `
          + `(${cachedMemberCount(guild)}/${expectedMemberCount(guild) ?? '?'} leden).`,
      );
      return true;
    } catch (err) {
      lastError = err;
      if (poging < attempts) {
        logger.debug(
          `memberCache: poging ${poging} om de leden van ${describeGuild(guild)} op te halen `
            + `mislukte (${err?.message || err}); nog een keer proberen.`,
        );
        // eslint-disable-next-line no-await-in-loop -- bewust even wachten tussen pogingen.
        await delay(RETRY_DELAY_MS);
      }
    }
  }

  cooldownUntil.set(guild.id, Date.now() + RETRY_COOLDOWN_MS);
  logger.warn(
    `memberCache: de leden van ${describeGuild(guild)} konden niet opgehaald worden `
      + `(${cachedMemberCount(guild)} van ${expectedMemberCount(guild) ?? '?'} staan in de cache). `
      + 'Zolang dat zo is tellen de gangs te weinig leden. Staat de "Server Members Intent" aan '
      + `(Developer Portal > Bot > Privileged Gateway Intents)? Melding: ${lastError?.message || lastError}`,
  );
  return false;
}

/**
 * Wacht hooguit `budgetMs` op een lopende ophaalactie. Duurt die langer, dan geven we
 * false terug ZONDER hem af te breken: hij loopt door en vult de cache alsnog, zodat de
 * volgende aanroep wel klopt.
 *
 * Dit is er voor de slash-commando's. Discord verwacht binnen drie seconden een eerste
 * antwoord; een trage `members.fetch()` mag dat nooit opeten.
 *
 * @param {Promise<boolean>} promise De lopende ophaalactie.
 * @param {number} budgetMs Maximale wachttijd.
 * @returns {Promise<boolean>} Het resultaat, of false bij het verstrijken van het budget.
 */
function withBudget(promise, budgetMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), budgetMs);
    if (typeof timer.unref === 'function') timer.unref();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(false); },
    );
  });
}

/**
 * Zorgt dat de ledencache van een server compleet is voordat er geteld wordt. Is de
 * cache al compleet, dan doet deze functie niets en kost hij niets; dat is het normale
 * geval. Alleen na een herverbinding of een mislukte start valt hij terug op
 * `guild.members.fetch()`.
 *
 * Gelijktijdige aanroepen voor dezelfde server delen een ophaalactie, en na elke poging
 * ligt die server even stil (RETRY_COOLDOWN_MS na een mislukking, SUCCESS_COOLDOWN_MS na
 * een geslaagde) zodat een onbereikbare Discord of een klein verschil tussen
 * `memberCount` en de cache geen stortvloed aan pogingen oplevert.
 *
 * Gooit nooit.
 *
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @param {{attempts?: number, ignoreCooldown?: boolean, budgetMs?: number}} [options]
 *   `attempts` = aantal pogingen (standaard 1; gebruik er meer bij het opstarten en na
 *   een herverbinding). `ignoreCooldown` = ook ophalen als deze server net aan de beurt
 *   is geweest; gebruik dit alleen als je zeker weet dat de cache vervuild is, zoals na
 *   een herverbinding. `budgetMs` = hooguit zo lang wachten; het ophalen loopt daarna
 *   gewoon door op de achtergrond.
 * @returns {Promise<{ok: boolean, fetched: boolean, size: number, expected: number|null}>}
 *   `ok` = de telling is nu betrouwbaar; `fetched` = er is daadwerkelijk opgehaald.
 */
async function ensureMemberCache(guild, options = {}) {
  const result = (ok, fetched) => ({
    ok,
    fetched,
    size: cachedMemberCount(guild),
    expected: expectedMemberCount(guild),
  });

  if (!guild || !guild.id || !guild.members) return result(false, false);
  // Een server die als niet-beschikbaar gemarkeerd staat, stuurt zo meteen zelf een
  // GUILD_CREATE; events/guildAvailable.js pakt hem dan op.
  if (guild.available === false) return result(false, false);
  if (isCacheComplete(guild)) return result(true, false);

  const opts = options && typeof options === 'object' ? options : {};
  const budget = Number.isFinite(opts.budgetMs) && opts.budgetMs > 0 ? opts.budgetMs : null;

  let promise = inFlight.get(guild.id);
  if (!promise) {
    const until = cooldownUntil.get(guild.id) || 0;
    if (opts.ignoreCooldown !== true && until > Date.now()) return result(false, false);
    cooldownUntil.delete(guild.id);

    const attempts = Number.isInteger(opts.attempts) && opts.attempts > 0 ? opts.attempts : 1;
    promise = fetchAll(guild, attempts);
    inFlight.set(guild.id, promise);
    // Bewust op de promise zelf en niet op het await hieronder: met een budget kan die
    // await eerder klaar zijn dan het ophalen, en dan moet de volgende aanroep op
    // DEZELFDE actie wachten in plaats van een tweede te starten.
    promise.then(
      () => { if (inFlight.get(guild.id) === promise) inFlight.delete(guild.id); },
      () => { if (inFlight.get(guild.id) === promise) inFlight.delete(guild.id); },
    );
  }

  const ok = budget ? await withBudget(promise, budget) : await promise;
  if (!ok && budget) {
    logger.debug(
      `memberCache: ${describeGuild(guild)} was binnen ${budget} ms nog niet compleet; `
        + 'het ophalen loopt door op de achtergrond.',
    );
  }
  return result(ok && isCacheComplete(guild), true);
}

module.exports = {
  ensureMemberCache,
  isCacheComplete,
  cachedMemberCount,
  expectedMemberCount,
};
