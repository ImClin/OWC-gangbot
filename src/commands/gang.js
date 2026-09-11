// src/commands/gang.js
// Het /gang-commando met alle twaalf subcommands plus de autocomplete voor de gang-optie.
//
// Dit bestand bevat GEEN businesslogica: het controleert rechten, zet de opgegeven
// opties om in een service-aanroep (gangService / membershipService) en bouwt het
// antwoord op met de embeds uit lib/embeds.js. Precies dezelfde services worden door
// events/messageCreate.js gebruikt, zodat er niets gedupliceerd wordt.

const {
  SlashCommandBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  InteractionContextType,
} = require('discord.js');

const store = require('../store');
const logger = require('../lib/logger');
const { BUTTON, CHANNEL_BLUEPRINT } = require('../lib/constants');
const { truncate } = require('../lib/parse');
const { countGang, formatCapacity } = require('../lib/capacity');
const {
  isStaff,
  isLeaderOf,
  isBossOf,
  isMemberOf,
  getLedGangs,
  getMemberGang,
  getMemberGangs,
} = require('../lib/permissions');
const {
  successEmbed,
  errorEmbed,
  warningEmbed,
  infoEmbed,
  gangCreatedEmbed,
  gangInfoEmbed,
  gangListEmbed,
  actionLogEmbed,
  historyEmbed,
} = require('../lib/embeds');
const gangService = require('../services/gangService');
const membershipService = require('../services/membershipService');
const logService = require('../services/logService');
const dashboardService = require('../services/dashboardService');

/** Hoelang de bevestigingsknoppen van /gang verwijderen bruikbaar blijven. */
const CONFIRM_TIMEOUT_MS = 60 * 1000;

/** Discord staat maximaal 25 autocomplete-suggesties toe. */
const MAX_AUTOCOMPLETE_CHOICES = 25;

/** Maximale lengte van een autocomplete-label. */
const MAX_CHOICE_NAME = 100;

/** Aantal gangnamen dat we in een foutmelding opsommen. */
const MAX_LISTED_GANGS = 12;

/** Aantal rollen per gang (gang, boss, underboss). */
const ROLES_PER_GANG = 3;

/** Aantal kanalen per gang, uit de blueprint. */
const CHANNELS_PER_GANG = CHANNEL_BLUEPRINT.length;

/** Standaardaantal regels in de historie. */
const HISTORY_DEFAULT = 10;

/** Uitleg die bij elke "geen rechten"-melding hoort. */
const STAFF_HINT = 'Staff is iedereen met het serverrecht "Server beheren" of met de rol'
  + ' die via `/setup staffrol` is ingesteld.';

// ---------------------------------------------------------------------------
// Antwoord-helpers
// ---------------------------------------------------------------------------

/**
 * Stuurt een antwoord op een interactie, ongeacht of er al gedeferd of geantwoord is.
 * Faalt nooit hard: mislukt het antwoord (verlopen interactie, netwerkfout), dan wordt
 * dat als waarschuwing gelogd en komt er null terug.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction De interactie.
 * @param {object} payload Berichtinhoud, bijvoorbeeld `{ embeds: [embed] }`.
 * @param {{ephemeral?: boolean}} [options={}] `ephemeral: false` maakt het antwoord zichtbaar.
 * @returns {Promise<*>} Het verstuurde bericht, of null als antwoorden niet lukte.
 */
async function respond(interaction, payload, options = {}) {
  const ephemeral = options.ephemeral !== false;
  try {
    if (interaction.deferred || interaction.replied) {
      // editReply accepteert geen Ephemeral-vlag: die is al bij het deferren vastgelegd.
      return await interaction.editReply({ components: [], ...payload });
    }
    const data = { ...payload };
    if (ephemeral) data.flags = MessageFlags.Ephemeral;
    return await interaction.reply(data);
  } catch (err) {
    logger.warn(`/gang: antwoord versturen mislukt: ${err?.message || err}`);
    return null;
  }
}

/**
 * Kortere schrijfwijze voor een antwoord dat uit precies een embed bestaat.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction De interactie.
 * @param {import('discord.js').EmbedBuilder} embed De embed.
 * @param {{ephemeral?: boolean}} [options={}] `ephemeral: false` maakt het antwoord zichtbaar.
 * @returns {Promise<*>} Het resultaat van respond().
 */
function sendEmbed(interaction, embed, options = {}) {
  return respond(interaction, { embeds: [embed] }, options);
}

/**
 * Stuurt een foutmelding; die is altijd ephemeral, ook bij lijst en info.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction De interactie.
 * @param {string} title Korte titel.
 * @param {string} description Wat er mis is en wat de gebruiker eraan kan doen.
 * @returns {Promise<*>} Het resultaat van respond().
 */
function sendError(interaction, title, description) {
  return sendEmbed(interaction, errorEmbed(title, description), { ephemeral: true });
}

/**
 * Stelt het antwoord uit (altijd ephemeral) zodat langlopende acties de drie seconden
 * van Discord niet overschrijden.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction De interactie.
 * @returns {Promise<boolean>} true als het uitstellen lukte.
 */
async function deferEphemeral(interaction) {
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return true;
  } catch (err) {
    logger.warn(`/gang: deferReply mislukt: ${err?.message || err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Context en gemeenschappelijke controles
// ---------------------------------------------------------------------------

/**
 * Haalt het volledige GuildMember-object van de aanroeper op. In zeldzame gevallen
 * levert Discord een kaal member-object zonder rolcache; dan halen we het alsnog op.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction De interactie.
 * @returns {Promise<import('discord.js').GuildMember|null>} Het lid, of null.
 */
async function resolveActor(interaction) {
  const member = interaction.member;
  if (member && member.roles && member.roles.cache) return member;
  try {
    return await interaction.guild.members.fetch(interaction.user.id);
  } catch (err) {
    logger.warn(`/gang: aanroeper kon niet opgehaald worden: ${err?.message || err}`);
    return member || null;
  }
}

/**
 * @typedef {object} CommandContext
 * @property {import('discord.js').ChatInputCommandInteraction} interaction De interactie.
 * @property {import('discord.js').Guild} guild De server.
 * @property {string} guildId Server-id.
 * @property {import('discord.js').GuildMember|null} member De aanroeper.
 * @property {object} config Serverconfiguratie uit de store.
 * @property {object[]} gangs Alle GangRecords van deze server.
 * @property {boolean} staff Is de aanroeper staff?
 */

/**
 * Bouwt de context die elke subcommand-handler nodig heeft: de aanroeper, de
 * serverconfiguratie en de huidige gangs.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction De interactie.
 * @returns {Promise<CommandContext>} De context.
 */
async function buildContext(interaction) {
  const guild = interaction.guild;
  const guildId = guild.id;
  const member = await resolveActor(interaction);
  const config = store.getGuildConfig(guildId);
  const gangs = store.listGangs(guildId);
  return {
    interaction, guild, guildId, member, config, gangs, staff: isStaff(member, config),
  };
}

/**
 * Controleert of de aanroeper staff is en stuurt anders een duidelijke foutmelding.
 *
 * @param {CommandContext} ctx De context.
 * @param {string} wat Omschrijving van de actie, bijvoorbeeld 'een gang aanmaken'.
 * @returns {Promise<boolean>} true als de aanroeper verder mag.
 */
async function ensureStaff(ctx, wat) {
  if (ctx.staff) return true;
  await sendError(ctx.interaction, 'Geen toegang', `Alleen staff mag ${wat}. ${STAFF_HINT}`);
  return false;
}

/**
 * Zet een gang om in een leesbaar label: 'emoji naam', of alleen de naam als er geen
 * emoji (meer) bekend is.
 *
 * @param {object|null|undefined} gang Het GangRecord.
 * @returns {string} Bijvoorbeeld '⚔️ Rayuza'.
 */
function gangLabel(gang) {
  if (!gang) return 'onbekende gang';
  return `${gang.emoji ? `${gang.emoji} ` : ''}${gang.name || gang.slug || 'onbekend'}`;
}

/**
 * Vat de beschikbare gangs samen voor in een foutmelding.
 *
 * @param {object[]} gangs De GangRecords.
 * @returns {string} Bijvoorbeeld "Beschikbaar: Rayuza, Los Zetas."
 */
function gangChoicesText(gangs) {
  const list = Array.isArray(gangs) ? gangs.filter(Boolean) : [];
  if (!list.length) return 'Er zijn nog geen gangs aangemaakt; gebruik `/gang aanmaken`.';
  const shown = list.slice(0, MAX_LISTED_GANGS).map((gang) => gang.name).join(', ');
  const rest = list.length - Math.min(list.length, MAX_LISTED_GANGS);
  return `Beschikbaar: ${truncate(shown, 400)}${rest > 0 ? ` en nog ${rest} andere` : ''}.`;
}

/**
 * De gangs die deze gebruiker mag kiezen in de optie `gang`.
 *
 * Staff mag elke gang; ieder ander alleen de gang waar hij zelf in zit of leiding aan
 * geeft. Zo kan een boss niet in de gangs van anderen rondkijken of rommelen, ook niet
 * door de naam met de hand in te tikken in plaats van uit de suggesties te kiezen.
 *
 * @param {CommandContext} ctx De context.
 * @returns {object[]} De toegestane GangRecords.
 */
function selectableGangs(ctx) {
  if (ctx.staff) return ctx.gangs;
  return ctx.gangs.filter((gang) => isMemberOf(ctx.member, gang) || isLeaderOf(ctx.member, gang));
}

/**
 * Zoekt de gang die bij de opgegeven `gang`-optie hoort.
 *
 * @param {CommandContext} ctx De context.
 * @param {boolean} [required=true] Moet de optie ingevuld zijn?
 * @returns {{ok: true, gang: object|null}|{ok: false, error: string}} De gang of een melding.
 */
function resolveGangOption(ctx, required = true) {
  const toegestaan = selectableGangs(ctx);
  const raw = ctx.interaction.options.getString('gang');
  if (!raw || !raw.trim()) {
    if (!required) return { ok: true, gang: null };
    return {
      ok: false,
      error: `Geef met de optie \`gang\` op welke gang je bedoelt. ${gangChoicesText(toegestaan)}`,
    };
  }
  const gang = store.findGang(ctx.guildId, raw);
  if (!gang) {
    return {
      ok: false,
      error: `Ik ken geen gang die "${truncate(raw, 60)}" heet. Kies er een uit de suggesties. `
        + `${gangChoicesText(toegestaan)}`,
    };
  }
  // De suggesties tonen een niet-staffer alleen zijn eigen gang, maar de optie is vrije
  // tekst: zonder deze controle kan iemand de naam van een andere gang gewoon intikken.
  if (!toegestaan.some((eigen) => eigen.id === gang.id)) {
    return {
      ok: false,
      // Eigen titel: "Gang niet gevonden" zou hier misleidend zijn - de gang bestaat wel,
      // deze gebruiker mag er alleen niet bij.
      titel: 'Niet jouw gang',
      error: `Je kunt alleen je eigen gang kiezen. ${gangChoicesText(toegestaan)}`
        + ' Gebruik `/gang lijst` voor een overzicht van alle gangs.',
    };
  }
  return { ok: true, gang };
}

