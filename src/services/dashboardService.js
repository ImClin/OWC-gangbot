// src/services/dashboardService.js
// Houdt het live bezettingsoverzicht in het dashboardkanaal actueel: één bericht per
// server dat telkens bijgewerkt wordt, plus een lus die dat periodiek voor alle
// servers doet.
//
// Net als logService faalt deze module stil: hij gooit nooit, maar geeft
// { ok: false, error } terug met een concrete Nederlandse melding.

const { PermissionFlagsBits } = require('discord.js');

const logger = require('../lib/logger');
const store = require('../store');
const { countGang } = require('../lib/capacity');
const { dashboardEmbed } = require('../lib/embeds');

/** Standaardinterval van de lus: elke 5 minuten. */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/** Ondergrens voor het interval, zodat we nooit tegen de Discord-ratelimit aanlopen. */
const MIN_INTERVAL_MS = 30 * 1000;

/** Rechten die de bot in het dashboardkanaal nodig heeft. */
const SEND_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
];

/**
 * Lopende updates per server-id. Zo kunnen twee gelijktijdige events (bijvoorbeeld
 * een aanname en de periodieke lus) nooit twee dashboardberichten tegelijk posten.
 * @type {Map<string, Promise<*>>}
 */
const queues = new Map();

/* -------------------------------------------------------------------------- */
/* Interne helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Korte omschrijving van een server voor logregels.
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @returns {string} Bijvoorbeeld 'OWC (123456789012345678)'.
 */
function describeGuild(guild) {
  if (!guild) return 'onbekende server';
  return `${guild.name || 'server'} (${guild.id})`;
}

/**
 * Leest een leesbare foutmelding uit een willekeurige throw-waarde.
 * @param {*} err De gevangen fout.
 * @returns {string} De melding.
 */
function reason(err) {
  if (!err) return 'onbekende fout';
  return err.message || String(err);
}

/**
 * Zet taken per server achter elkaar in de rij, zodat er nooit twee updates
 * tegelijk lopen voor dezelfde server.
 * @param {string} guildId Server-id.
 * @param {() => Promise<*>} task De taak.
 * @returns {Promise<*>} Het resultaat van de taak.
 */
function enqueue(guildId, task) {
  const previous = queues.get(guildId) || Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.then(() => {}, () => {});
  queues.set(guildId, tail);
  tail.then(() => {
    if (queues.get(guildId) === tail) queues.delete(guildId);
  });
  return run;
}

/**
 * Haalt het GuildMember-object van de bot op (cache eerst, anders fetch).
 * @param {import('discord.js').Guild} guild De server.
 * @returns {Promise<import('discord.js').GuildMember|null>} Het botlid, of null.
 */
async function getMe(guild) {
  if (guild.members && guild.members.me) return guild.members.me;
  try {
    return await guild.members.fetchMe();
  } catch (err) {
    logger.warn(`Kon het botlid niet ophalen in ${describeGuild(guild)}: ${reason(err)}`);
    return null;
  }
}

/**
 * Zoekt het dashboardkanaal op en controleert of de bot er een embed mag posten.
 * @param {import('discord.js').Guild} guild De server.
 * @param {string} channelId Het ingestelde kanaal-id.
 * @returns {Promise<{channel: import('discord.js').GuildTextBasedChannel|null, error: string|null}>} Kanaal of foutmelding.
 */
async function resolveDashboardChannel(guild, channelId) {
  let channel = (guild.channels && guild.channels.cache && guild.channels.cache.get(channelId)) || null;
  if (!channel) {
    try {
      channel = await guild.channels.fetch(channelId);
    } catch (err) {
      return { channel: null, error: 'Het dashboardkanaal bestaat niet meer. Stel het opnieuw in met `/setup dashboard`.' };
    }
  }
  if (!channel || typeof channel.isTextBased !== 'function' || !channel.isTextBased()) {
    return { channel: null, error: 'Het ingestelde dashboardkanaal is geen tekstkanaal. Kies een tekstkanaal met `/setup dashboard`.' };
  }

  const me = await getMe(guild);
  let perms = null;
  try {
    perms = me ? channel.permissionsFor(me) : null;
  } catch (err) {
    perms = null;
  }
  if (!perms || SEND_PERMISSIONS.some((flag) => !perms.has(flag))) {
    return {
      channel: null,
      error: `De bot mag niet posten in <#${channelId}>. Geef hem daar Kanaal bekijken, Berichten versturen en Links insluiten.`,
    };
  }
  return { channel, error: null };
}

