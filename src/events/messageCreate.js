// src/events/messageCreate.js
// Het hart van de bot: berichten in #aangenomen en #ontslagen omzetten in echte
// aannames en ontslagen.
//
// Volgorde (zie SPEC 3, messageCreate):
//  1. bots, DM's en systeemberichten negeren
//  2. serverconfiguratie lezen; alleen doorgaan in het aanname- of ontslagkanaal
//  3. bepalen of het om aannemen of ontslaan gaat
//  4. doelgebruikers uit het OPDRACHTDEEL halen (alles vóór '|' of 'reden:');
//     rolmentions worden weggefilterd en mentions in de reden zijn nooit doel
//  5. de gang bepalen (een rolmention wint altijd; daarna de eigen gang van de auteur,
//     en pas als die er niet is telt een genoemde gangnaam voor staff)
//  6. per doel sequentieel membershipService.hire / .fire aanroepen
//  7. reageren op het originele bericht: alles goed, deels of niets
//  8. één samenvatting posten met per doel een regel
//  9. elke geslaagde actie naar het logkanaal
// 10. waarschuwing in het logkanaal als de gang daarna vol zit
// 11. alles in try/catch; het dashboard wordt aan het eind bijgewerkt
//
// Alle businesslogica (rechten, limieten, rollen) zit in membershipService; hier
// gebeurt alleen het lezen van het bericht en het terugkoppelen naar de gebruiker.

const { Events } = require('discord.js');

const logger = require('../lib/logger');
const store = require('../store');
const membershipService = require('../services/membershipService');
const logService = require('../services/logService');
const dashboardService = require('../services/dashboardService');
const { countGang, formatCapacity } = require('../lib/capacity');
const {
  extractUserIds,
  extractRoleIds,
  extractReason,
  truncate,
} = require('../lib/parse');
const { isStaff, getLedGangs } = require('../lib/permissions');
const {
  successEmbed,
  warningEmbed,
  errorEmbed,
  infoEmbed,
} = require('../lib/embeds');

/** Hoe lang een hint over het juiste formaat blijft staan. */
const HINT_DELETE_MS = 15 * 1000;

/** Hoe lang een foutmelding over de gang/rechten blijft staan. */
const ERROR_DELETE_MS = 30 * 1000;

/** Hoe lang de samenvatting blijft staan als er niets gelukt is. */
const SUMMARY_DELETE_MS = 60 * 1000;

/** Maximaal aantal personen dat in één bericht verwerkt wordt (ratelimit-bescherming). */
const MAX_TARGETS = 20;

/** Nooit pingen vanuit de bot: mentions worden wel getoond, maar geven geen melding. */
const NO_PINGS = { parse: [], repliedUser: false };

/* -------------------------------------------------------------------------- */
/* Kleine helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Zet een reactie op een bericht; mislukken (geen rechten) mag nooit iets breken.
 *
 * @param {import('discord.js').Message} message Het bericht.
 * @param {string} emoji De emoji.
 * @returns {Promise<void>}
 */
async function react(message, emoji) {
  try {
    await message.react(emoji);
  } catch (err) {
    logger.debug(`Kon niet reageren met ${emoji}: ${err?.message || err}`);
  }
}

/**
 * Verwijdert een bericht na een aantal milliseconden. De timer krijgt `unref()`,
 * zodat Node netjes kan afsluiten.
 *
 * @param {import('discord.js').Message|null} sent Het geposte bericht.
 * @param {number} ms Wachttijd in milliseconden.
 * @returns {void}
 */
