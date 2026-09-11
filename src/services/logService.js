// src/services/logService.js
// Alles wat richting het staff-logkanaal gaat. Elke geslaagde aanname/ontslag/rolwijziging
// wordt hier gepost als embed met een rode 'Terugdraaien'-knop eronder; zodra een actie
// teruggedraaid is werkt markReverted datzelfde bericht bij.
//
// Belofte van deze module: hij gooit NOOIT. Ontbreekt het logkanaal, is het verwijderd,
// of mag de bot er niet posten, dan wordt er een warn gelogd en null teruggegeven.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');

const logger = require('../lib/logger');
const store = require('../store');
const { actionLogEmbed, registerEmbed } = require('../lib/embeds');
const { ACTION, BUTTON, COLORS } = require('../lib/constants');

/**
 * Welke actiesoort openbaar in welk registerkanaal hoort. Wat hier niet in staat gaat
 * alleen naar het staff-logkanaal: een handmatige rolwijziging of iemand die de server
 * verlaat is geen aanname of ontslag door de leiding, en hoort dus niet in het register.
 */
const ANNOUNCE_CHANNEL_BY_ACTION = {
  [ACTION.HIRE]: 'hireChannelId',
  [ACTION.HIRE_MEELOPER]: 'hireChannelId',
  [ACTION.FIRE]: 'fireChannelId',
};

/** Tekst op de actieve knop onder een logbericht. */
const REVERT_LABEL = 'Terugdraaien';

/** Tekst op de knop nadat de actie is teruggedraaid. */
const REVERTED_LABEL = 'Teruggedraaid';

/** Naam van het veld dat markReverted toevoegt (ook gebruikt om dubbel toevoegen te voorkomen). */
const REVERTED_FIELD_NAME = 'Teruggedraaid door';

/** Rechten die de bot in het logkanaal nodig heeft om te kunnen posten. */
const SEND_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
];

/** Harde Discord-limieten die we hier zelf bewaken. */
const MAX_TITLE = 256;
const MAX_FIELDS = 25;

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
 * Zoekt een tekstkanaal op id. Elke cache-lookup kan undefined zijn, dus valt hij
 * terug op een fetch. Geeft null bij een verwijderd of niet-tekstueel kanaal.
 * @param {import('discord.js').Guild} guild De server.
 * @param {string|null|undefined} channelId Het kanaal-id.
 * @returns {Promise<import('discord.js').GuildTextBasedChannel|null>} Het kanaal, of null.
 */
async function resolveTextChannel(guild, channelId) {
  if (!guild || !channelId) return null;

  let channel = (guild.channels && guild.channels.cache && guild.channels.cache.get(channelId)) || null;
  if (!channel) {
    try {
      channel = await guild.channels.fetch(channelId);
    } catch (err) {
      logger.warn(`Logkanaal ${channelId} bestaat niet meer in ${describeGuild(guild)}: ${reason(err)}`);
      return null;
    }
  }
  if (!channel || typeof channel.isTextBased !== 'function' || !channel.isTextBased()) {
    logger.warn(`Kanaal ${channelId} in ${describeGuild(guild)} is geen tekstkanaal; logbericht overgeslagen.`);
    return null;
  }
  return channel;
}

/**
 * Controleert of de bot in dit kanaal een embed mag posten.
 * @param {import('discord.js').Guild} guild De server.
 * @param {import('discord.js').GuildTextBasedChannel} channel Het kanaal.
 * @returns {Promise<boolean>} true als bekijken, versturen en insluiten mag.
 */
async function canSendIn(guild, channel) {
  const me = await getMe(guild);
  if (!me) return false;

  let perms = null;
  try {
    perms = channel.permissionsFor(me);
  } catch (err) {
    perms = null;
  }
  if (!perms) return false;

  const missing = SEND_PERMISSIONS.filter((flag) => !perms.has(flag));
  if (missing.length > 0) {
    logger.warn(
      `Bot mist rechten in logkanaal #${channel.name || channel.id} van ${describeGuild(guild)} `
        + '(nodig: Kanaal bekijken, Berichten versturen, Links insluiten).',
    );
    return false;
  }
  return true;
}

/**
 * Haalt het ingestelde logkanaal op en controleert meteen de rechten.
 * @param {import('discord.js').Guild} guild De server.
 * @param {string|null} [preferredChannelId] Kanaal-id uit de actie zelf; heeft voorrang op de config.
 * @returns {Promise<import('discord.js').GuildTextBasedChannel|null>} Bruikbaar logkanaal, of null.
 */