/**
 * Bepaalt bij welke gang een aanname of ontslag hoort, op dezelfde manier als
 * events/messageCreate.js dat doet: een expliciete optie wint, anders de enige gang
 * waarvan de aanroeper leiding is, anders een foutmelding met de keuzes.
 *
 * @param {CommandContext} ctx De context.
 * @param {string} verb Werkwoord voor de foutmelding, bijvoorbeeld 'aannemen'.
 * @returns {{ok: true, gang: object}|{ok: false, error: string}} De gang of een melding.
 */
function resolveActionGang(ctx, verb) {
  const explicit = ctx.interaction.options.getString('gang');
  if (explicit && explicit.trim()) return resolveGangOption(ctx, true);

  const led = getLedGangs(ctx.member, ctx.gangs);
  if (led.length === 1) return { ok: true, gang: led[0] };
  if (led.length > 1) {
    return {
      ok: false,
      error: 'Je geeft leiding aan meerdere gangs. Kies met de optie `gang` om welke het gaat: '
        + `${led.map((gang) => gang.name).join(', ')}.`,
    };
  }
  if (ctx.staff) {
    return {
      ok: false,
      error: `Kies met de optie \`gang\` bij welke gang je iemand wilt ${verb}. `
        + `${gangChoicesText(ctx.gangs)}`,
    };
  }
  return {
    ok: false,
    error: `Alleen de boss of underboss van een gang mag hier iemand ${verb}.`
      + ' Klopt dit niet? Vraag de staff om je de juiste rol te geven.',
  };
}

/**
 * Zoekt bij welke gang het GEKOZEN LID hoort.
 *
 * Promoveren en degraderen gaan altijd over de gang waar iemand al in zit - niemand zit in
 * twee gangs tegelijk, dus de bot hoeft daar niet naar te vragen. Blijkt iemand tóch twee
 * gangrollen te hebben, dan is er met de hand gerommeld; dan kiest de bot bewust niet zelf,
 * maar laat hij het aan staff over.
 *
 * @param {CommandContext} ctx De context.
 * @param {import('discord.js').GuildMember} member Het gekozen lid.
 * @param {string} verb 'promoveren' of 'degraderen', voor in de melding.
 * @returns {{ok: true, gang: object}|{ok: false, titel: string, error: string, meerdere?: object[]}} Resultaat.
 */
function resolveGangOfTarget(ctx, member, verb) {
  const gangs = getMemberGangs(member, ctx.gangs);
  if (gangs.length === 1) return { ok: true, gang: gangs[0] };

  if (!gangs.length) {
    return {
      ok: false,
      titel: 'Zit niet in een gang',
      error: `<@${member.id}> heeft geen gangrol, dus er valt niets te ${verb}.`
        + ' Neem diegene eerst aan met `/gang aannemen`.',
    };
  }

  const namen = gangs.map((gang) => gang.name).join(', ');
  return {
    ok: false,
    meerdere: gangs,
    titel: 'Meerdere gangrollen',
    error: `<@${member.id}> heeft de gangrol van ${gangs.length} gangs: **${namen}**.`
      + ' Niemand hoort in twee gangs tegelijk, dus de bot kan niet bepalen welke je bedoelt'
      + ` en ${verb} is niet doorgegaan.`
      + '\n\nHaal in Serverinstellingen de gangrol weg die er niet hoort, en probeer het'
      + ' daarna opnieuw. De staff is hier ook over ingelicht.',
  };
}

/**
 * Controleert of de aanroeper leiding geeft aan deze gang of staff is.
 *
 * @param {CommandContext} ctx De context.
 * @param {object} gang Het GangRecord.
 * @param {string} wat Omschrijving van de actie voor de foutmelding.
 * @returns {Promise<boolean>} true als de aanroeper verder mag.
 */
async function ensureLeaderOrStaff(ctx, gang, wat) {
  if (ctx.staff || isLeaderOf(ctx.member, gang)) return true;
  await sendError(
    ctx.interaction,
    'Geen toegang',
    `Alleen de boss of underboss van ${gang.name} (of staff) mag ${wat}. ${STAFF_HINT}`,
  );
  return false;
}

/**
 * Haalt het lid op dat in een user-optie is meegegeven.
 *
 * @param {CommandContext} ctx De context.
 * @param {string} optionName Naam van de optie, bijvoorbeeld 'lid'.
 * @returns {Promise<{ok: true, member: import('discord.js').GuildMember}|{ok: false, error: string}>}
 *   Het lid, of een Nederlandse melding.
 */
async function fetchOptionMember(ctx, optionName) {
  const member = ctx.interaction.options.getMember(optionName);
  if (member && member.roles && member.roles.cache) return { ok: true, member };

  const user = ctx.interaction.options.getUser(optionName);
  if (!user) {
    return { ok: false, error: `Geef met de optie \`${optionName}\` een geldig serverlid op.` };
  }
  try {
    return { ok: true, member: await ctx.guild.members.fetch(user.id) };
  } catch {
    return {
      ok: false,
      error: `${user.tag || user.username || user.id} zit niet (meer) in deze server,`
        + ' dus die persoon kan geen gangrollen krijgen of verliezen.',
    };
  }
}

// ---------------------------------------------------------------------------
// Neveneffecten: dashboard en logboek (nooit blokkerend voor de gebruiker)
// ---------------------------------------------------------------------------

/**
 * Werkt het bezettingsdashboard bij zonder de gebruiker te laten wachten.
 * Fouten worden opgevangen en gelogd; het commando zelf slaagt gewoon.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @returns {void}
 */
function refreshDashboard(guild) {
  if (!guild) return;
  try {
    void Promise.resolve(dashboardService.updateDashboard(guild))
      .catch((err) => logger.warn(`/gang: dashboard bijwerken mislukt: ${err?.message || err}`));
  } catch (err) {
    logger.warn(`/gang: dashboard bijwerken mislukt: ${err?.message || err}`);
  }
}

/**
 * Post een actie in het staff-logkanaal (met terugdraaiknop) zonder erop te wachten.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} action Het ActionRecord uit membershipService.
 * @param {object|null} counts Verse telling uit countGang().
 * @returns {void}
 */
function logActionAsync(guild, action, counts) {
  if (!guild || !action) return;
  try {
    void Promise.resolve(logService.logAction(guild, action, counts || null))
      .catch((err) => logger.warn(`/gang: actie loggen mislukt: ${err?.message || err}`));
  } catch (err) {
    logger.warn(`/gang: actie loggen mislukt: ${err?.message || err}`);
  }
}

/**
 * Post een losse melding in het staff-logkanaal zonder erop te wachten.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {import('discord.js').EmbedBuilder} embed De embed.
 * @returns {void}
 */
function logNoticeAsync(guild, embed) {
  if (!guild || !embed) return;
  try {
    void Promise.resolve(logService.logNotice(guild, embed))
      .catch((err) => logger.warn(`/gang: melding loggen mislukt: ${err?.message || err}`));
  } catch (err) {
    logger.warn(`/gang: melding loggen mislukt: ${err?.message || err}`);
  }
}

/**
 * Post een melding in het logkanaal MET een ping naar de meldrol (`/setup meldrol`).
 *
 * Voor situaties waar de bot niet verder kan en een mens moet ingrijpen. Is er geen meldrol
 * ingesteld, dan gaat de melding er gewoon zonder ping in - beter een stille melding dan
 * helemaal geen.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {import('discord.js').EmbedBuilder} embed De embed.
 * @returns {void}
 */
function alertNoticeAsync(guild, embed) {
  if (!guild || !embed) return;
  let mentionRoleId = null;
  try {
    mentionRoleId = store.getGuildConfig(guild.id)?.alertRoleId || null;
  } catch (err) {
    logger.warn(`/gang: meldrol opzoeken mislukt: ${err?.message || err}`);
  }
  try {
    void Promise.resolve(logService.logNotice(guild, embed, { mentionRoleId }))
      .catch((err) => logger.warn(`/gang: melding loggen mislukt: ${err?.message || err}`));
  } catch (err) {
    logger.warn(`/gang: melding loggen mislukt: ${err?.message || err}`);
  }
}