function scheduleDelete(sent, ms) {
  if (!sent || typeof sent.delete !== 'function') return;
  const timer = setTimeout(() => {
    Promise.resolve(sent.delete()).catch(() => {});
  }, ms);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

/**
 * Antwoordt op het bericht en ruimt dat antwoord daarna weer op.
 *
 * @param {import('discord.js').Message} message Het oorspronkelijke bericht.
 * @param {import('discord.js').EmbedBuilder} embed De embed.
 * @param {number} ms Levensduur van het antwoord in milliseconden.
 * @returns {Promise<import('discord.js').Message|null>} Het antwoord, of null.
 */
async function replyTemporary(message, embed, ms) {
  try {
    const sent = await message.reply({ embeds: [embed], allowedMentions: NO_PINGS });
    scheduleDelete(sent, ms);
    return sent;
  } catch (err) {
    logger.warn(`Kon geen antwoord posten in #${message.channel?.name || message.channelId}: ${err?.message || err}`);
    return null;
  }
}

/**
 * Knipt het redengedeelte van een bericht af, zodat mentions en gangnamen die alleen
 * in de reden staan ('@Sara | reden: overgelopen naar Rayuza') niet als doel of als
 * gekozen gang worden gelezen.
 *
 * @param {string} content De volledige berichtinhoud.
 * @returns {string} Het deel vóór '|' of 'reden:'; de hele tekst als die er niet zijn.
 */
function stripReason(content) {
  const text = typeof content === 'string' ? content : '';
  const markers = [text.indexOf('|'), text.search(/\breden\s*:/i)].filter((index) => index >= 0);
  if (!markers.length) return text;
  return text.slice(0, Math.min(...markers));
}

/**
 * Bepaalt of dit bericht überhaupt interessant is (stap 1).
 *
 * @param {import('discord.js').Message} message Het bericht.
 * @returns {boolean} true bij een gewoon gebruikersbericht in een server.
 */
function isRelevantMessage(message) {
  if (!message || !message.guild) return false;
  if (message.author?.bot || message.webhookId) return false;
  if (message.system) return false;
  return Boolean(message.channel);
}

/**
 * Haalt het serverprofiel van de auteur op (kan bij partials ontbreken).
 *
 * @param {import('discord.js').Message} message Het bericht.
 * @returns {Promise<import('discord.js').GuildMember|null>} Het lid, of null.
 */
async function resolveAuthor(message) {
  if (message.member?.roles?.cache) return message.member;
  try {
    return await message.guild.members.fetch(message.author.id);
  } catch (err) {
    logger.warn(`Kon het serverprofiel van ${message.author?.id} niet ophalen: ${err?.message || err}`);
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Stap 5: welke gang?                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Escapet een tekst zodat hij letterlijk (niet als patroon) in een RegExp kan.
 *
 * @param {string} str De tekst.
 * @returns {string} De ge-escapete tekst.
 */
function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Bouwt een regex die `needle` alleen als VOLLEDIG woord vindt.
 *
 * WAAROM: gangnamen werden hiervoor met een kale `includes()` gezocht, waardoor de
 * gang 'Ballas' ook matchte in 'voetballas' of 'ballast' en de bot iemand in de
 * verkeerde gang zette. Bewust lookarounds op \p{L}\p{N} in plaats van \b: namen
 * bevatten spaties, streepjes en accenten, en \b werkt daar niet betrouwbaar.
 * Niet terugzetten naar `includes()`.
 *
 * @param {string} needle De letterlijk te zoeken tekst.
 * @returns {RegExp} Globale, hoofdletterongevoelige unicode-regex.
 */
function wordRegExp(needle) {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, 'giu');
}

/**
 * Zoekt alle posities waarop `needle` als los woord in `haystack` staat.
 *
 * @param {string} haystack De te doorzoeken tekst.
 * @param {string} needle De gezochte naam of slug.
 * @returns {Array<number[]>} Per treffer [start, eind].
 */
function nameRanges(haystack, needle) {
  const re = wordRegExp(needle);
  const ranges = [];
  let match = re.exec(haystack);
  while (match !== null) {
    ranges.push([match.index, match.index + match[0].length]);
    // Vangnet tegen een lege match; die zou de lus anders laten hangen.
    if (match.index === re.lastIndex) re.lastIndex += 1;
    match = re.exec(haystack);
  }
  return ranges;
}

/**
 * Zoekt welke gang(s) in het bericht genoemd worden.
 *
 * Een rolmention van een van de drie gangrollen is het enige HARDE signaal en
 * wordt daarom eerst afgehandeld. Daarna volgt de naam/slug, maar alleen bij een
 * volledige woordmatch (zie wordRegExp). Overlappende treffers wijzen naar
 * dezelfde plek in de tekst ('Los Zetas' bevat 'Zetas'); daar wint de langste
 * naam. Blijven er meerdere losstaande treffers over, dan zijn er echt twee
 * gangs genoemd en kiest deze functie er bewust GEEN uit.
 *
 * Dat geldt ook voor rolmentions: staan de rollen van twee VERSCHILLENDE gangs in
 * hetzelfde bericht, dan is er geen keuze te maken. Stil de eerste pakken zette
 * iemand in de verkeerde gang zonder dat er ook maar één signaal was.
 * Meerdere rollen van dezelfde gang ('@Rayuza @Rayuza Boss') blijven ondubbelzinnig.
 *
 * @param {object[]} gangs Alle GangRecords van de server.
 * @param {string} content De berichtinhoud (het opdrachtdeel, zonder reden).
 * @returns {{source: 'role'|'name'|null, matches: object[]}} De bron van de treffers en
 *   alle genoemde gangs. Bij meer dan één treffer kiest deze functie er bewust geen;
 *   dat oordeel hoort in pickGang, dat ook de eigen gang van de auteur kent.
 */
function findMentionedGang(gangs, content) {
  const alle = Array.isArray(gangs) ? gangs.filter(Boolean) : [];

  const viaRol = [];
  for (const roleId of extractRoleIds(content)) {
    const match = alle.find((gang) => gang.roleId === roleId
      || gang.bossRoleId === roleId
      || gang.underbossRoleId === roleId);
    if (match && !viaRol.some((gang) => gang.id === match.id)) viaRol.push(match);
  }
  if (viaRol.length) return { source: 'role', matches: viaRol };

  const haystack = String(content || '');
  const hits = [];
  for (const gang of alle) {
    let range = null;
    let length = 0;
    for (const needle of [gang.name, gang.slug]) {
      const text = typeof needle === 'string' ? needle.trim() : '';
      if (text.length < 2 || text.length <= length) continue;
      const gevonden = nameRanges(haystack, text);
      if (gevonden.length) {
        range = gevonden[0];
        length = text.length;
      }
    }
    if (range) hits.push({ gang, range, length });
  }
  if (!hits.length) return { source: null, matches: [] };

  const kept = [];
  for (const hit of hits.slice().sort((a, b) => b.length - a.length)) {
    const overlapt = kept.some((k) => hit.range[0] < k.range[1] && k.range[0] < hit.range[1]);
    if (!overlapt) kept.push(hit);
  }
  return { source: 'name', matches: kept.map((k) => k.gang) };
}

/**
 * Foutembed als er meer dan één gang in het bericht genoemd wordt. Stilzwijgend de
 * langste naam (of de eerste rolmention) kiezen — het oude gedrag — zette mensen in
 * de verkeerde gang zonder enig signaal.
 *
 * @param {object[]} matches De genoemde gangs.
 * @param {string} verb 'aannemen' of 'ontslaan'.
 * @param {'role'|'name'} source Kwamen de treffers uit rolmentions of uit namen?
 * @returns {import('discord.js').EmbedBuilder} De foutembed.
 */
function ambiguousGangError(matches, verb, source) {
  const namen = matches.map((gang) => `**${gang.name}**`);
  const opsomming = namen.length > 1
    ? `${namen.slice(0, -1).join(', ')} en ${namen[namen.length - 1]}`
    : namen.join('');
  const oplossing = source === 'role'
    ? `Zet er maar één gangrol in, bijvoorbeeld: \`@${matches[0].name} @lid\`.`
    : `Noem er één, het liefst met de gangrol: \`@${matches[0].name} @lid\`. Staat de andere naam `
      + 'alleen in je toelichting? Zet die dan achter een `|`, dan lees ik hem niet als gangkeuze.';
  return errorEmbed(
    'Meerdere gangs genoemd',
    `Ik zie ${opsomming} in je bericht en weet niet bij welke je wilt ${verb}. ${oplossing}`,
  );
}

/**
 * Bepaalt op welke gang dit bericht slaat (stap 5).
 *
 * @param {{member: import('discord.js').GuildMember, staff: boolean, gangs: object[], content: string, isHire: boolean}} ctx Context.
 * @returns {{gang?: object, error?: import('discord.js').EmbedBuilder}} De gang of een foutembed.
 */
function pickGang(ctx) {
  const {
    member, staff, gangs, content, isHire,
  } = ctx;
  const verb = isHire ? 'aannemen' : 'ontslaan';
  const ledGangs = getLedGangs(member, gangs);
  const { source, matches } = findMentionedGang(gangs, content);

  // Een rolmention is het enige harde 'ik bedoel DEZE gang'-signaal. Daar mag nooit
  // stil op de eigen gang teruggevallen worden: dat is bewuste intentie van de auteur.
  if (source === 'role') {
    // Rollen van twee verschillende gangs: bewuste intentie, maar niet te rijmen.
    if (matches.length > 1) return { error: ambiguousGangError(matches, verb, 'role') };
    const mentioned = matches[0];
    if (staff || ledGangs.some((gang) => gang.id === mentioned.id)) return { gang: mentioned };
    return {
      error: errorEmbed(
        'Niet jouw gang',
        `Je bent geen boss of underboss van **${mentioned.name}**, dus je kunt daar niemand ${verb}. `
          + 'Vraag de leiding van die gang of staff om het te doen.',
      ),
    };
  }

  // Een gangNAAM in vrije tekst is een zwakker signaal: die staat net zo goed in een
  // toelichting ('komt van Ballas af'). De EIGEN gang gaat daarom altijd voor, ook bij
  // staff die zelf boss of underboss is. Zonder die regel stuurde één woord in de
  // toelichting een staffer-boss naar de gang van iemand anders, terwijl hij gewoon in
  // zijn eigen gang aan het werk was. Wil zo iemand echt een andere gang, dan zegt hij
  // dat met de rolmention hierboven — dat is het enige harde signaal.
  const eigen = matches.filter((gang) => ledGangs.some((led) => led.id === gang.id));
  if (eigen.length === 1) return { gang: eigen[0] };
  if (eigen.length > 1) return { error: ambiguousGangError(eigen, verb, 'name') };

  // Staff zonder eigen gang heeft niets om op terug te vallen; voor hen telt de genoemde
  // naam wél als keuze — maar dan hooguit één naam.
  if (staff && !ledGangs.length) {
    if (matches.length === 1) return { gang: matches[0] };
    if (matches.length > 1) return { error: ambiguousGangError(matches, verb, 'name') };
  }
  // Alleen een VREEMDE gangnaam genoemd: te zwak om een legitieme aanname te blokkeren
  // (SPEC 3 stap 5). Val door naar de gewone regels, zodat de boss van Rayuza met
  // '@Jan komt van Ballas af' gewoon bij zijn eigen gang aanneemt. In de samenvatting
  // staat de gekozen gang in de titel, dus de auteur ziet meteen waar het heen ging.
  if (ledGangs.length === 1) return { gang: ledGangs[0] };

  if (ledGangs.length > 1) {
    const keuzes = ledGangs.map((gang) => `• ${gang.emoji ? `${gang.emoji} ` : ''}**${gang.name}**`).join('\n');
    return {
      error: errorEmbed(
        'Welke gang bedoel je?',
        `Je bent leiding van meerdere gangs. Zet de gang erbij, bijvoorbeeld met een rolmention:\n`
          + `\`@${ledGangs[0].name} @lid\`\n\n${keuzes}`,
      ),
    };
  }

  if (staff) {
    return {
      error: errorEmbed(
        'Noem de gang erbij',
        `Je bent staff, maar ik weet niet bij welke gang je wilt ${verb}. Zet de gangrol of de `
          + 'gangnaam in het bericht, bijvoorbeeld `@Rayuza @lid`.',
      ),
    };
  }

  return {
    error: errorEmbed(
      'Geen rechten',
      `Alleen de boss of underboss van een gang mag hier ${verb}. `
        + 'Klopt dit niet? Vraag staff om je de juiste rol te geven.',
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Stap 6: de doelen verwerken                                                */
/* -------------------------------------------------------------------------- */

/**
 * Nette omschrijving van een geslaagde actie, inclusief de nieuwe bezetting.
 *
 * @param {{counts?: object}} result Resultaat van hire/fire.
 * @param {boolean} isHire true bij een aanname.
 * @returns {string} Bijvoorbeeld 'aangenomen (18/22 leden)'.
 */
function describeSuccess(result, isHire) {
  const counts = result?.counts || {};
  const members = `${counts.members ?? '?'}/${counts.memberLimit ?? '?'}`;
  return `${isHire ? 'aangenomen' : 'ontslagen'} (${members} leden)`;
}

/**
 * Verwerkt één doelgebruiker: lid ophalen en membershipService aanroepen.
 *
 * @param {{guild: import('discord.js').Guild, gang: object, actor: import('discord.js').GuildMember, isHire: boolean, reason: string|null}} ctx Context.
 * @param {string} userId Het gebruikers-id uit het bericht.
 * @returns {Promise<{ok: boolean, line: string, action?: object, counts?: object}>} Resultaat plus de regel voor de samenvatting.
 */
async function processTarget(ctx, userId) {
  const {
    guild, gang, actor, isHire, reason,
  } = ctx;

  let target = guild.members?.cache?.get(userId) || null;
  if (!target) {
    try {
      target = await guild.members.fetch(userId);
    } catch (err) {
      logger.debug(`Lid ${userId} niet gevonden in ${guild.id}: ${err?.message || err}`);
      target = null;
    }
  }
  if (!target) {
    return { ok: false, line: `❌ <@${userId}> — zit niet in deze server (of het ID klopt niet).` };
  }

  const result = isHire
    ? await membershipService.hire(guild, gang, target, actor, { reason, bypassLimit: false })
    : await membershipService.fire(guild, gang, target, actor, { reason });

  if (!result || !result.ok) {
    const melding = truncate(String(result?.error || 'de actie is mislukt'), 220);
    return { ok: false, line: `❌ <@${userId}> — ${melding}` };
  }
  return {
    ok: true,
    line: `✅ <@${userId}> — ${describeSuccess(result, isHire)}`,
    action: result.action,
    counts: result.counts,
  };
}

/* -------------------------------------------------------------------------- */
/* Stap 7-10: terugkoppelen, loggen en waarschuwen                            */
/* -------------------------------------------------------------------------- */

/**
 * Post de samenvatting (stap 8). Is er niets gelukt, dan verdwijnt het bericht na
 * 60 seconden; bij (gedeeltelijk) succes blijft het staan als bewijs.
 *
 * @param {import('discord.js').Message} message Het oorspronkelijke bericht.
 * @param {{gang: object, isHire: boolean, lines: string[], okCount: number, total: number, counts: object|null}} ctx Context.
 * @returns {Promise<void>}
 */
async function postSummary(message, ctx) {
  const {
    gang, isHire, lines, okCount, total, counts,
  } = ctx;
  const titel = `${isHire ? 'Aanname' : 'Ontslag'} — ${gang.emoji ? `${gang.emoji} ` : ''}${gang.name}`;
  const body = lines.join('\n');
  const slot = counts ? `\n\n**Bezetting:** ${formatCapacity(counts)}` : '';
  const description = truncate(`${body}${slot}`, 3900);

  let embed;
  if (okCount === total) embed = successEmbed(titel, description);
  else if (okCount > 0) embed = warningEmbed(titel, description);
  else embed = errorEmbed(titel, description);

  let sent = null;
  try {
    sent = await message.reply({ embeds: [embed], allowedMentions: NO_PINGS });
  } catch (err) {
    logger.warn(`Samenvatting kon niet gepost worden: ${err?.message || err}`);
    // Terugval zonder embed, voor het geval 'Links insluiten' ontbreekt.
    try {
      sent = await message.reply({ content: truncate(`**${titel}**\n${body}`, 1900), allowedMentions: NO_PINGS });
    } catch (fallbackErr) {
      logger.warn(`Ook de tekstsamenvatting mislukte: ${fallbackErr?.message || fallbackErr}`);
    }
  }

  if (sent && okCount === 0) scheduleDelete(sent, SUMMARY_DELETE_MS);
}

/**
 * Stuurt elke geslaagde actie naar het logkanaal (stap 9) en waarschuwt daarna
 * eenmalig als de gang vol zit (stap 10).
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} gang Het GangRecord.
 * @param {Array<{ok: boolean, action?: object, counts?: object}>} results De verwerkte doelen.
 * @param {object|null} counts Verse telling ná alle acties.
 * @returns {Promise<void>}
 */
async function logResults(guild, gang, results, counts) {
  const geslaagd = results.filter((result) => result.ok && result.action);
  for (const result of geslaagd) {
    try {
      await logService.logAction(guild, result.action, result.counts || counts || null);
    } catch (err) {
      logger.warn(`Logbericht voor actie #${result.action?.id} mislukt: ${err?.message || err}`);
    }
  }

  if (!geslaagd.length || !counts) return;
  if (!counts.memberFull) return;

  try {
    await logService.logNotice(
      guild,
      warningEmbed(
        `⚠️ ${gang.name} zit vol`,
        `${formatCapacity(counts)}\n\nDe ledenlimiet is bereikt. `
          + 'Er kan pas weer iemand bij als er eerst iemand ontslagen wordt, of als staff de '
          + 'limiet verhoogt met `/gang limiet leden:<aantal>`.',
      ),
    );
  } catch (err) {
    logger.warn(`Waarschuwing 'gang vol' kon niet gepost worden: ${err?.message || err}`);
  }
}

/**
 * Werkt het dashboard bij zonder erop te wachten (het bericht mag niet blijven hangen).
 *
 * @param {import('discord.js').Guild} guild De server.
 * @returns {void}
 */
function refreshDashboard(guild) {
  void Promise.resolve(dashboardService.updateDashboard(guild)).catch((err) => {
    logger.debug(`Dashboard bijwerken mislukt: ${err?.message || err}`);
  });
}

/* -------------------------------------------------------------------------- */
/* Hoofdafhandeling                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Hint bij een bericht zonder bruikbare mentions (stap 4).
 *
 * @param {boolean} isHire true in het aannamekanaal.
 * @returns {import('discord.js').EmbedBuilder} De hint-embed.
 */
function hintEmbed(isHire) {
  const voorbeeld = isHire
    ? '`@Jan @Piet` — beiden aannemen\n`@Jan | reden: overgekomen van Ballas` — met reden erbij\n`@Rayuza @Jan` — staff: gang erbij'
    : '`@Sara` — Sara ontslaan\n`@Sara | reden: verraden` — met reden erbij';
  return infoEmbed(
    isHire ? 'Wie moet er aangenomen worden?' : 'Wie moet er ontslagen worden?',
    `Zet in je bericht een of meer @-mentions van de personen.\n\n${voorbeeld}\n\n`
      + 'Zie je geen reactie van de bot? Dan staat de Message Content Intent misschien uit.',
  );
}

/**
 * Hint als de enige mentions ná '|' of 'reden:' staan (stap 4). Die tellen bewust
 * niet als doel; een generieke 'zet er een mention in'-hint zou hier onzin lijken,
 * want de gebruiker ziet zijn mentions gewoon staan.
 *
 * @param {boolean} isHire true in het aannamekanaal.
 * @returns {import('discord.js').EmbedBuilder} De hint-embed.
 */
function reasonOnlyHintEmbed(isHire) {
  const voorbeeld = isHire ? '`@Jan | reden: overgekomen van Ballas`' : '`@Sara | reden: verraden`';
  return infoEmbed(
    isHire ? 'Wie moet er aangenomen worden?' : 'Wie moet er ontslagen worden?',
    'Ik zie alleen mentions ná `reden:` of `|`. Alles wat daar staat lees ik als toelichting en '
      + 'nooit als doel — zo pak ik niemand die je alleen even noemt.\n\n'
      + `Zet de persoon vóór de reden, bijvoorbeeld: ${voorbeeld}.`,
  );
}

/**
 * Stappen 1 t/m 3: partial berichten aanvullen, oninteressante berichten wegfilteren
 * en bepalen of dit het aanname- of het ontslagkanaal is.
 *
 * @param {import('discord.js').Message} message Het bericht.
 * @returns {Promise<{config: object, isHire: boolean}|null>} De context, of null als
 *   dit bericht genegeerd moet worden.
 */
async function resolveChannelContext(message) {
  if (message?.partial) {
    try {
      await message.fetch();
    } catch (err) {
      logger.debug(`Partial bericht kon niet opgehaald worden: ${err?.message || err}`);
      return null;
    }
  }
  if (!isRelevantMessage(message)) return null;

  let config;
  try {
    config = store.getGuildConfig(message.guild.id) || {};
  } catch (err) {
    logger.error(`Serverconfiguratie van ${message.guild.id} kon niet gelezen worden`, err);
    return null;
  }

  const channelId = message.channel.id;
  const isHire = Boolean(config.hireChannelId) && channelId === config.hireChannelId;
  const isFire = Boolean(config.fireChannelId) && channelId === config.fireChannelId;
  if (!isHire && !isFire) return null;
  return { config, isHire };
}

/**
 * Verwerkt alle doelen sequentieel (nooit parallel, dat loopt tegen ratelimits aan).
 *
 * @param {object} ctx Context voor processTarget.
 * @param {string[]} targets De gebruikers-id's.
 * @returns {Promise<Array<{ok: boolean, line: string, action?: object, counts?: object}>>} De resultaten.
 */
async function processAll(ctx, targets) {
  const results = [];
  for (const userId of targets) {
    // eslint-disable-next-line no-await-in-loop -- bewust sequentieel tegen ratelimits.
    results.push(await processTarget(ctx, userId));
  }
  return results;
}

/**
 * Voert de hele aanname-/ontslagflow uit nadat het kanaal en de gang bekend zijn.
 *
 * @param {import('discord.js').Message} message Het bericht.
 * @param {{guild: import('discord.js').Guild, gang: object, actor: import('discord.js').GuildMember, isHire: boolean, content: string, targets: string[]}} ctx Context.
 * @returns {Promise<void>}
 */
async function runFlow(message, ctx) {
  const {
    guild, gang, actor, isHire, content, targets,
  } = ctx;

  const reason = extractReason(content);
  const verwerkt = targets.slice(0, MAX_TARGETS);
  const overgeslagen = targets.length - verwerkt.length;

  const results = await processAll({
    guild, gang, actor, isHire, reason,
  }, verwerkt);

  const okCount = results.filter((result) => result.ok).length;
  await react(message, okCount === results.length ? '✅' : (okCount > 0 ? '⚠️' : '❌'));

  const lines = results.map((result) => result.line);
  if (overgeslagen > 0) {
    lines.push(`⚠️ ${overgeslagen} vermelding(en) overgeslagen: maximaal ${MAX_TARGETS} personen per bericht.`);
  }

  let counts = null;
  try {
    counts = countGang(guild, gang);
  } catch (err) {
    logger.warn(`Bezetting van ${gang.name} kon niet geteld worden: ${err?.message || err}`);
  }

  await postSummary(message, {
    gang, isHire, lines, okCount, total: results.length, counts,
  });
  await logResults(guild, gang, results, counts);
  refreshDashboard(guild);
}

module.exports = {
  name: Events.MessageCreate,
  once: false,

  /**
   * Leest berichten in het aanname- en ontslagkanaal en voert de gevraagde acties uit.
   * Faalt nooit hard: elke onverwachte fout levert een ❌-reactie en een logregel op.
   *
   * @param {import('discord.js').Message} message Het binnengekomen bericht.
   * @returns {Promise<void>}
   */
  async execute(message) {
    try {
      const context = await resolveChannelContext(message);
      if (!context) return;

      const guild = message.guild;
      const { config, isHire } = context;
      const content = typeof message.content === 'string' ? message.content : '';
      // Het 'opdrachtdeel' is alles vóór de reden. Mentions ná '|' of 'reden:' zijn
      // NOOIT een doel, ook niet als het opdrachtdeel leeg is. Dat wijkt bewust af van
      // SPEC 3 stap 4 (die leest de hele inhoud): met de oude terugval ontsloeg
      // 'reden: <@Jan> heeft <@Piet> bestolen' ook het slachtoffer Piet.
      const directive = stripReason(content);
      const targets = extractUserIds(directive);
      if (!targets.length) {
        await react(message, '❓');
        // Staan er wél mentions, maar alleen in de reden? Leg dan precies dát uit.
        const alleenInReden = extractUserIds(content).length > 0;
        await replyTemporary(
          message,
          alleenInReden ? reasonOnlyHintEmbed(isHire) : hintEmbed(isHire),
          HINT_DELETE_MS,
        );
        return;
      }

      const actor = await resolveAuthor(message);
      if (!actor) {
        await react(message, '❌');
        await replyTemporary(
          message,
          errorEmbed('Profiel niet gevonden', 'Ik kon je serverprofiel niet ophalen. Probeer het zo nog een keer.'),
          ERROR_DELETE_MS,
        );
        return;
      }

      let gangs = [];
      try {
        gangs = store.listGangs(guild.id) || [];
      } catch (err) {
        logger.error(`Ganglijst van ${guild.id} kon niet gelezen worden`, err);
      }
      if (!gangs.length) {
        await react(message, '❌');
        await replyTemporary(
          message,
          errorEmbed('Nog geen gangs', 'Er is nog geen enkele gang aangemaakt. Staff maakt er een met `/gang aanmaken`.'),
          ERROR_DELETE_MS,
        );
        return;
      }

      const staff = isStaff(actor, config);
      const keuze = pickGang({
        member: actor, staff, gangs, content: directive, isHire,
      });
      if (!keuze.gang) {
        await react(message, '❌');
        await replyTemporary(message, keuze.error, ERROR_DELETE_MS);
        return;
      }

      await runFlow(message, {
        guild, gang: keuze.gang, actor, isHire, content, targets,
      });
    } catch (err) {
      logger.error('Onverwachte fout bij het verwerken van een bericht', err);
      await react(message, '❌');
      await replyTemporary(
        message,
        errorEmbed(
          'Er ging iets mis',
          'Je bericht kon niet verwerkt worden. Probeer het opnieuw; blijft het misgaan, meld het dan bij staff.',
        ),
        ERROR_DELETE_MS,
      ).catch(() => {});
    }
  },
};