async function getLogChannel(guild, preferredChannelId) {
  if (!guild || !guild.id) return null;

  let channelId = preferredChannelId || null;
  if (!channelId) {
    let config = null;
    try {
      config = store.getGuildConfig(guild.id);
    } catch (err) {
      logger.error(`Kon de serverconfiguratie niet lezen voor ${describeGuild(guild)}: ${reason(err)}`);
      return null;
    }
    channelId = (config && config.logChannelId) || null;
  }

  if (!channelId) {
    logger.debug(`Geen logkanaal ingesteld voor ${describeGuild(guild)}; stel er een in met /setup kanalen.`);
    return null;
  }

  const channel = await resolveTextChannel(guild, channelId);
  if (!channel) return null;
  return (await canSendIn(guild, channel)) ? channel : null;
}

/**
 * Bouwt de knoprij onder een logbericht.
 * @param {{id?: number|string}} action De actie waar de knop bij hoort.
 * @param {boolean} [disabled=false] true voor de uitgeschakelde 'Teruggedraaid'-variant.
 * @returns {import('discord.js').ActionRowBuilder} Rij met precies één knop.
 */
function buildRevertRow(action, disabled = false) {
  const id = action && action.id !== undefined && action.id !== null ? action.id : 0;
  const button = new ButtonBuilder()
    .setCustomId(`${BUTTON.REVERT}:${id}`)
    .setLabel(disabled ? REVERTED_LABEL : REVERT_LABEL)
    .setStyle(disabled ? ButtonStyle.Secondary : ButtonStyle.Danger)
    .setDisabled(Boolean(disabled));
  return new ActionRowBuilder().addComponents(button);
}

/**
 * Neutrale kleur uit COLORS, met vaste fallback.
 * @returns {number} Kleurwaarde.
 */
function neutralColor() {
  return typeof COLORS.neutral === 'number' ? COLORS.neutral : 0x2b2d31;
}

/**
 * Relatieve Discord-tijdstempel, of een streepje als het tijdstip onbekend is.
 * @param {*} ms Tijdstip in milliseconden.
 * @returns {string} Bijvoorbeeld '<t:1710000000:R>'.
 */
function relTime(ms) {
  const num = Number(ms);
  if (!Number.isFinite(num) || num <= 0) return '—';
  return `<t:${Math.floor(num / 1000)}:R>`;
}

/**
 * Voegt het veld 'Teruggedraaid door' toe, tenzij het er al staat of de 25 velden vol zijn.
 * @param {import('discord.js').EmbedBuilder} embed De embed die bijgewerkt wordt.
 * @param {{revertedBy?: string|null, revertedAt?: number|null}} action Het ActionRecord.
 * @returns {import('discord.js').EmbedBuilder} Dezelfde embed.
 */
function addRevertedField(embed, action) {
  const fields = (embed.data && Array.isArray(embed.data.fields)) ? embed.data.fields : [];
  if (fields.some((field) => field && field.name === REVERTED_FIELD_NAME)) return embed;
  if (fields.length >= MAX_FIELDS) return embed;

  const who = action && action.revertedBy ? `<@${action.revertedBy}>` : 'onbekend';
  const when = relTime(action && action.revertedAt ? action.revertedAt : Date.now());
  return embed.addFields({ name: REVERTED_FIELD_NAME, value: `${who} · ${when}`, inline: false });
}

/**
 * Maakt van het bestaande logbericht een 'teruggedraaid'-versie: neutrale kleur,
 * titel met achtervoegsel en het extra veld. Staat er geen embed meer op het
 * bericht, dan wordt er een nieuwe gebouwd uit de actie zelf.
 * @param {import('discord.js').Message|null} message Het originele logbericht.
 * @param {object} action Het ActionRecord.
 * @returns {import('discord.js').EmbedBuilder} De bijgewerkte embed.
 */
function buildRevertedEmbed(message, action) {
  const original = message && Array.isArray(message.embeds) ? message.embeds[0] : null;
  const embed = original
    ? EmbedBuilder.from(original)
    : actionLogEmbed({ ...action, reverted: true }, null);

  embed.setColor(neutralColor());

  const title = embed.data && typeof embed.data.title === 'string' ? embed.data.title : '';
  if (title && !title.toLowerCase().includes('teruggedraaid')) {
    embed.setTitle(`${title} (teruggedraaid)`.slice(0, MAX_TITLE));
  }
  return addRevertedField(embed, action);
}