/**
 * Post een aanname of ontslag openbaar in het register, zonder erop te wachten.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} action Het ActionRecord.
 * @param {object|null} counts Telling na de actie.
 * @returns {void}
 */
function announceActionAsync(guild, action, counts) {
  if (!guild || !action) return;
  try {
    void Promise.resolve(logService.announceAction(guild, action, counts || null))
      .catch((err) => logger.warn(`/gang: actie openbaar posten mislukt: ${err?.message || err}`));
  } catch (err) {
    logger.warn(`/gang: actie openbaar posten mislukt: ${err?.message || err}`);
  }
}

/**
 * Waarschuwt in het logkanaal zodra een gang na een aanname aan de ledenlimiet zit.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} gang Het GangRecord.
 * @param {object} counts Telling na de aanname.
 * @returns {void}
 */
function warnIfFull(guild, gang, counts) {
  if (!counts || !counts.memberFull) return;
  logNoticeAsync(
    guild,
    warningEmbed(
      `${gangLabel(gang)} zit vol`,
      `${gang.name} heeft de ledenlimiet bereikt: ${formatCapacity(counts)}.`
        + ' Er kan pas weer iemand bij nadat er iemand ontslagen is, of nadat staff de limiet'
        + ' verhoogt met `/gang limiet leden:<aantal>`.',
    ),
  );
}

// ---------------------------------------------------------------------------
// /gang aanmaken
// ---------------------------------------------------------------------------

/**
 * Maakt een nieuwe gang aan: drie rollen, een categorie en zes kanalen (gangService).
 *
 * @param {CommandContext} ctx De context.
 * @returns {Promise<void>}
 */
async function handleAanmaken(ctx) {
  const { interaction, guild } = ctx;
  if (!await ensureStaff(ctx, 'een gang aanmaken')) return;
  if (!await deferEphemeral(interaction)) return;

  let bossMember = null;
  if (interaction.options.getUser('boss')) {
    const found = await fetchOptionMember(ctx, 'boss');
    if (!found.ok) {
      await sendError(interaction, 'Boss niet gevonden', found.error);
      return;
    }
    bossMember = found.member;
  }

  const result = await gangService.createGang(guild, {
    name: interaction.options.getString('naam'),
    emoji: interaction.options.getString('emoji'),
    abbreviation: interaction.options.getString('afkorting') ?? undefined,
    bossMember,
    memberLimit: interaction.options.getInteger('ledenlimiet') ?? undefined,
    actorId: interaction.user.id,
  });

  if (!result.ok) {
    await sendError(interaction, 'Gang aanmaken mislukt', result.error);
    return;
  }

  const counts = countGang(guild, result.gang);
  await sendEmbed(interaction, gangCreatedEmbed(result.gang, counts));
  logNoticeAsync(
    guild,
    successEmbed(
      'Nieuwe gang aangemaakt',
      `**${gangLabel(result.gang)}** is aangemaakt door <@${interaction.user.id}>.`
        + ` Limieten: ${formatCapacity(counts)}.`,
    ),
  );
  refreshDashboard(guild);
}

// ---------------------------------------------------------------------------
// /gang verwijderen
// ---------------------------------------------------------------------------

/**
 * Stand van de bevestigingen die dit proces zelf gepost heeft: 'open' (knop staat klaar),
 * 'bezig' (verwijdering loopt), 'afgerond' (klik verwerkt) of 'geannuleerd' (er is op
 * Annuleren geklikt). Alleen bij 'open' - of bij een knop die deze sessie niet kent maar
 * nog binnen de bedenktijd valt - mag er daadwerkelijk verwijderd worden.
 *
 * WAAROM dit bestaat: de klik wordt niet meer met een collector afgewacht maar door
 * handleButton() hieronder afgehandeld. Zonder deze stand zou een tweede klik binnen
 * de bedenktijd een tweede gangService.deleteGang op dezelfde gang starten. Alles wat
 * ouder is dan CONFIRM_TIMEOUT_MS wordt door de leeftijdscontrole op het bericht
 * tegengehouden, dus deze kaartenbak blijft klein en hoeft een herstart niet te overleven.
 */
const DELETE_CONFIRMS = new Map();

/**
 * Bouwt de customId van een verwijderknop.
 *
 * WAAROM alles in de id: de knop moet ook zonder draaiende collector (bijvoorbeeld na
 * een herstart van de bot) nog precies weten om welke gang het gaat, of de rollen mee
 * verwijderd mogen worden en van wie de bevestiging is. Stond de rollenkeuze niet in de
 * id, dan kon `rollen_verwijderen: false` niet gekend worden en werden de drie rollen
 * alsnog verwijderd. Wijzig dit formaat alleen samen met handleButton().
 *
 * @param {string} prefix BUTTON.CONFIRM_DELETE of BUTTON.CANCEL.
 * @param {number|string} gangId Id van de gang.
 * @param {boolean} deleteRoles Worden de drie rollen ook verwijderd?
 * @param {string} ownerId Id van degene die het commando uitvoerde.
 * @returns {string} De volledige customId, bijvoorbeeld 'owc:confirmdelete:3:0:123'.
 */
function buildDeleteButtonId(prefix, gangId, deleteRoles, ownerId) {
  return `${prefix}:${gangId}:${deleteRoles ? 1 : 0}:${ownerId}`;
}

/**
 * Bouwt de knoprij van de verwijderbevestiging. Beide id's worden één keer opgebouwd en
 * doorgegeven, zodat knop en afhandeling niet uit elkaar kunnen lopen.
 *
 * @param {string} confirmId customId van de bevestigknop.
 * @param {string} cancelId customId van de annuleerknop.
 * @param {boolean} [disabled=false] true om beide knoppen uit te schakelen.
 * @returns {import('discord.js').ActionRowBuilder} De knoprij.
 */
function buildConfirmRow(confirmId, cancelId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(confirmId)
      .setLabel('Definitief verwijderen')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(Boolean(disabled)),
    new ButtonBuilder()
      .setCustomId(cancelId)
      .setLabel('Annuleren')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(Boolean(disabled)),
  );
}

/**
 * Beschrijft precies wat er verdwijnt als deze gang verwijderd wordt.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} gang Het GangRecord.
 * @param {object} counts Telling uit countGang().
 * @param {boolean} deleteRoles Worden de drie rollen ook verwijderd?
 * @returns {string} De opsomming voor in de bevestigingsembed.
 */
function describeDeletion(guild, gang, counts, deleteRoles) {
  const category = gang.categoryId ? guild.channels?.cache?.get(gang.categoryId) : null;
  const channelsLeft = CHANNEL_BLUEPRINT
    .filter((item) => guild.channels?.cache?.get(gang.channels?.[item.kind]))
    .length;
  const rolesLeft = [gang.roleId, gang.bossRoleId, gang.underbossRoleId]
    .filter((roleId) => roleId && guild.roles?.cache?.get(roleId))
    .length;
  // Een gang van voor deze versie kan nog een achtergebleven `<Gang> Meeloper`-rol hebben.
  // gangService ruimt die hoe dan ook op, ook bij rollen_verwijderen: Nee - dus zeg dat erbij.
  const achtergebleven = gang.meeloperRoleId ? guild.roles?.cache?.get(gang.meeloperRoleId) : null;
  const leden = Number(counts?.members) || 0;

  return [
    `Je staat op het punt **${gangLabel(gang)}** volledig te verwijderen.`,
    '',
    `• **Categorie:** ${category ? category.name : 'niet meer aanwezig'}`,
    `• **Kanalen:** ${CHANNELS_PER_GANG} stuks (${channelsLeft} nog aanwezig)`,
    deleteRoles
      ? `• **Rollen:** ${ROLES_PER_GANG} stuks (${rolesLeft} nog aanwezig) worden verwijderd`
      : `• **Rollen:** de ${ROLES_PER_GANG} rollen blijven bestaan (leden houden hun rol)`,
    achtergebleven
      ? `• **Oude rol ${achtergebleven.name}:** bestaat nog en wordt sowieso verwijderd`
      : null,
    `• **Leden:** ${leden} persoon/personen ${deleteRoles ? 'verliezen hun gangrol' : 'houden hun rol maar hebben nergens meer toegang'}`,
    '',
    'Dit kan niet ongedaan gemaakt worden. Je hebt 60 seconden om te bevestigen.',
  ].filter((regel) => regel !== null).join('\n');
}

/**
 * Valt deze bevestiging nog binnen de 60 seconden bedenktijd?
 *
 * Een onbekende of onleesbare tijd geldt bewust als verlopen: liever één keer opnieuw
 * laten bevestigen dan een gang verwijderen op een knop van onbekende ouderdom.
 *
 * @param {*} message Het bericht waar de knop op staat.
 * @returns {boolean} true als de knop nog geldig is.
 */
function isWithinConfirmWindow(message) {
  const created = message?.createdTimestamp;
  if (typeof created !== 'number' || !Number.isFinite(created)) return false;
  return Date.now() - created <= CONFIRM_TIMEOUT_MS;
}

/**
 * Zet de bevestiging op een eindstand ('afgerond' of 'geannuleerd') en ruimt de stand
 * later op, zodat DELETE_CONFIRMS niet blijft groeien als de klik in een ander proces
 * valt dan de vervaltimer.
 *
 * WAAROM een eindstand en geen delete(): een verwijderde stand is niet te onderscheiden
 * van een knop uit een vorige sessie, en die mag binnen de bedenktijd nog verwijderen.
 * Na annuleren of afronden zou de bevestigknop dan alsnog de gang weggooien.
 *
 * @param {string} confirmId customId van de bevestigknop.
 * @param {'afgerond'|'geannuleerd'} [stand='afgerond'] De eindstand.
 * @returns {void}
 */