/**
 * Telt alle gangs van een server en zet de resultaten in een Map op gang-id.
 * @param {import('discord.js').Guild} guild De server.
 * @param {object[]} gangs De gangs uit de store.
 * @returns {Map<number, object>} Bezetting per gang-id.
 */
function buildCounts(guild, gangs) {
  const counts = new Map();
  for (const gang of gangs) {
    if (!gang) continue;
    try {
      counts.set(gang.id, countGang(guild, gang));
    } catch (err) {
      logger.warn(`Kon de bezetting van gang ${gang.name || gang.id} niet tellen: ${reason(err)}`);
    }
  }
  return counts;
}

/**
 * Probeert het bestaande dashboardbericht bij te werken.
 * @param {import('discord.js').GuildTextBasedChannel} channel Het dashboardkanaal.
 * @param {string|null} messageId Het opgeslagen bericht-id.
 * @param {import('discord.js').EmbedBuilder} embed De nieuwe embed.
 * @returns {Promise<import('discord.js').Message|null>} Het bijgewerkte bericht, of null als dat niet lukte.
 */
async function editExisting(channel, messageId, embed) {
  if (!messageId) return null;
  try {
    const message = await channel.messages.fetch(messageId);
    if (!message || message.editable === false) return null;
    return await message.edit({ embeds: [embed], components: [] });
  } catch (err) {
    logger.debug(`Dashboardbericht ${messageId} kon niet bewerkt worden (${reason(err)}); er komt een nieuw bericht.`);
    return null;
  }
}

/**
 * Slaat een nieuw dashboardbericht-id op als het afwijkt van wat er in de store staat.
 * @param {string} guildId Server-id.
 * @param {string|null} currentId Het opgeslagen id.
 * @param {string} newId Het nieuwe id.
 * @returns {void}
 */
function rememberMessageId(guildId, currentId, newId) {
  if (currentId === newId) return;
  try {
    store.setGuildConfig(guildId, { dashboardMessageId: newId });
  } catch (err) {
    logger.warn(`Kon het dashboardbericht-id niet opslaan voor server ${guildId}: ${reason(err)}`);
  }
}

/**
 * De daadwerkelijke update; wordt via enqueue() per server geserialiseerd.
 * @param {import('discord.js').Guild} guild De server.
 * @returns {Promise<{ok: boolean, error?: string}>} Resultaat.
 */