/**
 * Slaat bericht-id en kanaal-id op bij de actie, zodat markReverted het bericht
 * later kan terugvinden. Werkt ook het meegegeven action-object bij, zodat de
 * aanroeper de id's direct kan gebruiken zonder opnieuw uit de store te lezen.
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} action Het ActionRecord (wordt ter plekke aangevuld).
 * @param {import('discord.js').Message} message Het zojuist geposte bericht.
 * @returns {void}
 */
function rememberLogMessage(guild, action, message) {
  action.logMessageId = message.id;
  action.logChannelId = message.channelId || (message.channel && message.channel.id) || null;
  if (action.id === undefined || action.id === null) return;

  try {
    store.updateAction(guild.id, action.id, {
      logMessageId: action.logMessageId,
      logChannelId: action.logChannelId,
    });
  } catch (err) {
    logger.warn(`Kon het logbericht-id van actie #${action.id} niet opslaan: ${reason(err)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Publieke API                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Post een actie in het staff-logkanaal met een rode 'Terugdraaien'-knop eronder
 * (customId `owc:revert:<actie-id>`) en bewaart het bericht-id bij de actie via
 * store.updateAction.
 *
 * Faalt stil: is er geen logkanaal ingesteld, bestaat het niet meer, of mag de bot
 * er niet posten, dan wordt dat als warn gelogd en komt er null terug. Gooit nooit.
 *
 * @param {import('discord.js').Guild} guild De server waar de actie plaatsvond.
 * @param {object} action Het opgeslagen ActionRecord (moet een id hebben voor de knop).
 * @param {object|null} [counts] Bezetting van de gang ná de actie, uit countGang().
 * @returns {Promise<import('discord.js').Message|null>} Het geposte bericht, of null.
 */
async function logAction(guild, action, counts) {
  if (!guild || !action) {
    logger.warn('logAction aangeroepen zonder server of actie; overgeslagen.');
    return null;
  }

  const channel = await getLogChannel(guild, null);
  if (!channel) return null;

  try {
    const embed = actionLogEmbed(action, counts || null);
    const components = [buildRevertRow(action, Boolean(action.reverted))];
    const message = await channel.send({ embeds: [embed], components });
    rememberLogMessage(guild, action, message);
    logger.debug(`Actie #${action.id} gelogd in #${channel.name || channel.id}.`);
    return message;
  } catch (err) {
    logger.warn(
      `Logbericht voor actie #${action.id} kon niet gepost worden in ${describeGuild(guild)}: ${reason(err)}`,
    );
    return null;
  }
}

/**
 * Post een losse embed (zonder knoppen) in het logkanaal, bijvoorbeeld een
 * waarschuwing dat een gang vol zit of dat iemand de server verlaten heeft.
 *
 * Faalt stil met een warn-log als het logkanaal ontbreekt of de bot er niet mag posten.
 *
 * Met `mentionRoleId` komt er een echte ping boven de embed te staan. Dat kan alleen via
 * de berichtinhoud: een rolmention IN een embed pingt niemand, hij ziet er alleen uit als
 * een mention. allowedMentions staat daarom expliciet alleen die ene rol toe, zodat een
 * melding nooit per ongeluk @everyone of een lid wakker maakt.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {import('discord.js').EmbedBuilder|object} embed De embed uit lib/embeds.js.
 * @param {{mentionRoleId?: string|null}} [options] Extra opties.
 * @returns {Promise<import('discord.js').Message|null>} Het geposte bericht, of null.
 */
async function logNotice(guild, embed, options = {}) {
  if (!guild || !embed) {
    logger.warn('logNotice aangeroepen zonder server of embed; overgeslagen.');
    return null;
  }

  const channel = await getLogChannel(guild, null);
  if (!channel) return null;

  const mentionRoleId = typeof options?.mentionRoleId === 'string' && options.mentionRoleId
    ? options.mentionRoleId
    : null;

  try {
    const payload = { embeds: [embed] };
    if (mentionRoleId) {
      payload.content = `<@&${mentionRoleId}>`;
      payload.allowedMentions = { roles: [mentionRoleId] };
    }
    return await channel.send(payload);
  } catch (err) {
    logger.warn(`Meldingsembed kon niet gepost worden in ${describeGuild(guild)}: ${reason(err)}`);
    return null;
  }
}

/**
 * Post een aanname of ontslag OPENBAAR in het register (#aangenomen of #ontslagen).
 *
 * Waarom apart van logAction: het logkanaal is voor staff en krijgt de terugdraaiknop; het
 * register is voor iedereen in een gang en krijgt alleen de embed. Een aanname die via een
 * bericht IN het register binnenkwam hoeft hier niet langs - dat bericht staat er al.
 *
 * Faalt stil met een warn-log: de aanname zelf is dan al gelukt en mag hier niet op stuk.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} action Het ActionRecord.
 * @param {object|null} counts Telling na de actie.
 * @returns {Promise<import('discord.js').Message|null>} Het geposte bericht, of null.
 */
async function announceAction(guild, action, counts) {
  if (!guild || !action) {
    logger.warn('announceAction aangeroepen zonder server of actie; overgeslagen.');
    return null;
  }

  const kanaalKey = ANNOUNCE_CHANNEL_BY_ACTION[action.type];
  if (!kanaalKey) return null;

  let channelId = null;
  try {
    channelId = store.getGuildConfig(guild.id)?.[kanaalKey] || null;
  } catch (err) {
    logger.warn(`Registerkanaal opzoeken mislukt in ${describeGuild(guild)}: ${reason(err)}`);
    return null;
  }
  if (!channelId) return null;

  const channel = await resolveTextChannel(guild, channelId);
  if (!channel || !(await canSendIn(guild, channel))) {
    logger.warn(
      `Actie #${action.id} kon niet in het register gepost worden in ${describeGuild(guild)}:`
      + ' het kanaal bestaat niet meer of de bot mag er niet posten.',
    );
    return null;
  }

  // De gang erbij zoeken om hem als rol te kunnen noemen; lukt dat niet, dan valt
  // registerEmbed terug op de naam die in de actie zelf staat.
  let gang = null;
  try {
    gang = store.findGang(guild.id, action.gangId) || null;
  } catch (err) {
    logger.debug(`Gang van actie #${action.id} niet gevonden: ${reason(err)}`);
    gang = null;
  }

  try {
    const message = await channel.send({
      embeds: [registerEmbed(action, gang)],
      // Mentions in een embed pingen sowieso niet, maar dit maakt het hard: een register
      // dat de halve gang wakker belt bij elke aanname wil niemand.
      allowedMentions: { parse: [] },
    });
    logger.debug(`Actie #${action.id} openbaar gepost in #${channel.name || channel.id}.`);
    return message;
  } catch (err) {
    logger.warn(
      `Actie #${action.id} kon niet in het register gepost worden in ${describeGuild(guild)}: ${reason(err)}`,
    );
    return null;
  }
}

/**
 * Werkt het originele logbericht van een teruggedraaide actie bij: de knop wordt
 * vervangen door een uitgeschakelde 'Teruggedraaid'-variant, de embed kleurt
 * neutraal grijs en er komt een veld 'Teruggedraaid door' bij.
 *
 * Roep dit aan nádat membershipService.revertAction de actie in de store heeft
 * bijgewerkt, zodat revertedBy en revertedAt gevuld zijn. Gooit nooit.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} action Het (bijgewerkte) ActionRecord met logMessageId/logChannelId.
 * @returns {Promise<import('discord.js').Message|null>} Het bijgewerkte bericht, of null.
 */
async function markReverted(guild, action) {
  if (!guild || !action) {
    logger.warn('markReverted aangeroepen zonder server of actie; overgeslagen.');
    return null;
  }
  if (!action.logMessageId) {
    logger.debug(`Actie #${action.id} heeft geen logbericht om bij te werken.`);
    return null;
  }

  const channel = await getLogChannel(guild, action.logChannelId || null);
  if (!channel) return null;

  let message = null;
  try {
    message = await channel.messages.fetch(action.logMessageId);
  } catch (err) {
    logger.warn(`Logbericht van actie #${action.id} is niet meer te vinden: ${reason(err)}`);
    return null;
  }
  if (!message || message.editable === false) {
    logger.warn(`Logbericht van actie #${action.id} kan niet bewerkt worden (niet van de bot?).`);
    return null;
  }

  try {
    return await message.edit({
      embeds: [buildRevertedEmbed(message, action)],
      components: [buildRevertRow(action, true)],
    });
  } catch (err) {
    logger.warn(`Logbericht van actie #${action.id} kon niet bijgewerkt worden: ${reason(err)}`);
    return null;
  }
}

module.exports = {
  logAction, logNotice, announceAction, markReverted,
};