function markConfirmHandled(confirmId, stand = 'afgerond') {
  DELETE_CONFIRMS.set(confirmId, stand);
  const timer = setTimeout(() => DELETE_CONFIRMS.delete(confirmId), CONFIRM_TIMEOUT_MS);
  // Opruimwerk mag het afsluiten van de bot niet tegenhouden.
  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * Geeft een geclaimde bevestiging weer vrij (bijvoorbeeld als de klikker toch geen
 * staff blijkt), zodat de knop niet onnodig dood raakt.
 *
 * @param {string} confirmId customId van de bevestigknop.
 * @param {string|undefined} vorigeStand De stand van vóór de claim.
 * @returns {void}
 */
function releaseConfirm(confirmId, vorigeStand) {
  if (vorigeStand === undefined) DELETE_CONFIRMS.delete(confirmId);
  else DELETE_CONFIRMS.set(confirmId, vorigeStand);
}

/**
 * Maakt de knoppen na 60 seconden grijs en meldt dat er niets verwijderd is. Dit is
 * puur de zichtbare kant van de vervaltermijn; de harde controle gebeurt bij de klik
 * zelf (isWithinConfirmWindow), want een timer overleeft geen herstart.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction De interactie.
 * @param {{confirmId: string, cancelId: string}} ids De twee customId's.
 * @param {object} gang Het GangRecord.
 * @returns {void}
 */
function scheduleConfirmExpiry(interaction, ids, gang) {
  const timer = setTimeout(() => {
    const state = DELETE_CONFIRMS.get(ids.confirmId);
    // Een klik die al binnen was ('bezig', 'afgerond', 'geannuleerd') houdt zijn stand;
    // die wordt door markConfirmHandled zelf opgeruimd. Alleen een onaangeroerde
    // bevestiging verdwijnt hier - vanaf nu beslist de leeftijd van het bericht.
    if (state !== 'open') return;
    DELETE_CONFIRMS.delete(ids.confirmId);
    void respond(interaction, {
      embeds: [infoEmbed(
        'Bevestiging verlopen',
        `Er is 60 seconden lang niet bevestigd; ${gang.name} is NIET verwijderd.`
          + ' Voer `/gang verwijderen` opnieuw uit als je het alsnog wilt doen.',
      )],
      components: [buildConfirmRow(ids.confirmId, ids.cancelId, true)],
    });
  }, CONFIRM_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * Vraagt om een bevestiging met twee knoppen. De klik wordt bewust NIET hier afgewacht:
 * handleButton() hieronder is de enige afhandelaar (zie de uitleg daar).
 *
 * @param {CommandContext} ctx De context.
 * @returns {Promise<void>}
 */
async function handleVerwijderen(ctx) {
  const { interaction, guild } = ctx;
  if (!await ensureStaff(ctx, 'een gang verwijderen')) return;
  if (!await deferEphemeral(interaction)) return;

  const found = resolveGangOption(ctx, true);
  if (!found.ok) {
    await sendError(interaction, found.titel || 'Gang niet gevonden', found.error);
    return;
  }
  const gang = found.gang;
  const deleteRoles = interaction.options.getBoolean('rollen_verwijderen') ?? true;
  const counts = countGang(guild, gang);
  const ids = {
    confirmId: buildDeleteButtonId(BUTTON.CONFIRM_DELETE, gang.id, deleteRoles, interaction.user.id),
    cancelId: buildDeleteButtonId(BUTTON.CANCEL, gang.id, deleteRoles, interaction.user.id),
  };

  const message = await respond(interaction, {
    embeds: [warningEmbed('Weet je het zeker?', describeDeletion(guild, gang, counts, deleteRoles))],
    components: [buildConfirmRow(ids.confirmId, ids.cancelId)],
  });
  if (!message) return; // Antwoord niet aangekomen: er staat geen knop in beeld.

  DELETE_CONFIRMS.set(ids.confirmId, 'open');
  scheduleConfirmExpiry(interaction, ids, gang);
}

// ---------------------------------------------------------------------------
// Knoppen van /gang verwijderen (enige afhandelaar)
// ---------------------------------------------------------------------------

/**
 * Stuurt een los ephemeral antwoord op een knopklik, zonder het oorspronkelijke
 * bevestigingsbericht aan te raken.
 *
 * @param {import('discord.js').ButtonInteraction} interaction De knopinteractie.
 * @param {import('discord.js').EmbedBuilder} embed De embed voor de gebruiker.
 * @returns {Promise<boolean>} true als het antwoord verstuurd is.
 */
async function replyToClick(interaction, embed) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
    return true;
  } catch (err) {
    logger.warn(`/gang: klik kon niet beantwoord worden: ${err?.message || err}`);
    return false;
  }
}

/**
 * Antwoordt op een knopklik door het bericht met de knoppen zelf bij te werken.
 * Lukt dat niet (bericht weg, interactie al beantwoord), dan volgt alsnog een los
 * ephemeral antwoord, zodat een klik nooit stil doodloopt.
 *
 * @param {import('discord.js').ButtonInteraction} interaction De knopinteractie.
 * @param {import('discord.js').EmbedBuilder} embed De embed voor de gebruiker.
 * @param {Array|null} [components=null] Nieuwe componenten (`[]` haalt de knoppen weg).
 * @returns {Promise<boolean>} true als de gebruiker iets te zien kreeg.
 */
async function updateClickMessage(interaction, embed, components = null) {
  const payload = { embeds: [embed] };
  if (Array.isArray(components)) payload.components = components;
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
    } else {
      await interaction.update(payload);
    }
    return true;
  } catch (err) {
    logger.warn(`/gang: knopbericht bijwerken mislukt: ${err?.message || err}`);
  }
  return replyToClick(interaction, embed);
}

/**
 * Leest de serverconfiguratie zonder te gooien (nodig voor de staffcontrole bij een klik).
 *
 * @param {string} guildId Server-id.
 * @returns {object} De configuratie, of een leeg object bij een fout.
 */
function readGuildConfig(guildId) {
  try {
    return store.getGuildConfig(guildId) || {};
  } catch (err) {
    logger.warn(`/gang: serverconfiguratie lezen mislukt: ${err?.message || err}`);
    return {};
  }
}

/**
 * Voert de verwijdering uit na een klik op 'Definitief verwijderen'.
 *
 * @param {import('discord.js').ButtonInteraction} interaction De knopinteractie.
 * @param {object} gang Het GangRecord.
 * @param {boolean} deleteRoles Worden de rollen ook verwijderd?
 * @param {string} actorId Id van de staffer die bevestigde.
 * @returns {Promise<void>}
 */
async function runConfirmedDelete(interaction, gang, deleteRoles, actorId) {
  const guild = interaction.guild;
  // Eerst de knoppen weghalen en de interactie bevestigen: dat voorkomt een tweede klik
  // en houdt ons binnen de drie seconden die Discord voor een antwoord geeft.
  await updateClickMessage(
    interaction,
    infoEmbed('Bezig met verwijderen', `${gang.name} wordt opgeruimd, even geduld.`),
    [],
  );

  const result = await gangService.deleteGang(guild, gang, { deleteRoles, actorId });
  const beschrijving = `**${gangLabel(gang)}** is verwijderd.`
    + (deleteRoles ? '' : ' De drie rollen zijn blijven bestaan.')
    + (result?.error ? `\n\n⚠️ ${result.error}` : '');
  await updateClickMessage(
    interaction,
    result?.ok
      ? successEmbed('Gang verwijderd', beschrijving)
      : errorEmbed('Verwijderen mislukt', result?.error || 'Onbekende fout.'),
    [],
  );

  if (result?.ok) {
    logNoticeAsync(
      guild,
      warningEmbed(
        'Gang verwijderd',
        `**${gangLabel(gang)}** is verwijderd door <@${actorId}>.`,
      ),
    );
    refreshDashboard(guild);
  }
}

/**
 * Controleert de bevestigknop en verwijdert de gang als alles klopt.
 *
 * @param {import('discord.js').ButtonInteraction} interaction De knopinteractie.
 * @param {string[]} parts De customId, gesplitst op ':'.
 * @returns {Promise<void>}
 */