async function runUpdate(guild) {
  let config;
  try {
    config = store.getGuildConfig(guild.id);
  } catch (err) {
    return { ok: false, error: `De serverconfiguratie kon niet gelezen worden: ${reason(err)}` };
  }
  if (!config || !config.dashboardChannelId) {
    return { ok: false, error: 'Er is nog geen dashboardkanaal ingesteld. Gebruik `/setup dashboard`.' };
  }

  const { channel, error } = await resolveDashboardChannel(guild, config.dashboardChannelId);
  if (!channel) return { ok: false, error };

  const gangs = store.listGangs(guild.id) || [];
  const embed = dashboardEmbed(gangs, buildCounts(guild, gangs), Date.now());

  const edited = await editExisting(channel, config.dashboardMessageId, embed);
  if (edited) return { ok: true };

  try {
    const posted = await channel.send({ embeds: [embed] });
    rememberMessageId(guild.id, config.dashboardMessageId, posted.id);
    logger.debug(`Nieuw dashboardbericht geplaatst in #${channel.name || channel.id}.`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Het dashboardbericht kon niet geplaatst worden: ${reason(err)}` };
  }
}

/**
 * Werkt het dashboard van elke server in de cache bij, met per server een try/catch
 * zodat één kapotte server de rest niet blokkeert.
 * @param {import('discord.js').Client} client De ingelogde client.
 * @returns {Promise<void>}
 */
async function updateAllGuilds(client) {
  const guilds = client.guilds && client.guilds.cache ? Array.from(client.guilds.cache.values()) : [];
  for (const guild of guilds) {
    try {
      const result = await updateDashboard(guild);
      if (!result.ok && result.error) {
        logger.debug(`Dashboard ${describeGuild(guild)}: ${result.error}`);
      }
    } catch (err) {
      logger.error(`Onverwachte fout bij het dashboard van ${describeGuild(guild)}`, err);
    }
  }
}

/**
 * Normaliseert het meegegeven interval naar een bruikbare waarde in milliseconden.
 * @param {*} value Het gewenste interval.
 * @returns {number} Minimaal MIN_INTERVAL_MS.
 */
function normalizeInterval(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.floor(num));
}

/* -------------------------------------------------------------------------- */
/* Publieke API                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Maakt of bewerkt het dashboardbericht in het ingestelde dashboardkanaal: een
 * embed met de bezetting van alle gangs van deze server. Bestaat het opgeslagen
 * bericht niet meer (of is het niet van de bot), dan wordt er een nieuw bericht
 * geplaatst en het nieuwe id opgeslagen via store.setGuildConfig.
 *
 * Updates voor dezelfde server worden achter elkaar uitgevoerd, zodat twee
 * gelijktijdige aanroepen nooit twee berichten opleveren. Gooit nooit.
 *
 * @param {import('discord.js').Guild} guild De server waarvan het dashboard bijgewerkt wordt.
 * @returns {Promise<{ok: boolean, error?: string}>} ok:true bij succes, anders een NL-melding.
 */
async function updateDashboard(guild) {
  if (!guild || !guild.id) {
    return { ok: false, error: 'Geen geldige server meegegeven aan updateDashboard.' };
  }

  return enqueue(guild.id, async () => {
    try {
      return await runUpdate(guild);
    } catch (err) {
      logger.error(`Dashboard van ${describeGuild(guild)} kon niet bijgewerkt worden`, err);
      return { ok: false, error: `Het dashboard kon niet bijgewerkt worden: ${reason(err)}` };
    }
  });
}

/**
 * Start de periodieke dashboard-lus over alle servers van de client. Fouten worden
 * per server opgevangen en gelogd; overlappende rondes worden overgeslagen als een
 * vorige ronde nog loopt. De timer krijgt `unref()`, zodat Node netjes kan afsluiten.
 *
 * Er wordt direct één ronde gedraaid (niet afgewacht), daarna elke `intervalMs`.
 *
 * @param {import('discord.js').Client} client De ingelogde client.
 * @param {number} [intervalMs=300000] Interval in milliseconden; minimaal 30000.
 * @returns {NodeJS.Timeout|null} De timer (om later te stoppen), of null bij een ongeldige client.
 */
function startDashboardLoop(client, intervalMs = DEFAULT_INTERVAL_MS) {
  if (!client || !client.guilds) {
    logger.warn('startDashboardLoop aangeroepen zonder geldige client; lus niet gestart.');
    return null;
  }

  const delay = normalizeInterval(intervalMs);
  let running = false;

  const tick = async () => {
    if (running) {
      logger.debug('Vorige dashboard-ronde loopt nog; deze ronde overgeslagen.');
      return;
    }
    running = true;
    try {
      await updateAllGuilds(client);
    } catch (err) {
      logger.error('Dashboard-ronde mislukt', err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, delay);
  if (timer && typeof timer.unref === 'function') timer.unref();

  // Eerste ronde meteen, maar niet afgewacht: ready.js mag hier niet op blijven hangen.
  tick();

  logger.info(`Dashboard-lus gestart: elke ${Math.round(delay / 1000)} seconden.`);
  return timer;
}

module.exports = { updateDashboard, startDashboardLoop };