async function confirmDeleteClick(interaction, parts) {
  // Zelfde tekst als interaction.customId, maar zonder die eigenschap opnieuw te lezen.
  const customId = parts.join(':');
  // Een geldige knop draagt ALTIJD de rollenkeuze en de eigenaar. Ontbreekt er een,
  // dan komt hij uit een oudere versie van de bot en weten we niet of de rollen
  // behouden moesten blijven; dan verwijderen we liever niets dan te gokken.
  if (parts[3] === undefined || parts[4] === undefined) {
    await updateClickMessage(interaction, warningEmbed(
      'Bevestiging verlopen',
      'Deze knop komt uit een oudere versie of een eerdere sessie van de bot, dus ik weet niet meer'
        + ' of de rollen behouden moesten blijven. Er is niets verwijderd.'
        + ' Voer `/gang verwijderen` opnieuw uit.',
    ), []);
    return;
  }

  const state = DELETE_CONFIRMS.get(customId);
  if (state === 'bezig') {
    await replyToClick(interaction, infoEmbed(
      'Al bezig',
      'Deze verwijdering wordt op dit moment al uitgevoerd. Wacht even; het resultaat verschijnt'
        + ' vanzelf in het bericht hierboven.',
    ));
    return;
  }
  if (state === 'afgerond') {
    await replyToClick(interaction, infoEmbed(
      'Al afgehandeld',
      'Deze bevestiging is al gebruikt; er is niets opnieuw verwijderd.',
    ));
    return;
  }
  if (state === 'geannuleerd') {
    await replyToClick(interaction, infoEmbed(
      'Al geannuleerd',
      'Deze bevestiging is geannuleerd, dus er is niets verwijderd en de gang bestaat nog.'
        + ' Voer `/gang verwijderen` opnieuw uit als je het alsnog wilt doen.',
    ));
    return;
  }
  // Zonder stand komt de knop uit een eerdere sessie (herstart) of is de vervaltimer al
  // gelopen; dan beslist de leeftijd van het bericht over de 60 seconden bedenktijd.
  if (state !== 'open' && !isWithinConfirmWindow(interaction.message)) {
    await updateClickMessage(interaction, warningEmbed(
      'Bevestiging verlopen',
      'Deze bevestiging is niet meer geldig: de 60 seconden zijn voorbij of de bot is opnieuw'
        + ' gestart. Er is niets verwijderd. Voer `/gang verwijderen` opnieuw uit.',
    ), []);
    return;
  }

  // Meteen claimen, ZONDER await tussen de controle hierboven en deze regel: twee
  // klikken die vlak na elkaar binnenkomen zouden anders allebei langs de controle
  // glippen en samen twee keer gangService.deleteGang op dezelfde gang starten.
  DELETE_CONFIRMS.set(customId, 'bezig');

  const member = await resolveActor(interaction);
  if (!member || !isStaff(member, readGuildConfig(interaction.guild.id))) {
    releaseConfirm(customId, state);
    await replyToClick(interaction, errorEmbed(
      'Geen toegang',
      `Alleen staff mag een gang verwijderen. ${STAFF_HINT}`,
    ));
    return;
  }

  const gang = store.findGang(interaction.guild.id, parts[2]);
  if (!gang) {
    releaseConfirm(customId, state);
    await updateClickMessage(interaction, errorEmbed(
      'Gang niet gevonden',
      'Deze gang staat niet meer in het overzicht; waarschijnlijk is hij al verwijderd.'
        + ' Er is nu niets verwijderd.',
    ), []);
    return;
  }

  // '0', 'false', 'nee' of 'no' betekent: de rollen blijven bestaan. Nooit stilzwijgend
  // op true terugvallen - dat gooide eerder rollen weg die de staffer wilde houden.
  const deleteRoles = !['0', 'false', 'nee', 'no'].includes(String(parts[3]).toLowerCase());

  try {
    await runConfirmedDelete(interaction, gang, deleteRoles, interaction.user.id);
  } finally {
    // Ook na een fout blijft deze knop dood: het bericht is al bijgewerkt en een nieuwe
    // poging hoort via een nieuw /gang verwijderen te lopen.
    markConfirmHandled(customId);
  }
}

/**
 * Handelt de knoppen van `/gang verwijderen` af:
 * `owc:confirmdelete:<gangId>:<rollen 0|1>:<eigenaarId>` en
 * `owc:cancel:<gangId>:<rollen 0|1>:<eigenaarId>`.
 *
 * WAAROM hier en nergens anders: eerder hing er een collector aan het bericht terwijl
 * events/interactionCreate.js dezelfde knop ook zelf afhandelde. Die twee raceten om de
 * klik, waardoor gangService.deleteGang twee keer op dezelfde gang kon draaien en het
 * terugvalpad `rollen_verwijderen: false` niet kende. Er is nu één eigenaar: de router
 * in interactionCreate.js roept deze functie aan en doet zelf niets meer met de knop.
 *
 * @param {import('discord.js').ButtonInteraction} interaction De knopinteractie.
 * @returns {Promise<boolean>} true als deze knop hier is afgehandeld.
 */
async function handleButton(interaction) {
  const customId = typeof interaction?.customId === 'string' ? interaction.customId : '';
  const parts = customId.split(':');
  const prefix = `${parts[0]}:${parts[1] || ''}`;
  if (prefix !== BUTTON.CONFIRM_DELETE && prefix !== BUTTON.CANCEL) return false;

  if (!interaction.guild) {
    await replyToClick(interaction, warningEmbed(
      'Alleen in een server',
      'Deze knop werkt alleen binnen de server zelf, niet in een privebericht.',
    ));
    return true;
  }

  // De eigenaar staat in de knop; alleen bij een knop van voor deze versie vallen we
  // terug op wie het commando uitvoerde.
  const ownerId = parts[4]
    || interaction.message?.interactionMetadata?.user?.id
    || interaction.message?.interaction?.user?.id
    || null;
  if (ownerId && ownerId !== interaction.user.id) {
    await replyToClick(interaction, errorEmbed(
      'Niet jouw bevestiging',
      'Alleen degene die `/gang verwijderen` uitvoerde mag deze knop gebruiken.'
        + ' Voer het commando zelf uit als je deze gang wilt verwijderen.',
    ));
    return true;
  }

  if (prefix === BUTTON.CANCEL) {
    const confirmId = `${BUTTON.CONFIRM_DELETE}:${parts.slice(2).join(':')}`;
    const stand = DELETE_CONFIRMS.get(confirmId);
    if (stand === 'bezig' || stand === 'afgerond') {
      // Niet liegen dat er niets gebeurd is: de verwijdering is al bevestigd. De stand
      // blijft ook staan, anders zou een volgende klik alsnog een tweede ronde starten.
      await replyToClick(interaction, warningEmbed(
        'Te laat om te annuleren',
        'Deze verwijdering is al bevestigd en kan niet meer geannuleerd worden.'
          + ' Het resultaat staat in het bericht hierboven.',
      ));
      return true;
    }
    // Annuleren verwijdert niets, dus hier geen leeftijds- of staffcontrole. De stand
    // gaat bewust op 'geannuleerd' en wordt NIET gewist: een gewiste stand is niet te
    // onderscheiden van een knop uit een vorige sessie, en die mag binnen de bedenktijd
    // nog verwijderen. Zonder deze markering gooide de bevestigknop de gang na het
    // annuleren alsnog weg.
    markConfirmHandled(confirmId, 'geannuleerd');
    await updateClickMessage(interaction, infoEmbed(
      'Geannuleerd',
      'Er is niets verwijderd; de gang blijft gewoon bestaan.',
    ), []);
    return true;
  }

  await confirmDeleteClick(interaction, parts);
  return true;
}

// ---------------------------------------------------------------------------
// /gang lijst en /gang info
// ---------------------------------------------------------------------------

/**
 * Toont het overzicht van alle gangs met hun bezetting. Zichtbaar voor iedereen.
 *
 * @param {CommandContext} ctx De context.
 * @returns {Promise<void>}
 */
async function handleLijst(ctx) {
  const countsByGangId = new Map();
  for (const gang of ctx.gangs) countsByGangId.set(gang.id, countGang(ctx.guild, gang));
  await sendEmbed(ctx.interaction, gangListEmbed(ctx.gangs, countsByGangId), { ephemeral: false });
}

/**
 * Toont de details van een gang. Zonder de optie `gang` wordt de eigen gang gepakt:
 * eerst de gang waarvan de aanroeper lid is, anders de gang waarvan hij leiding is.
 *
 * @param {CommandContext} ctx De context.
 * @returns {Promise<void>}
 */
async function handleInfo(ctx) {
  const { interaction, guild } = ctx;
  const found = resolveGangOption(ctx, false);
  if (!found.ok) {
    await sendError(interaction, found.titel || 'Gang niet gevonden', found.error);
    return;
  }

  let gang = found.gang;
  if (!gang) {
    gang = getMemberGang(ctx.member, ctx.gangs) || getLedGangs(ctx.member, ctx.gangs)[0] || null;
    if (!gang) {
      await sendError(
        interaction,
        'Geen eigen gang',
        `Je zit in geen enkele gang. Geef met de optie \`gang\` op welke gang je wilt zien. `
          + `${gangChoicesText(ctx.gangs)}`,
      );
      return;
    }
  }

  const mag = ctx.staff || isMemberOf(ctx.member, gang) || isLeaderOf(ctx.member, gang);
  if (!mag) {
    await sendError(
      interaction,
      'Geen toegang',
      `Je kunt alleen de gegevens van je eigen gang bekijken. Gebruik \`/gang lijst\` voor een`
        + ' overzicht van alle gangs.',
    );
    return;
  }

  // Beheergegevens (kanaalnamen, wie de gang aanmaakte, ontbrekende rollen) zijn er voor wie
  // de gang beheert. Een gewoon lid heeft er niets aan en krijgt de korte versie.
  const detail = ctx.staff || isLeaderOf(ctx.member, gang);
  const counts = countGang(guild, gang);
  await sendEmbed(interaction, gangInfoEmbed(gang, counts, guild, { detail }), { ephemeral: false });
}

// ---------------------------------------------------------------------------
// /gang hernoemen en /gang limiet
// ---------------------------------------------------------------------------

/**
 * Hernoemt een gang: categorie, de drie rollen en de kanalen met de slug in hun naam.
 *
 * @param {CommandContext} ctx De context.
 * @returns {Promise<void>}
 */
async function handleHernoemen(ctx) {
  const { interaction, guild } = ctx;
  if (!await ensureStaff(ctx, 'een gang hernoemen')) return;

  const naam = interaction.options.getString('naam');
  const emoji = interaction.options.getString('emoji');
  const afkorting = interaction.options.getString('afkorting');
  const afkortingWeg = interaction.options.getBoolean('afkorting_weghalen') === true;
  if (!naam && !emoji && !afkorting && !afkortingWeg) {
    await sendError(
      interaction,
      'Niets om te wijzigen',
      'Geef minstens een nieuwe `naam`, `emoji` of `afkorting` op, of zet '
        + '`afkorting_weghalen` op ja.',
    );
    return;
  }

  const found = resolveGangOption(ctx, true);
  if (!found.ok) {
    await sendError(interaction, found.titel || 'Gang niet gevonden', found.error);
    return;
  }
  if (!await deferEphemeral(interaction)) return;

  const oud = gangLabel(found.gang);
  const hadAfkorting = Boolean(found.gang.abbreviation);
  const result = await gangService.renameGang(guild, found.gang, {
    name: naam || undefined,
    emoji: emoji || undefined,
    abbreviation: afkorting || undefined,
    clearAbbreviation: afkortingWeg,
    actorId: interaction.user.id,
  });

  if (!result.ok) {
    await sendError(interaction, 'Hernoemen mislukt', result.error);
    return;
  }

  const nieuw = gangLabel(result.gang);
  // Zeggen waar de kanaalnaam vandaan komt: anders lijkt een korte kanaalnaam bij een lange
  // gangnaam een fout, en weet staff niet dat /gang hernoemen die afkorting kan weghalen.
  const herkomst = result.gang.abbreviation
    ? `afkorting \`${result.gang.abbreviation}\``
    : 'de volledige naam';
  const afkortingRegel = (afkortingWeg && hadAfkorting)
    ? '\nDe afkorting is weggehaald; de kanaalnamen komen weer uit de volledige naam.'
    : '';
  await sendEmbed(interaction, successEmbed(
    'Gang hernoemd',
    `**${oud}** heet voortaan **${nieuw}**.`
      + `\nKanaalnamen: \`${result.gang.slug}\` — uit ${herkomst}.`
      + afkortingRegel
      + (result.error ? `\n\n⚠️ ${result.error}` : ''),
  ));
  refreshDashboard(guild);
}

/**
 * Leest de limietopties en zet ze om in een patch voor de store.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction De interactie.
 * @param {object} gang Het huidige GangRecord.
 * @returns {{patch: object, regels: string[]}} De patch en de regels voor het antwoord.
 */
function buildLimitPatch(interaction, gang) {
  const velden = [
    { option: 'leden', field: 'memberLimit', label: 'Leden' },
    { option: 'bosses', field: 'bossLimit', label: 'Bosses' },
    { option: 'underbosses', field: 'underbossLimit', label: 'Underbosses' },
  ];
  const patch = {};
  const regels = [];
  for (const veld of velden) {
    const waarde = interaction.options.getInteger(veld.option);
    if (waarde === null || waarde === undefined) continue;
    patch[veld.field] = waarde;
    regels.push(`• **${veld.label}:** ${gang[veld.field]} → ${waarde}`);
  }
  return { patch, regels };
}

/**
 * Zoekt de gevallen waarin een zojuist gezette limiet meteen in de weg zit, zodat de staffer
 * dat leest voordat een leider tegen een onverwachte blokkade aanloopt.
 *
 * @param {object} gang Het bijgewerkte GangRecord.
 * @param {object} counts Verse telling uit countGang().
 * @returns {string[]} Nederlandse waarschuwingen; een lege lijst als alles past.
 */
function limitWarnings(gang, counts) {
  const regels = [];
  const leden = Number(counts?.members) || 0;

  if (leden > gang.memberLimit) {
    const teveel = leden - gang.memberLimit + 1;
    regels.push(
      `Er zitten nu ${leden} personen in ${gang.name}, meer dan de nieuwe ledenlimiet van `
        + `${gang.memberLimit}. Niemand verliest zijn rol, maar er kan pas weer iemand bij nadat `
        + `er ${teveel} persoon/personen ontslagen zijn.`,
    );
  }

  const leiding = gang.bossLimit + gang.underbossLimit;
  if (leiding > gang.memberLimit) {
    regels.push(
      `De leiding (${gang.bossLimit} bosses + ${gang.underbossLimit} underbosses = ${leiding}) `
        + `past niet binnen de ledenlimiet van ${gang.memberLimit}; boss en underboss tellen mee `
        + 'als lid. Verhoog `leden` of verlaag `bosses`/`underbosses`.',
    );
  }
  return regels;
}

/**
 * Past de limieten van een gang aan (leden, bosses en/of underbosses).
 *
 * @param {CommandContext} ctx De context.
 * @returns {Promise<void>}
 */
async function handleLimiet(ctx) {
  const { interaction, guild } = ctx;
  if (!await ensureStaff(ctx, 'de limieten van een gang aanpassen')) return;

  const found = resolveGangOption(ctx, true);
  if (!found.ok) {
    await sendError(interaction, found.titel || 'Gang niet gevonden', found.error);
    return;
  }
  const gang = found.gang;
  const { patch, regels } = buildLimitPatch(interaction, gang);
  if (!regels.length) {
    await sendError(
      interaction,
      'Niets om te wijzigen',
      'Geef minstens een van de opties `leden`, `bosses` of `underbosses` op.',
    );
    return;
  }

  const updated = store.updateGang(ctx.guildId, gang.id, patch);
  if (!updated) {
    await sendError(
      interaction,
      'Opslaan mislukt',
      `${gang.name} staat niet meer in de opslag. Voer \`/gang lijst\` uit en probeer het opnieuw.`,
    );
    return;
  }

  const counts = countGang(guild, updated);
  // Een limiet die meteen in de weg zit maakt de embed geel in plaats van groen: anders leest
  // een staffer over de waarschuwing heen en loopt de eerstvolgende aanname er alsnog op stuk.
  const meldingen = limitWarnings(updated, counts);
  const uitleg = meldingen.map((regel) => `\n\n⚠️ ${regel}`).join('');
  const kop = `Limieten aangepast — ${updated.name}`;
  const inhoud = `${regels.join('\n')}\n\nHuidige bezetting: ${formatCapacity(counts)}.${uitleg}`;
  await sendEmbed(interaction, meldingen.length
    ? warningEmbed(kop, inhoud)
    : successEmbed(kop, inhoud));
  refreshDashboard(guild);
}

// ---------------------------------------------------------------------------
// /gang promoveer en /gang degradeer
// ---------------------------------------------------------------------------

/**
 * Gedeelde afhandeling voor promoveren en degraderen. Beide commandos werken hetzelfde:
 * gang bepalen, rechten checken, en de service een trede laten opschuiven.
 *
 * De fijnmazige regels zitten bewust in membershipService: de boss regelt zijn eigen
 * underbosses, maar aan een zittende boss mag alleen staff iets veranderen.
 *
 * @param {CommandContext} ctx De context.
 * @param {'promoveer'|'degradeer'} richting Welke kant op.
 * @returns {Promise<void>} Niets.
 */
async function handleTrede(ctx, richting) {
  const { interaction, guild } = ctx;
  const omhoog = richting === 'promoveer';
  const werkwoord = omhoog ? 'promoveren' : 'degraderen';

  // Eerst het lid: de gang volgt uit wie diegene is, niet uit een losse optie.
  const target = await fetchOptionMember(ctx, 'lid');
  if (!target.ok) {
    await sendError(interaction, 'Lid niet gevonden', target.error);
    return;
  }

  const found = resolveGangOfTarget(ctx, target.member, werkwoord);
  if (!found.ok) {
    if (found.meerdere) {
      alertNoticeAsync(guild, warningEmbed(
        'Lid met meerdere gangrollen',
        `<@${target.member.id}> heeft de gangrol van **${found.meerdere.map((g) => g.name).join('**, **')}**.`
          + ` Daardoor kon <@${interaction.user.id}> diegene niet ${werkwoord}.`
          + '\n\nZet dit recht door de gangrol weg te halen die er niet hoort. Wie in twee gangs'
          + ' staat telt ook in beide mee voor de ledenlimiet en het dashboard.',
      ));
    }
    await sendError(interaction, found.titel, found.error);
    return;
  }
  if (!ctx.staff && !isBossOf(ctx.member, found.gang)) {
    await sendError(
      interaction,
      'Geen toegang',
      `Alleen staff of de boss van ${found.gang.name} mag mensen ${werkwoord}.`
        + ` ${STAFF_HINT}`,
    );
    return;
  }
  if (!await deferEphemeral(interaction)) return;

  const dienst = omhoog ? membershipService.promote : membershipService.demote;
  const result = await dienst(guild, found.gang, target.member, ctx.member, { reason: null });
  if (!result.ok) {
    await sendError(interaction, omhoog ? 'Promoveren mislukt' : 'Degraderen mislukt', result.error);
    return;
  }

  const wijzigingen = Array.isArray(result.changes) && result.changes.length
    ? `\n\n${result.changes.map((regel) => `• ${regel}`).join('\n')}`
    : '';
  await sendEmbed(interaction, successEmbed(
    omhoog ? 'Gepromoveerd' : 'Gedegradeerd',
    `<@${target.member.id}> gaat van **${result.vanLabel}** naar **${result.naarLabel}**`
      + ` bij ${found.gang.name}.${wijzigingen}`,
  ));
  logNoticeAsync(guild, actionLogEmbed(result.action, result.counts));
  refreshDashboard(guild);
}

/**
 * Subcommand `promoveer`: zet iemand een trede hoger.
 *
 * @param {CommandContext} ctx De context.
 * @returns {Promise<void>} Niets.
 */
async function handlePromoveer(ctx) {
  return handleTrede(ctx, 'promoveer');
}

/**
 * Subcommand `degradeer`: zet iemand een trede lager.
 *
 * @param {CommandContext} ctx De context.
 * @returns {Promise<void>} Niets.
 */
async function handleDegradeer(ctx) {
  return handleTrede(ctx, 'degradeer');
}

// ---------------------------------------------------------------------------
// /gang aannemen en /gang ontslaan
// ---------------------------------------------------------------------------

/**
 * Neemt iemand aan bij een gang. Er is nog maar een soort lid: wie aangenomen wordt krijgt de
 * gangrol en telt daarmee mee voor de ledenlimiet.
 * Alternatief voor een bericht in het #aangenomen-kanaal; dezelfde service.
 *
 * @param {CommandContext} ctx De context.
 * @returns {Promise<void>}
 */
async function handleAannemen(ctx) {
  const { interaction, guild } = ctx;
  const found = resolveActionGang(ctx, 'aannemen');
  if (!found.ok) {
    await sendError(interaction, found.titel || 'Welke gang?', found.error);
    return;
  }
  const gang = found.gang;
  if (!await ensureLeaderOrStaff(ctx, gang, 'iemand aannemen')) return;

  const target = await fetchOptionMember(ctx, 'lid');
  if (!target.ok) {
    await sendError(interaction, 'Lid niet gevonden', target.error);
    return;
  }
  if (!await deferEphemeral(interaction)) return;

  const result = await membershipService.hire(guild, gang, target.member, ctx.member, {
    reason: null,
    bypassLimit: false,
  });
  if (!result.ok) {
    await sendError(interaction, 'Aannemen mislukt', result.error);
    return;
  }

  await sendEmbed(interaction, successEmbed(
    'Aangenomen',
    `<@${target.member.id}> is aangenomen bij **${gang.name}**.`
      + `\n${formatCapacity(result.counts)}`,
  ));
  logActionAsync(guild, result.action, result.counts);
  announceActionAsync(guild, result.action, result.counts);
  warnIfFull(guild, gang, result.counts);
  refreshDashboard(guild);
}

/**
 * Ontslaat iemand bij een gang: alle gangrollen die de persoon heeft gaan eraf.
 *
 * @param {CommandContext} ctx De context.
 * @returns {Promise<void>}
 */
async function handleOntslaan(ctx) {
  const { interaction, guild } = ctx;
  const found = resolveActionGang(ctx, 'ontslaan');
  if (!found.ok) {
    await sendError(interaction, found.titel || 'Welke gang?', found.error);
    return;
  }
  const gang = found.gang;
  if (!await ensureLeaderOrStaff(ctx, gang, 'iemand ontslaan')) return;

  const target = await fetchOptionMember(ctx, 'lid');
  if (!target.ok) {
    await sendError(interaction, 'Lid niet gevonden', target.error);
    return;
  }
  if (!await deferEphemeral(interaction)) return;

  const result = await membershipService.fire(guild, gang, target.member, ctx.member, {
    reason: interaction.options.getString('reden'),
  });
  if (!result.ok) {
    await sendError(interaction, 'Ontslaan mislukt', result.error);
    return;
  }

  await sendEmbed(interaction, successEmbed(
    'Ontslagen',
    `<@${target.member.id}> is ontslagen bij **${gang.name}**.`
      + `${result.removedLeadership ? ' De leidingsrol is ook ingetrokken.' : ''}`
      + `\n${formatCapacity(result.counts)}`,
  ));
  logActionAsync(guild, result.action, result.counts);
  announceActionAsync(guild, result.action, result.counts);
  refreshDashboard(guild);
}

// ---------------------------------------------------------------------------
// /gang herstel en /gang historie
// ---------------------------------------------------------------------------

/**
 * Maakt ontbrekende rollen en kanalen opnieuw aan en zet alle permissies terug.
 *
 * @param {CommandContext} ctx De context.
 * @returns {Promise<void>}
 */
async function handleHerstel(ctx) {
  const { interaction, guild } = ctx;
  if (!await ensureStaff(ctx, 'een gang herstellen')) return;

  const found = resolveGangOption(ctx, true);
  if (!found.ok) {
    await sendError(interaction, found.titel || 'Gang niet gevonden', found.error);
    return;
  }
  if (!await deferEphemeral(interaction)) return;

  const gang = found.gang;
  const result = await gangService.repairGang(guild, gang, { actorId: interaction.user.id });
  const regels = Array.isArray(result.changes) && result.changes.length
    ? result.changes.map((regel) => `• ${regel}`).join('\n')
    : '• Er is niets gewijzigd.';

  if (!result.ok) {
    await sendError(
      interaction,
      'Herstel niet afgerond',
      `${result.error}\n\nWel al gedaan:\n${truncate(regels, 1500)}`,
    );
    return;
  }

  await sendEmbed(interaction, successEmbed(
    `Herstel uitgevoerd — ${gang.name}`,
    truncate(regels, 3800),
  ));
  refreshDashboard(guild);
}

/**
 * Bepaalt over welke gang de historie getoond mag worden. Staff mag alles; een leider
 * ziet alleen de gang(s) waarvan hij boss of underboss is.
 *
 * @param {CommandContext} ctx De context.
 * @returns {{ok: true, gang: object|null}|{ok: false, error: string}} De gang of een melding.
 */
function resolveHistoryGang(ctx) {
  const found = resolveGangOption(ctx, false);
  if (!found.ok) return found;
  if (ctx.staff) return { ok: true, gang: found.gang };

  const led = getLedGangs(ctx.member, ctx.gangs);
  if (!led.length) {
    return {
      ok: false,
      error: 'Alleen staff en de boss/underboss van een gang kunnen de historie bekijken.'
        + ` ${STAFF_HINT}`,
    };
  }
  if (found.gang) {
    if (!isLeaderOf(ctx.member, found.gang)) {
      return {
        ok: false,
        error: `Je geeft geen leiding aan ${found.gang.name}, dus die historie kun je niet inzien.`
          + ` Je kunt wel de historie van ${led.map((gang) => gang.name).join(' of ')} opvragen.`,
      };
    }
    return { ok: true, gang: found.gang };
  }
  if (led.length > 1) {
    return {
      ok: false,
      error: 'Je geeft leiding aan meerdere gangs. Kies met de optie `gang` welke historie je wilt zien: '
        + `${led.map((gang) => gang.name).join(', ')}.`,
    };
  }
  return { ok: true, gang: led[0] };
}

/**
 * Toont de laatste acties van een gang en/of een lid.
 *
 * @param {CommandContext} ctx De context.
 * @returns {Promise<void>}
 */
async function handleHistorie(ctx) {
  const { interaction } = ctx;
  const found = resolveHistoryGang(ctx);
  if (!found.ok) {
    await sendError(interaction, 'Historie niet beschikbaar', found.error);
    return;
  }

  const gang = found.gang;
  const lid = interaction.options.getUser('lid');
  const aantal = interaction.options.getInteger('aantal') ?? HISTORY_DEFAULT;
  const actions = store.listActions(ctx.guildId, {
    gangId: gang ? gang.id : undefined,
    targetId: lid ? lid.id : undefined,
    limit: aantal,
  });

  const embed = historyEmbed(gang, actions);
  if (lid) {
    embed.setDescription(`Gefilterd op <@${lid.id}> — ${actions.length} actie(s) gevonden.`);
  }
  await sendEmbed(interaction, embed);
}

// ---------------------------------------------------------------------------
// Commando-definitie
// ---------------------------------------------------------------------------

/**
 * Voegt de standaard `gang`-optie met autocomplete toe aan een subcommand.
 *
 * @param {import('discord.js').SlashCommandSubcommandBuilder} sub Het subcommand.
 * @param {boolean} required Is de optie verplicht?
 * @param {string} [beschrijving] Afwijkende beschrijving.
 * @returns {import('discord.js').SlashCommandSubcommandBuilder} Hetzelfde subcommand.
 */
function addGangOption(sub, required, beschrijving) {
  return sub.addStringOption((option) => option
    .setName('gang')
    .setDescription(beschrijving || 'De gang (typ om te zoeken)')
    .setRequired(required)
    .setAutocomplete(true));
}

/**
 * Bouwt de subcommands rond het aanmaken, verwijderen en tonen van gangs.
 *
 * @param {import('discord.js').SlashCommandBuilder} builder De hoofdbouwer.
 * @returns {import('discord.js').SlashCommandBuilder} Dezelfde bouwer.
 */
function addBasisSubcommands(builder) {
  builder.addSubcommand((sub) => sub
    .setName('aanmaken')
    .setDescription('Maak een nieuwe gang aan (staff)')
    .addStringOption((o) => o.setName('naam').setDescription('Naam van de gang, 2 tot 40 tekens').setRequired(true))
    .addStringOption((o) => o.setName('emoji').setDescription('Precies 1 emoji voor categorie en kanalen').setRequired(true))
    .addStringOption((o) => o.setName('afkorting').setDescription('Korte naam voor in de kanaalnamen, bv. gsf (leeg = de volledige naam)').setRequired(false))
    .addUserOption((o) => o.setName('boss').setDescription('Wie wordt meteen de boss?').setRequired(false))
    .addIntegerOption((o) => o.setName('ledenlimiet').setDescription('Max. aantal leden (leeg = de serverstandaard uit /setup limieten)').setMinValue(1).setMaxValue(100)));

  builder.addSubcommand((sub) => addGangOption(sub
    .setName('verwijderen')
    .setDescription('Verwijder een gang met alles erin (staff)'), true)
    .addBooleanOption((o) => o
      .setName('rollen_verwijderen')
      .setDescription('Ook de 3 rollen verwijderen? (standaard ja)')
      .setRequired(false)));

  builder.addSubcommand((sub) => sub
    .setName('lijst')
    .setDescription('Toon alle gangs met hun bezetting'));

  builder.addSubcommand((sub) => addGangOption(sub
    .setName('info')
    .setDescription('Toon de gegevens van een gang (leeg = je eigen gang)'), false));

  return builder;
}

/**
 * Bouwt de subcommands waarmee staff een bestaande gang beheert.
 *
 * @param {import('discord.js').SlashCommandBuilder} builder De hoofdbouwer.
 * @returns {import('discord.js').SlashCommandBuilder} Dezelfde bouwer.
 */
function addBeheerSubcommands(builder) {
  builder.addSubcommand((sub) => addGangOption(sub
    .setName('hernoemen')
    .setDescription('Wijzig de naam, emoji en/of afkorting van een gang (staff)'), true)
    .addStringOption((o) => o.setName('naam').setDescription('Nieuwe naam').setRequired(false))
    .addStringOption((o) => o.setName('emoji').setDescription('Nieuwe emoji').setRequired(false))
    .addStringOption((o) => o.setName('afkorting').setDescription('Nieuwe korte naam voor in de kanaalnamen, bv. gsf').setRequired(false))
    .addBooleanOption((o) => o.setName('afkorting_weghalen').setDescription('Haal de afkorting weg; de kanaalnamen komen weer uit de volledige naam').setRequired(false)));

  builder.addSubcommand((sub) => addGangOption(sub
    .setName('limiet')
    .setDescription('Pas de limieten van een gang aan (staff)'), true)
    .addIntegerOption((o) => o.setName('leden').setDescription('Max. aantal leden (boss en underboss tellen mee)').setMinValue(1).setMaxValue(100))
    .addIntegerOption((o) => o.setName('bosses').setDescription('Max. aantal bosses').setMinValue(1).setMaxValue(10))
    .addIntegerOption((o) => o.setName('underbosses').setDescription('Max. aantal underbosses').setMinValue(0).setMaxValue(10)));

  // Geen gang-optie: promoveren en degraderen gaan over de gang waar het gekozen lid al in
  // zit, en niemand zit in twee gangs tegelijk. Zie resolveGangOfTarget.
  builder.addSubcommand((sub) => sub
    .setName('promoveer')
    .setDescription('Een trede hoger: lid > underboss > boss')
    .addUserOption((o) => o.setName('lid').setDescription('Wie promoveer je?').setRequired(true)));

  builder.addSubcommand((sub) => sub
    .setName('degradeer')
    .setDescription('Een trede lager: boss > underboss > lid')
    .addUserOption((o) => o.setName('lid').setDescription('Wie degradeer je?').setRequired(true)));

  builder.addSubcommand((sub) => addGangOption(sub
    .setName('herstel')
    .setDescription('Maak ontbrekende rollen/kanalen opnieuw aan en herstel permissies (staff)'), true));

  return builder;
}

/**
 * Bouwt de subcommands voor aannemen, ontslaan en de historie.
 *
 * @param {import('discord.js').SlashCommandBuilder} builder De hoofdbouwer.
 * @returns {import('discord.js').SlashCommandBuilder} Dezelfde bouwer.
 */
function addLedenSubcommands(builder) {
  builder.addSubcommand((sub) => addGangOption(sub
    .setName('aannemen')
    .setDescription('Neem iemand aan bij je gang (boss/underboss of staff)')
    .addUserOption((o) => o.setName('lid').setDescription('Wie neem je aan?').setRequired(true)),
  false, 'Bij welke gang? (leeg = je eigen gang)'));

  // LET OP: Discord eist dat verplichte opties vóór optionele staan, anders wordt de hele
  // registratie geweigerd (50035). De optionele `gang` gaat er daarom na `lid` op.
  builder.addSubcommand((sub) => addGangOption(sub
    .setName('ontslaan')
    .setDescription('Ontsla iemand bij je gang (boss/underboss of staff)')
    .addUserOption((o) => o.setName('lid').setDescription('Wie ontsla je?').setRequired(true)),
  false, 'Bij welke gang? (leeg = je eigen gang)')
    .addStringOption((o) => o
      .setName('reden')
      .setDescription('Reden voor in het logboek')
      .setMaxLength(400)
      .setRequired(false)));

  builder.addSubcommand((sub) => addGangOption(sub
    .setName('historie')
    .setDescription('Toon de laatste acties (staff of gangleiding)'), false)
    .addUserOption((o) => o.setName('lid').setDescription('Alleen acties van dit lid').setRequired(false))
    .addIntegerOption((o) => o
      .setName('aantal')
      .setDescription('Hoeveel acties? (1 t/m 25, standaard 10)')
      .setMinValue(1)
      .setMaxValue(25)
      .setRequired(false)));

  return builder;
}

/**
 * De volledige /gang-definitie. Bewust GEEN setDefaultMemberPermissions op de root:
 * gangleiders moeten `info`, `aannemen` en `ontslaan` kunnen gebruiken. De
 * rechtencontrole gebeurt per subcommand in code.
 *
 * @returns {SlashCommandBuilder} De opgebouwde definitie.
 */
function buildData() {
  const builder = new SlashCommandBuilder()
    .setName('gang')
    .setDescription('Beheer de gangs op deze server')
    .setContexts(InteractionContextType.Guild);

  addBasisSubcommands(builder);
  addBeheerSubcommands(builder);
  addLedenSubcommands(builder);
  return builder;
}

/** @type {SlashCommandBuilder} De /gang-definitie voor deploy-commands.js. */
const data = buildData();

/** Koppeling van subcommandnaam naar handler. */
const HANDLERS = {
  aanmaken: handleAanmaken,
  verwijderen: handleVerwijderen,
  lijst: handleLijst,
  info: handleInfo,
  hernoemen: handleHernoemen,
  limiet: handleLimiet,
  promoveer: handlePromoveer,
  degradeer: handleDegradeer,
  aannemen: handleAannemen,
  ontslaan: handleOntslaan,
  herstel: handleHerstel,
  historie: handleHistorie,
};

// ---------------------------------------------------------------------------
// Entrypoints
// ---------------------------------------------------------------------------

/**
 * Voert /gang uit: bepaalt het subcommand, bouwt de context en roept de juiste
 * handler aan. Elke onverwachte fout wordt opgevangen en netjes gemeld, zodat de
 * bot nooit crasht op een gebruikersactie.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction De interactie.
 * @returns {Promise<void>}
 */
async function execute(interaction) {
  if (!interaction.inGuild() || !interaction.guild) {
    await sendError(
      interaction,
      'Alleen in een server',
      'Dit commando werkt alleen in de server zelf, niet in een privebericht.',
    );
    return;
  }

  const sub = interaction.options.getSubcommand(false);
  const handler = sub ? HANDLERS[sub] : null;
  if (!handler) {
    await sendError(
      interaction,
      'Onbekend subcommando',
      `Ik ken het subcommando \`${truncate(String(sub || 'onbekend'), 60)}\` niet.`
        + ' Gebruik `/gang lijst` voor een overzicht.',
    );
    return;
  }

  try {
    const ctx = await buildContext(interaction);
    await handler(ctx);
  } catch (err) {
    logger.error(`/gang ${sub}: onverwachte fout.`, err);
    await sendError(
      interaction,
      'Er ging iets mis',
      `Het commando kon niet afgerond worden (${truncate(String(err?.message || err), 200)}).`
        + ' Probeer het opnieuw; blijft het misgaan, meld het dan bij de staff.',
    );
  }
}

/**
 * Vult de suggesties voor de `gang`-optie: filtert op de ingetypte tekst over naam en
 * slug, toont maximaal 25 keuzes als "emoji naam" en levert de slug als waarde.
 * Fouten worden stil afgevangen (Discord toont dan simpelweg geen suggesties).
 *
 * @param {import('discord.js').AutocompleteInteraction} interaction De autocomplete-interactie.
 * @returns {Promise<void>}
 */
async function autocomplete(interaction) {
  let choices = [];
  try {
    const focused = interaction.options.getFocused(true);
    if (focused && focused.name === 'gang' && interaction.guildId) {
      const needle = String(focused.value || '').trim().toLowerCase();
      // Dezelfde grens als in resolveGangOption: wie geen staff is ziet alleen zijn eigen
      // gang in de suggesties.
      const staff = isStaff(interaction.member, store.getGuildConfig(interaction.guildId));
      choices = store.listGangs(interaction.guildId)
        .filter((gang) => gang && (gang.name || gang.slug))
        .filter((gang) => staff
          || isMemberOf(interaction.member, gang)
          || isLeaderOf(interaction.member, gang))
        .filter((gang) => !needle
          || String(gang.name || '').toLowerCase().includes(needle)
          || String(gang.slug || '').toLowerCase().includes(needle))
        .sort((a, b) => matchRank(a, needle) - matchRank(b, needle)
          || String(a.name || '').localeCompare(String(b.name || '')))
        .slice(0, MAX_AUTOCOMPLETE_CHOICES)
        .map((gang) => ({
          name: truncate(`${gang.emoji || ''} ${gang.name || gang.slug}`.trim(), MAX_CHOICE_NAME),
          value: String(gang.slug || gang.id).slice(0, MAX_CHOICE_NAME),
        }));
    }
  } catch (err) {
    logger.debug(`/gang autocomplete: ${err?.message || err}`);
    choices = [];
  }

  try {
    await interaction.respond(choices);
  } catch (err) {
    // Verlopen of al beantwoorde autocomplete: stil negeren, dit raakt de gebruiker niet.
    logger.debug(`/gang autocomplete: antwoorden mislukt (${err?.message || err}).`);
  }
}

/**
 * Sorteerhulp voor autocomplete: treffers aan het begin van naam of slug eerst.
 *
 * @param {object} gang Het GangRecord.
 * @param {string} needle De ingetypte tekst (lowercase).
 * @returns {number} 0 voor een treffer aan het begin, anders 1.
 */
function matchRank(gang, needle) {
  if (!needle) return 0;
  const name = String(gang.name || '').toLowerCase();
  const slug = String(gang.slug || '').toLowerCase();
  return name.startsWith(needle) || slug.startsWith(needle) ? 0 : 1;
}

// handleButton hoort bij de export: events/interactionCreate.js geeft de knoppen van
// /gang verwijderen hierheen door en handelt ze zelf niet meer af (één eigenaar).
module.exports = { data, execute, autocomplete, handleButton };
