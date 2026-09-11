// src/commands/setup.js
// /setup — de serverconfiguratie van het gangbeheer (kanalen, staffrol, gedeelde
// categorieen, standaardlimieten en het dashboard).
//
// Dit bestand bevat bewust GEEN businesslogica: het valideert de invoer, schrijft naar
// de store en laat het echte werk over aan gangService en dashboardService. Alle
// antwoorden zijn ephemeral, elke Discord-call staat in een try/catch en elke
// cache-lookup wordt als mogelijk undefined behandeld.

const {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');

const logger = require('../lib/logger');
const store = require('../store');
const embeds = require('../lib/embeds');
const permissions = require('../lib/permissions');
const gangService = require('../services/gangService');
const dashboardService = require('../services/dashboardService');

/* -------------------------------------------------------------------------- */
/* Constanten                                                                  */
/* -------------------------------------------------------------------------- */

/** Kanaaltypen waarin de bot kan lezen en posten. */
const TEXT_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

/**
 * Rechten die de bot nodig heeft in een #aangenomen- of #ontslagen-kanaal.
 *
 * ManageRoles hoort er nadrukkelijk bij: zonder dat recht IN het kanaal zelf kan de bot daar
 * geen rechtenregels zetten en blijft het register voor iedereen openstaan. Discord meldt dat
 * niet vooraf - de call faalt pas bij het dichtzetten - dus /setup kanalen waarschuwt er hier
 * zelf voor, meteen bij het koppelen.
 */
const FLOW_CHANNEL_PERMS = [
  { flag: PermissionFlagsBits.ViewChannel, label: 'Kanaal bekijken' },
  { flag: PermissionFlagsBits.ReadMessageHistory, label: 'Berichtgeschiedenis lezen' },
  { flag: PermissionFlagsBits.SendMessages, label: 'Berichten versturen' },
  { flag: PermissionFlagsBits.AddReactions, label: 'Reacties toevoegen' },
  { flag: PermissionFlagsBits.EmbedLinks, label: 'Links insluiten' },
  {
    flag: PermissionFlagsBits.ManageRoles,
    label: 'Rollen beheren (nodig om het kanaal dicht te zetten)',
  },
];

/** Rechten die de bot nodig heeft in een logboek- of dashboardkanaal. */
const POST_CHANNEL_PERMS = [
  { flag: PermissionFlagsBits.ViewChannel, label: 'Kanaal bekijken' },
  { flag: PermissionFlagsBits.SendMessages, label: 'Berichten versturen' },
  { flag: PermissionFlagsBits.EmbedLinks, label: 'Links insluiten' },
];

/** De drie kanaalinstellingen van /setup kanalen. */
const CHANNEL_PICKS = [
  { option: 'aangenomen', key: 'hireChannelId', label: 'Aangenomen', perms: FLOW_CHANNEL_PERMS },
  { option: 'ontslagen', key: 'fireChannelId', label: 'Ontslagen', perms: FLOW_CHANNEL_PERMS },
  { option: 'logboek', key: 'logChannelId', label: 'Logboek', perms: POST_CHANNEL_PERMS },
];

/** Wat er minimaal ingesteld moet zijn voordat de bot volledig werkt. */
const CHECKLIST_ITEMS = [
  { key: 'hireChannelId', kind: 'channel', label: 'Aangenomen-kanaal', hint: '/setup kanalen' },
  { key: 'fireChannelId', kind: 'channel', label: 'Ontslagen-kanaal', hint: '/setup kanalen' },
  { key: 'logChannelId', kind: 'channel', label: 'Logkanaal', hint: '/setup kanalen' },
  { key: 'staffRoleId', kind: 'role', label: 'Staffrol', hint: '/setup staffrol' },
];

/**
 * De twee kanalen die samen het openbare register vormen. De bot zet ze dicht: iedereen
 * mag ze zien en teruglezen, maar alleen boss, underboss, staff, de extrarollen en de bot
 * zelf mogen er typen. `optie` is de optienaam van `/setup kanalen`, zodat elke melding
 * meteen de oplossing kan noemen.
 */
const FLOW_SETTINGS = [
  { key: 'hireChannelId', label: 'Aangenomen', optie: 'aangenomen' },
  { key: 'fireChannelId', label: 'Ontslagen', optie: 'ontslagen' },
];

/** De configuratievelden van FLOW_SETTINGS, om snel te zien of een keuze het register raakt. */
const FLOW_KEYS = FLOW_SETTINGS.map((item) => item.key);

/** Rechten die @everyone in een registerkanaal NIET meer mag hebben zodra het dichtstaat. */
const FLOW_LOCKED_DENY = [
  { flag: PermissionFlagsBits.SendMessages, label: 'berichten versturen' },
  { flag: PermissionFlagsBits.SendMessagesInThreads, label: 'in threads typen' },
  { flag: PermissionFlagsBits.CreatePublicThreads, label: 'openbare threads starten' },
  { flag: PermissionFlagsBits.CreatePrivateThreads, label: 'privéthreads starten' },
];

/** Rechten die @everyone juist MOET houden: het register hoort openbaar leesbaar te zijn. */
const FLOW_LOCKED_ALLOW = [
  { flag: PermissionFlagsBits.ViewChannel, label: 'kanaal bekijken' },
  { flag: PermissionFlagsBits.ReadMessageHistory, label: 'berichtgeschiedenis lezen' },
];

/** Vaste uitleg bij een dichtgezet register; hoort in elk antwoord dat die rechten zet. */
const FLOW_EXPLANATION = [
  'Alleen **boss** en **underboss** van een gang, de **staffrol**, de **extrarollen** '
    + '(`/setup extrarollen`) en de bot zelf kunnen hier nog typen.',
  'Iedereen met een **gangrol** ziet de kanalen staan en leest de hele geschiedenis terug, '
    + 'maar kan er niets in zetten — het blijft een register voor de gangs onderling.',
  '**@everyone** ziet ze niet meer staan: wie in geen enkele gang zit, komt er niet in.',
  'Threads staan ook dicht, anders typt iemand er simpelweg in een thread omheen.',
];

/** Wat een leidingkanaal betekent, in gewone taal voor in de antwoorden. */
const LEADER_EXPLANATION = [
  'Alleen **boss** en **underboss** van elke gang, de **staffrol**, de **extrarollen** '
    + '(`/setup extrarollen`) en de bot zelf zien dit kanaal en kunnen er typen.',
  'Gewone gangleden zien het kanaal **niet staan** — anders dan bij `#aangenomen` en '
    + '`#ontslagen`, waar de hele gang meeleest.',
  'Threads staan dicht, anders typt iemand er simpelweg in een thread omheen.',
  'Serverbeheerders (het recht *Beheerder*) komen overal bij; dat kan Discord niet blokkeren.',
];

/** Maximaal aantal registerwaarschuwingen in één veld, en het tekenbudget daarvoor. */
const MAX_FLOW_WARNINGS = 3;
const FLOW_WARNING_BUDGET = 780;

/** Maximaal aantal gedeelde categorieen dat in een overzicht getoond wordt. */
const MAX_SHARED_SHOWN = 15;

/** Maximaal aantal rollen dat in een overzicht getoond wordt. */
const MAX_ROLES_SHOWN = 15;

/** Maximale lengte van een embedveld. */
const MAX_FIELD_LENGTH = 1024;

/* -------------------------------------------------------------------------- */
/* Kleine helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Haalt een kanaal veilig uit de guild-cache.
 *
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @param {string|null|undefined} channelId Kanaal-id.
 * @returns {import('discord.js').GuildChannel|null} Het kanaal, of null.
 */
function resolveGuildChannel(guild, channelId) {
  if (!guild || !channelId || typeof channelId !== 'string') return null;
  try {
    return guild.channels?.cache?.get(channelId) || null;
  } catch {
    return null;
  }
}

/**
 * Haalt een rol veilig uit de guild-cache.
 *
 * @param {import('discord.js').Guild|null|undefined} guild De server.
 * @param {string|null|undefined} roleId Rol-id.
 * @returns {import('discord.js').Role|null} De rol, of null.
 */
function resolveGuildRole(guild, roleId) {
  if (!guild || !roleId || typeof roleId !== 'string') return null;
  try {
    return guild.roles?.cache?.get(roleId) || null;
  } catch {
    return null;
  }
}

/**
 * Zoekt de gang waar een rol bij hoort: de gangrol zelf, de bossrol of de underbossrol.
 * Gooit nooit; kan de opslag niet gelezen worden, dan gaan we ervan uit dat het geen gangrol is.
 *
 * @param {string} guildId Discord server-id.
 * @param {string} roleId Rol-id.
 * @returns {object|null} Het GangRecord, of null als de rol bij geen enkele gang hoort.
 */
function gangOfRole(guildId, roleId) {
  try {
    return store.getGangByRoleId(guildId, roleId) || null;
  } catch (err) {
    logger.warn(`Kon niet nagaan of rol ${roleId} bij een gang hoort.`, err);
    return null;
  }
}

/**
 * Beschrijft een ingesteld kanaal als mention, met een notitie als het niet meer bestaat.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {string|null} channelId Kanaal-id uit de configuratie.
 * @returns {string} Regel voor in een embed.
 */
function describeChannel(guild, channelId) {
  if (!channelId) return '— *niet ingesteld*';
  return resolveGuildChannel(guild, channelId)
    ? `<#${channelId}>`
    : `<#${channelId}> *(bestaat niet meer)*`;
}

/**
 * Beschrijft een ingestelde rol als mention, met een notitie als hij niet meer bestaat.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {string|null} roleId Rol-id uit de configuratie.
 * @returns {string} Regel voor in een embed.
 */
function describeRole(guild, roleId) {
  if (!roleId) return '— *niet ingesteld*';
  return resolveGuildRole(guild, roleId)
    ? `<@&${roleId}>`
    : `<@&${roleId}> *(bestaat niet meer)*`;
}

/**
 * Bepaalt welke kanaalrechten de bot mist in een specifiek kanaal.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {import('discord.js').GuildChannel|null} channel Het kanaal.
 * @param {Array<{flag: bigint, label: string}>} required Vereiste rechten.
 * @returns {string[]} Nederlandse namen van de ontbrekende rechten.
 */
function missingChannelPermissions(guild, channel, required) {
  const alles = required.map((entry) => entry.label);
  try {
    const me = guild?.members?.me;
    if (!me || !channel || typeof channel.permissionsFor !== 'function') return alles;
    const perms = channel.permissionsFor(me);
    if (!perms || typeof perms.has !== 'function') return alles;
    return required.filter((entry) => !perms.has(entry.flag)).map((entry) => entry.label);
  } catch {
    return alles;
  }
}

/**
 * Stelt het antwoord uit zodat er ruimte is voor tragere Discord-calls.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction De interactie.
 * @returns {Promise<boolean>} true als er (al) uitgesteld is.
 */
async function deferEphemeral(interaction) {
  if (interaction.deferred || interaction.replied) return true;
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return true;
  } catch (err) {
    logger.warn('Kon het antwoord op /setup niet uitstellen.', err);
    return false;
  }
}

/**
 * Antwoordt altijd ephemeral, ongeacht of er al uitgesteld is. Gooit nooit.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction De interactie.
 * @param {import('discord.js').EmbedBuilder} embed De te tonen embed.
 * @returns {Promise<void>}
 */
async function respond(interaction, embed) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ embeds: [embed] });
    } else {
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
    logger.warn('Kon niet antwoorden op /setup.', err);
  }
}

/**
 * Voegt een veld toe en geeft nooit een lege waarde door (Discord weigert die).
 *
 * @param {import('discord.js').EmbedBuilder} embed De embed.
 * @param {string} name Veldnaam.
 * @param {string|string[]} value Veldwaarde of losse regels.
 * @param {boolean} [inline=false] Naast elkaar tonen.
 * @returns {import('discord.js').EmbedBuilder} Dezelfde embed.
 */
function addField(embed, name, value, inline = false) {
  const tekst = Array.isArray(value) ? value.filter(Boolean).join('\n') : value;
  const veilig = tekst && String(tekst).trim() ? String(tekst).slice(0, MAX_FIELD_LENGTH) : '—';
  embed.addFields({ name: String(name).slice(0, 256), value: veilig, inline: Boolean(inline) });
  return embed;
}

/**
 * Leest de serverconfiguratie zonder te gooien.
 *
 * @param {string} guildId Discord server-id.
 * @returns {object|null} De configuratie, of null bij een leesfout.
 */
function readConfig(guildId) {
  try {
    return store.getGuildConfig(guildId);
  } catch (err) {
    logger.error(`Kon de configuratie van server ${guildId} niet lezen.`, err);
    return null;
  }
}

/**
 * Schrijft een configuratiepatch zonder te gooien.
 *
 * @param {string} guildId Discord server-id.
 * @param {object} patch De te wijzigen velden.
 * @returns {object|null} De nieuwe configuratie, of null bij een schrijffout.
 */
function writeConfig(guildId, patch) {
  try {
    return store.setGuildConfig(guildId, patch);
  } catch (err) {
    logger.error(`Kon de configuratie van server ${guildId} niet opslaan.`, err);
    return null;
  }
}

/**
 * Standaard foutmelding als lezen of schrijven van de opslag niet lukte.
 *
 * @returns {import('discord.js').EmbedBuilder} Foutembed.
 */
function saveFailedEmbed() {
  return embeds.errorEmbed(
    'Opslaan mislukt',
    'De instelling kon niet naar `data/owc.json` geschreven worden. '
      + 'Controleer of de bot schrijfrechten heeft op de datamap en probeer het opnieuw.',
  );
}

/* -------------------------------------------------------------------------- */
/* Schrijfrechten van #aangenomen en #ontslagen                                */
/* -------------------------------------------------------------------------- */

/**
 * Kort een lijst meldingen in zodat hij zeker in één embedveld past (Discord kapt af op
 * 1024 tekens en de meldingen van gangService zijn lang).
 *
 * @param {string[]} lines De meldingen.
 * @param {number} maxLines Maximaal aantal meldingen dat getoond wordt.
 * @returns {string[]} De te tonen regels, eventueel met een slotregel over de rest.
 */
function limitLines(lines, maxLines) {
  const veilig = (Array.isArray(lines) ? lines : []).filter(Boolean).map(String);
  const gekozen = [];
  let lengte = 0;

  for (const regel of veilig) {
    if (gekozen.length >= maxLines) break;
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
 * Zet de schrijfrechten van het aanname- en ontslagkanaal (opnieuw) via gangService.
 *
 * Gooit nooit en geeft altijd dezelfde vorm terug. Zo kan een mislukte Discord-call het
 * opslaan van de configuratie niet ongedaan maken: de melding belandt als waarschuwing in
 * dezelfde embed en het commando gaat gewoon door.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @returns {Promise<{ok: boolean, kanalen: string[], waarschuwingen: string[],
 *   error: string|null}>} Welke kanalen dichtgezet zijn en wat er nagelopen moet worden.
 */
async function applyFlowPermissions(guild) {
  try {
    const result = await gangService.applyFlowChannelPermissions(guild);
    return {
      ok: Boolean(result?.ok),
      kanalen: Array.isArray(result?.kanalen) ? result.kanalen.filter(Boolean).map(String) : [],
      waarschuwingen: Array.isArray(result?.waarschuwingen)
        ? result.waarschuwingen.filter(Boolean).map(String)
        : [],
      error: result?.error ? String(result.error) : null,
    };
  } catch (err) {
    logger.error('Kon de schrijfrechten van het aanname-/ontslagkanaal niet zetten.', err);
    return {
      ok: false,
      kanalen: [],
      waarschuwingen: [],
      error: 'De schrijfrechten van #aangenomen en #ontslagen konden niet gezet worden '
        + `(${err?.message || 'onbekende fout'}). De instelling zelf is wél opgeslagen. Geef de `
        + 'botrol in Kanaalinstellingen → Rechten "Kanaal bekijken" en "Rollen beheren" en voer '
        + 'dit commando daarna opnieuw uit.',
    };
  }
}

/**
 * Bepaalt welke registerkanalen door deze wijziging losgekoppeld raken.
 *
 * WAAROM DIT MOET: koppelt staff een ANDER aanname- of ontslagkanaal, dan blijft het oude kanaal
 * anders voor altijd dichtstaan. applyFlowChannelPermissions kijkt namelijk alleen naar het
 * kanaal dat NU gekoppeld is, dus niemand kan daar ooit nog typen en geen enkel commando zet dat
 * terug. Een kanaal dat na de wijziging nog steeds register is (bijvoorbeeld omdat het aanname-
 * en ontslagkanaal omgewisseld zijn) blijft er bewust buiten.
 *
 * @param {object} huidig De configuratie van voor de wijziging.
 * @param {object} samen De configuratie zoals hij na de wijziging is.
 * @returns {string[]} Kanaal-ids die geen register meer zijn, zonder dubbelen.
 */
function releasedFlowChannelIds(huidig, samen) {
  const nogInGebruik = FLOW_KEYS.map((key) => samen?.[key]).filter(Boolean);
  const los = [];
  for (const key of FLOW_KEYS) {
    const oud = huidig?.[key];
    if (!oud || nogInGebruik.includes(oud) || los.includes(oud)) continue;
    los.push(oud);
  }
  return los;
}

/**
 * Heft de vergrendeling op van kanalen die geen register meer zijn, via gangService.
 * Gooit nooit: een mislukking is een waarschuwing bij een verder geslaagde wijziging.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {string[]} channelIds Kanaal-ids uit releasedFlowChannelIds.
 * @returns {Promise<{regels: string[], waarschuwingen: string[]}>} Wat er vrijgegeven is en wat
 *   er met de hand nagelopen moet worden.
 */
async function releaseOldFlowChannels(guild, channelIds) {
  const regels = [];
  const waarschuwingen = [];

  for (const id of channelIds) {
    let result = null;
    try {
      result = await gangService.releaseFlowChannel(guild, id);
    } catch (err) {
      logger.error(`Kon de vergrendeling van kanaal ${id} niet opheffen.`, err);
      waarschuwingen.push(
        `⚠️ De vergrendeling van <#${id}> kon niet opgeheven worden `
          + `(${err?.message || 'onbekende fout'}). Haal in Kanaalinstellingen → Rechten van dat `
          + 'kanaal de regel voor @everyone weg, anders kan daar niemand meer typen.',
      );
      continue;
    }

    const verwijderd = Number(result?.verwijderd) || 0;
    // Bestaat het kanaal niet meer, dan staat er ook niets meer dicht: niets te melden.
    if (!result?.kanaal && !verwijderd && !result?.error) continue;

    const naam = result?.kanaal || `<#${id}>`;
    if (result?.error) waarschuwingen.push(`⚠️ ${result.error}`);
    if (verwijderd) {
      regels.push(`${naam}: ${verwijderd} rechtenregel(s) van de bot teruggedraaid, dus daar kan `
        + 'weer getypt worden.');
    } else if (!result?.error) {
      regels.push(`${naam}: er stond niets meer van de bot dicht, dus daar hoefde niets terug.`);
    }
  }
  return { regels, waarschuwingen };
}

/**
 * Bepaalt of er bij het dichtzetten iets te melden viel.
 *
 * @param {{waarschuwingen?: string[], error?: string|null}|null} flow Resultaat van
 *   applyFlowPermissions, of null als er niets gezet is.
 * @returns {boolean} true als er iets nagelopen moet worden (dan hoort de embed geel).
 */
function flowHasWarnings(flow) {
  if (!flow) return false;
  return Boolean(flow.error) || Boolean(flow.waarschuwingen && flow.waarschuwingen.length);
}

/**
 * Zet het resultaat van applyFlowPermissions als velden in de embed: wat er dichtgezet is,
 * wat dat betekent, en wat de beheerder zelf nog moet nalopen.
 *
 * @param {import('discord.js').EmbedBuilder} embed De embed.
 * @param {{ok: boolean, kanalen: string[], waarschuwingen: string[], error: string|null}|null}
 *   flow Resultaat van applyFlowPermissions, of null als er niets gezet is.
 * @returns {boolean} true als er waarschuwingen getoond zijn.
 */
function addFlowResultFields(embed, flow) {
  if (!flow) return false;

  if (flow.kanalen.length) {
    addField(embed, 'Register dichtgezet', [
      `Dichtgezet: ${flow.kanalen.join(' en ')}.`,
      ...FLOW_EXPLANATION,
    ]);
  } else {
    addField(embed, 'Register nog niet dichtgezet', [
      'Er is nog geen bestaand aanname- of ontslagkanaal waarin de bot de schrijfrechten kon '
        + 'zetten, dus daar kan voorlopig iedereen typen.',
      'Koppel ze met `/setup kanalen aangenomen: #kanaal ontslagen: #kanaal`; de bot zet '
        + 'ze dan meteen dicht.',
    ]);
  }

  const regels = [...flow.waarschuwingen];
  if (flow.error) regels.unshift(flow.error);
  if (!regels.length) return false;

  addField(embed, 'Even nalopen in de kanaalinstellingen', [
    ...limitLines(regels, MAX_FLOW_WARNINGS),
    'Dit zijn geen fouten van de bot: rechten die iemand zelf op een kanaal heeft gezet laat '
      + 'hij bewust staan (ze kunnen ergens anders voor bedoeld zijn), en een kanaal dat nog niet '
      + 'gekoppeld is kan hij niet dichtzetten.',
  ]);
  return true;
}

/**
 * Kijkt per registerkanaal of @everyone er echt niet meer in kan typen én nog wel kan
 * meelezen. Puur lezend: dit verandert niets aan Discord.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} config De serverconfiguratie.
 * @returns {{lines: string[], open: number}} De regels en het aantal punten dat aandacht vraagt.
 */
function buildFlowLockLines(guild, config) {
  const lines = [];
  let open = 0;
  const everyone = guild?.roles?.everyone || null;

  for (const item of FLOW_SETTINGS) {
    const id = config ? config[item.key] : null;
    const koppel = `\`/setup kanalen ${item.optie}: #kanaal\``;

    if (!id) {
      open += 1;
      lines.push(`❌ ${item.label} — nog geen kanaal ingesteld, dus er staat niets dicht. `
        + `Stel het in met ${koppel}.`);
      continue;
    }

    const channel = resolveGuildChannel(guild, id);
    if (!channel) {
      open += 1;
      lines.push(`⚠️ ${item.label} — <#${id}> bestaat niet meer. Koppel het juiste kanaal `
        + `met ${koppel}; dan zet de bot het meteen dicht.`);
      continue;
    }

    let perms = null;
    try {
      perms = everyone && typeof channel.permissionsFor === 'function'
        ? channel.permissionsFor(everyone)
        : null;
    } catch {
      perms = null;
    }
    if (!perms || typeof perms.has !== 'function') {
      open += 1;
      lines.push(`⚠️ ${item.label} — de rechten van <#${id}> zijn niet uit te lezen. Geef de `
        + 'botrol "Kanaal bekijken" in dat kanaal en voer `/setup toon` opnieuw uit.');
      continue;
    }

    const nogOpen = FLOW_LOCKED_DENY.filter((e) => perms.has(e.flag)).map((e) => e.label);
    const kwijt = FLOW_LOCKED_ALLOW.filter((e) => !perms.has(e.flag)).map((e) => e.label);

    if (nogOpen.length) {
      open += 1;
      lines.push(`❌ ${item.label} — <#${id}> staat nog open: @everyone mag er `
        + `${nogOpen.join(', ')}. Voer ${koppel} opnieuw uit om het dicht te zetten.`);
    } else if (kwijt.length) {
      open += 1;
      lines.push(`⚠️ ${item.label} — <#${id}> staat dicht, maar @everyone mist ook `
        + `${kwijt.join(' en ')}. Zet die rechten terug in de kanaalinstellingen: het `
        + 'register hoort voor iedereen leesbaar te blijven.');
    } else {
      lines.push(`✅ ${item.label} — <#${id}> staat dicht en blijft leesbaar voor iedereen.`);
    }
  }
  return { lines, open };
}

/* -------------------------------------------------------------------------- */
/* /setup kanalen                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Verzamelt en valideert de gekozen kanalen van /setup kanalen.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction De interactie.
 * @returns {{patch: object, chosen: Array<object>, error: string|null}} De patch, de keuzes
 *   en een Nederlandse foutmelding als de invoer niet klopt.
 */
function collectChannelPicks(interaction) {
  const patch = {};
  const chosen = [];

  for (const pick of CHANNEL_PICKS) {
    let picked = null;
    try {
      picked = interaction.options.getChannel(pick.option);
    } catch {
      picked = null;
    }
    if (!picked) continue;

    const channel = resolveGuildChannel(interaction.guild, picked.id) || picked;
    if (!TEXT_CHANNEL_TYPES.includes(channel.type)) {
      return {
        patch: {},
        chosen: [],
        error: `<#${channel.id}> is geen gewoon tekstkanaal. `
          + `Kies voor \`${pick.option}\` een tekstkanaal.`,
      };
    }
    patch[pick.key] = channel.id;
    chosen.push({ ...pick, channel });
  }

  if (!chosen.length) {
    return {
      patch: {},
      chosen: [],
      error: 'Geef minstens één kanaal op: `aangenomen`, `ontslagen` of `logboek`.',
    };
  }
  return { patch, chosen, error: null };
}

/**
 * Subcommand `kanalen`: stelt het aanname-, ontslag- en logkanaal in.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction De interactie.
 * @returns {Promise<void>}
 */
async function handleKanalen(interaction) {
  // Uitstellen: het dichtzetten van het register kost een paar Discord-calls.
  if (!(await deferEphemeral(interaction))) return;
  const guild = interaction.guild;
  const { patch, chosen, error } = collectChannelPicks(interaction);
  if (error) return respond(interaction, embeds.errorEmbed('Kanalen niet opgeslagen', error));

  const huidig = readConfig(guild.id);
  if (!huidig) return respond(interaction, saveFailedEmbed());

  const samen = { ...huidig, ...patch };
  if (samen.hireChannelId && samen.hireChannelId === samen.fireChannelId) {
    return respond(interaction, embeds.errorEmbed(
      'Kanalen mogen niet gelijk zijn',
      'Het aanname- en het ontslagkanaal moeten verschillende kanalen zijn, anders kan de bot '
        + 'niet bepalen of iemand aangenomen of ontslagen wordt.',
    ));
  }

  if (!writeConfig(guild.id, patch)) return respond(interaction, saveFailedEmbed());

  const waarschuwingen = [];
  for (const pick of chosen) {
    const missend = missingChannelPermissions(guild, pick.channel, pick.perms);
    if (missend.length) {
      waarschuwingen.push(`⚠️ In <#${pick.channel.id}> mist de bot: ${missend.join(', ')}.`);
    }
  }

  const raaktRegister = chosen.some((pick) => FLOW_KEYS.includes(pick.key));

  // Eerst het kanaal dat GEEN register meer is weer vrijgeven. Doen we dat niet, dan blijft dat
  // kanaal voor altijd dichtstaan: het dichtzetten hieronder raakt alleen het kanaal dat nu
  // gekoppeld is.
  const losgekoppeld = raaktRegister
    ? await releaseOldFlowChannels(guild, releasedFlowChannelIds(huidig, samen))
    : { regels: [], waarschuwingen: [] };

  // En dan het nieuwe register dichtzetten. Mislukt dat, dan blijft de zojuist opgeslagen
  // configuratie gewoon staan en komt de melding als waarschuwing in dezelfde embed.
  const flow = raaktRegister ? await applyFlowPermissions(guild) : null;

  const letOp = waarschuwingen.length || losgekoppeld.waarschuwingen.length;
  const embed = (letOp || flowHasWarnings(flow))
    ? embeds.warningEmbed('Kanalen opgeslagen, maar let op')
    : embeds.successEmbed('Kanalen opgeslagen');
  addField(embed, 'Ingesteld', chosen.map((pick) => `**${pick.label}:** <#${pick.channel.id}>`));
  if (losgekoppeld.regels.length || losgekoppeld.waarschuwingen.length) {
    addField(embed, 'Oud register vrijgegeven', [
      ...losgekoppeld.regels,
      ...losgekoppeld.waarschuwingen,
      'Dat kanaal is geen aanname-/ontslagregister meer, dus daar hoeft niets meer dicht te staan.',
    ]);
  }
  if (waarschuwingen.length) {
    addField(embed, 'Ontbrekende kanaalrechten', [
      ...waarschuwingen,
      'Geef de botrol deze rechten in de kanaalinstellingen, anders werkt de flow niet.',
    ]);
  }
  addFlowResultFields(embed, flow);
  addField(embed, 'Zo werkt het', [
    'Leiders plaatsen in het aanname-/ontslagkanaal een bericht met een of meer mentions,',
    'bijvoorbeeld `@Jan @Piet` of `@Sara | reden: verraden`.',
    'Controleer de rest van de configuratie met `/setup toon`.',
  ]);
  return respond(interaction, embed);
}

/* -------------------------------------------------------------------------- */
/* /setup staffrol                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Subcommand `staffrol`: bepaalt welke rol als staff geldt.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction De interactie.
 * @returns {Promise<void>}
 */
async function handleStaffrol(interaction) {
  const guild = interaction.guild;
  const picked = interaction.options.getRole('rol');
  if (!picked) {
    return respond(interaction, embeds.errorEmbed(
      'Geen rol gekozen',
      'Kies een rol met de optie `rol`.',
    ));
  }
  if (picked.id === guild.id) {
    return respond(interaction, embeds.errorEmbed(
      '@everyone kan geen staffrol zijn',
      'Iedereen op de server zou dan staffrechten krijgen. Maak een aparte staffrol aan '
        + 'en kies die.',
    ));
  }

  if (!(await deferEphemeral(interaction))) return;
  if (!writeConfig(guild.id, { staffRoleId: picked.id })) {
    return respond(interaction, saveFailedEmbed());
  }

  // De nieuwe staffrol moet in #aangenomen en #ontslagen kunnen typen en er foute regels
  // kunnen opruimen. De vorige staffrol raakt haar eigen recht daar niet vanzelf kwijt;
  // dat komt terug in de waarschuwingen, zodat je het bewust kunt weghalen.
  const flow = await applyFlowPermissions(guild);

  const embed = flowHasWarnings(flow)
    ? embeds.warningEmbed('Staffrol opgeslagen, maar let op')
    : embeds.successEmbed('Staffrol opgeslagen');
  addField(embed, 'Staffrol', `<@&${picked.id}>`);
  addField(embed, 'Wat deze rol mag', [
    'Gangs aanmaken, hernoemen, herstellen en verwijderen.',
    'Limieten aanpassen en aannames forceren voorbij de limiet.',
    'Leiding toewijzen en acties terugdraaien vanuit het logboek.',
    'Leden met het serverrecht **Server beheren** blijven daarnaast altijd staff.',
  ]);
  addFlowResultFields(embed, flow);

  const notities = [];
  const role = resolveGuildRole(guild, picked.id);
  if (role?.managed) {
    notities.push('⚠️ Dit is een beheerde rol (van een bot of van boosten). '
      + 'Discord laat die niet handmatig toekennen aan je staffleden.');
  }
  let aantalGangs = 0;
  try {
    aantalGangs = (store.listGangs(guild.id) || []).length;
  } catch (err) {
    logger.warn('Kon de gangs niet lezen na het instellen van de staffrol.', err);
  }
  if (aantalGangs > 0) {
    notities.push(
      `Bestaande gangcategorieën (${aantalGangs}) krijgen deze staffrol pas als je per gang `
        + '`/gang herstel` uitvoert; dat zet alle permissies opnieuw.',
    );
  }
  if (notities.length) addField(embed, 'Let op', notities);
  return respond(interaction, embed);
}

/* -------------------------------------------------------------------------- */
/* /setup meldrol                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Subcommand `meldrol`: welke rol krijgt een ping als de bot er niet uitkomt.
 *
 * Dit is geen rechtenrol - hij geeft nergens toegang toe. Hij wordt alleen aangepingd in
 * het logkanaal bij situaties die een mens moeten hebben, zoals een lid dat de gangrol van
 * twee gangs tegelijk blijkt te hebben.
 *
 * Geen rol meegeven zet de ping weer uit; de melding zelf blijft dan gewoon komen.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction De interactie.
 * @returns {Promise<void>}
 */
async function handleMeldrol(interaction) {
  const guild = interaction.guild;
  const picked = interaction.options.getRole('rol');

  if (picked && picked.id === guild.id) {
    return respond(interaction, embeds.errorEmbed(
      '@everyone kan geen meldrol zijn',
      'Dan krijgt de hele server een ping bij elke melding. Kies de rol van je staff of'
        + ' moderatie.',
    ));
  }

  if (!(await deferEphemeral(interaction))) return;
  if (!writeConfig(guild.id, { alertRoleId: picked ? picked.id : null })) {
    return respond(interaction, saveFailedEmbed());
  }

  const config = readConfig(guild.id);
  if (!picked) {
    const uit = embeds.successEmbed('Meldrol uitgezet');
    addField(uit, 'Wat dit betekent', 'Meldingen komen nog steeds in het logkanaal, maar'
      + ' zonder ping. Niemand wordt er dus actief op gewezen.');
    return respond(interaction, uit);
  }

  const embed = embeds.successEmbed('Meldrol opgeslagen');
  addField(embed, 'Meldrol', `<@&${picked.id}>`);
  addField(embed, 'Wanneer krijgt deze rol een ping', [
    'Als een lid de gangrol van meerdere gangs tegelijk heeft en `/gang promoveer` of '
      + '`/gang degradeer` daardoor niet weet welke gang bedoeld is.',
  ]);
  addField(embed, 'Let op', [
    'Deze rol krijgt hier **geen rechten** van; hij wordt alleen aangepingd.',
    config?.logChannelId
      ? `De pings komen in <#${config.logChannelId}>.`
      : '⚠️ Er is nog geen logkanaal ingesteld, dus er is nergens om te pingen. '
        + 'Koppel er een met `/setup kanalen logboek: #kanaal`.',
  ]);
  return respond(interaction, embed);
}

/* -------------------------------------------------------------------------- */
/* /setup leidingkanaal                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Subcommand `leidingkanaal`: een kanaal waar de leiding van ALLE gangs elkaar spreekt.
 *
 * @everyone gaat dicht (ook kijken); boss en underboss van elke gang, de staffrol, de
 * extrarollen en de bot mogen er kijken en typen. Dat gebeurt met Discord-overwrites, dus
 * het blijft gelden als de bot offline is.
 *
 * Nieuwe gangs komen er vanzelf bij: bij `/gang aanmaken` worden de verse boss- en
 * underbossrol aan alle register- en leidingkanalen toegevoegd.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction De interactie.
 * @returns {Promise<void>}
 */
async function handleLeidingkanaal(interaction) {
  const guild = interaction.guild;
  const channel = interaction.options.getChannel('kanaal');
  const actie = interaction.options.getString('actie') || 'toevoegen';

  if (!channel) {
    return respond(interaction, embeds.errorEmbed(
      'Geen kanaal gekozen',
      'Kies een kanaal met de optie `kanaal`.',
    ));
  }
  if (!TEXT_CHANNEL_TYPES.includes(channel.type)) {
    return respond(interaction, embeds.errorEmbed(
      'Dit moet een tekstkanaal zijn',
      'Een leidingkanaal werkt met schrijfrechten op berichten. Kies een gewoon tekstkanaal '
        + 'of een aankondigingskanaal.',
    ));
  }

  const config = readConfig(guild.id);
  if (!config) return respond(interaction, saveFailedEmbed());

  // De twee registers hebben hun eigen commando en een andere permissieset (daar leest de
  // hele gang mee). Hetzelfde kanaal in beide lijsten zou die twee tegen elkaar in laten
  // werken: de laatste die draait wint.
  if (channel.id === config.hireChannelId || channel.id === config.fireChannelId) {
    return respond(interaction, embeds.errorEmbed(
      'Dit is al een registerkanaal',
      `<#${channel.id}> is gekoppeld met \`/setup kanalen\`. Daar mag de hele gang meelezen; `
        + 'in een leidingkanaal juist niet. Kies een ander kanaal, of koppel het eerst los.',
    ));
  }

  const huidig = Array.isArray(config.leaderChannelIds) ? config.leaderChannelIds : [];
  const staatErin = huidig.includes(channel.id);

  if (actie === 'verwijderen' && !staatErin) {
    return respond(interaction, embeds.errorEmbed(
      'Dit is geen leidingkanaal',
      `<#${channel.id}> staat niet in de lijst, dus er valt niets weg te halen. `
        + 'Bekijk de lijst met `/setup toon`.',
    ));
  }

  if (!(await deferEphemeral(interaction))) return;

  const nieuw = actie === 'verwijderen'
    ? huidig.filter((id) => id !== channel.id)
    : [...huidig, channel.id];
  if (!writeConfig(guild.id, { leaderChannelIds: nieuw })) {
    return respond(interaction, saveFailedEmbed());
  }

  if (actie === 'verwijderen') {
    // Het slot er ook echt afhalen. Zonder deze stap blijft een kanaal dat geen
    // leidingkanaal meer is voor iedereen dicht, terwijl niets in de configuratie er nog
    // naar verwijst - en dan zoekt de beheerder zich rot.
    let release = null;
    try {
      release = await gangService.releaseFlowChannel(guild, channel.id);
    } catch (err) {
      logger.error('Kon de vergrendeling van het leidingkanaal niet opheffen.', err);
    }
    const losEmbed = release?.ok
      ? embeds.successEmbed('Leidingkanaal losgekoppeld')
      : embeds.warningEmbed('Leidingkanaal losgekoppeld, maar let op');
    addField(losEmbed, 'Kanaal', `<#${channel.id}>`);
    addField(losEmbed, 'Wat er nu geldt', release?.ok
      ? [
        `De rechtenregels die de bot hier zelf had gezet zijn weggehaald (${release.verwijderd || 0}).`,
        'Het kanaal valt daarmee terug op de rechten van zijn categorie en de serverrollen. '
          + 'Controleer even of dat is wat je wilt — mogelijk kan iedereen er nu weer in.',
      ]
      : [
        release?.error || 'De vergrendeling kon niet opgeheven worden.',
        'Haal in Kanaalinstellingen → Rechten de regels voor @everyone en de gangrollen zelf weg.',
      ]);
    return respond(interaction, losEmbed);
  }

  const ontbreekt = missingChannelPermissions(guild, channel, FLOW_CHANNEL_PERMS);
  const flow = await applyFlowPermissions(guild);

  const titel = staatErin ? 'Leidingkanaal opnieuw dichtgezet' : 'Leidingkanaal opgeslagen';
  const embed = (flowHasWarnings(flow) || ontbreekt.length)
    ? embeds.warningEmbed(`${titel}, maar let op`)
    : embeds.successEmbed(titel);
  addField(embed, 'Kanaal', staatErin
    ? `<#${channel.id}> *(stond al in de lijst)*`
    : `<#${channel.id}>`);
  addField(embed, 'Wie hier binnenkomt', LEADER_EXPLANATION);
  addField(embed, 'Nieuwe gangs', 'De boss- en underbossrol van een nieuwe gang worden hier '
    + 'automatisch aan toegevoegd bij `/gang aanmaken`. Dit commando hoef je dus maar één '
    + 'keer per kanaal te draaien.');
  if (ontbreekt.length) {
    addField(embed, 'De bot mist rechten in dit kanaal', [
      `Ontbreekt: ${ontbreekt.join(', ')}.`,
      'Zonder die rechten kan de bot hier geen rechtenregels zetten en blijft het kanaal '
        + 'openstaan. Geef ze in Kanaalinstellingen → Rechten aan de botrol.',
    ]);
  }
  addFlowResultFields(embed, flow);
  return respond(interaction, embed);
}

/* -------------------------------------------------------------------------- */
/* /setup bodemrol                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Zoekt op of een rol bij een gang hoort (gangrol, boss of underboss).
 *
 * @param {string} guildId Server-id.
 * @param {string} roleId Rol-id om te controleren.
 * @returns {object|null} De gang waar de rol bij hoort, of null.
 */
function gangVanRol(guildId, roleId) {
  let gangs = [];
  try {
    gangs = store.listGangs(guildId) || [];
  } catch (err) {
    logger.warn('Kon de gangs niet lezen bij het controleren van de bodemrol.', err);
    return null;
  }
  return gangs.find((gang) => gang?.roleId === roleId
    || gang?.bossRoleId === roleId
    || gang?.underbossRoleId === roleId) || null;
}

/**
 * Zet het resultaat van de herordening in de embed, zodat meteen zichtbaar is of de
 * bestaande gangrollen ook echt verplaatst zijn.
 *
 * @param {import('discord.js').EmbedBuilder} embed De embed in aanbouw.
 * @param {{ok: boolean, verplaatst: number, error?: string|null}} resultaat Van applyRoleOrder.
 * @returns {void}
 */
function addRoleOrderResult(embed, resultaat) {
  if (!resultaat?.ok) {
    addField(embed, 'Bestaande gangrollen', resultaat?.error
      || 'De rollenlijst kon nu niet bijgewerkt worden. Probeer `/gang herstel`.');
    return;
  }
  addField(embed, 'Bestaande gangrollen', resultaat.verplaatst > 0
    ? `${resultaat.verplaatst} rol(len) verplaatst naar de nieuwe volgorde.`
    : 'Stonden al goed, er is niets verplaatst.');
}

/**
 * Subcommand `bodemrol`: legt vast onder welke rol gangrollen nooit mogen zakken.
 *
 * Discord zet een net aangemaakte rol altijd onderaan, vlak boven @everyone. Zonder
 * ondergrens blijft een nieuwe gangrol daar staan zolang er ruimte is. Met een bodemrol
 * schuift het blok gangrollen altijd tot boven die rol.
 *
 * Geen rol meegeven zet de ondergrens weer uit.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction De interactie.
 * @returns {Promise<void>}
 */
async function handleBodemrol(interaction) {
  const guild = interaction.guild;
  const picked = interaction.options.getRole('rol');

  if (picked && picked.id === guild.id) {
    return respond(interaction, embeds.errorEmbed(
      '@everyone kan geen bodemrol zijn',
      '@everyone staat altijd onderaan de rollenlijst, dus dat is precies wat er zonder '
        + 'bodemrol al gebeurt. Kies de rol waar de gangrollen bovenuit moeten steken.',
    ));
  }

  const gang = picked ? gangVanRol(guild.id, picked.id) : null;
  if (gang) {
    return respond(interaction, embeds.errorEmbed(
      'Dit is zelf een gangrol',
      `<@&${picked.id}> hoort bij de gang **${gang.name || gang.id}**. Een gangrol kan niet `
        + 'de ondergrens voor de gangrollen zijn. Kies een rol die buiten het gangbeheer valt.',
    ));
  }

  if (!(await deferEphemeral(interaction))) return;

  if (!writeConfig(guild.id, { roleFloorId: picked ? picked.id : null })) {
    return respond(interaction, saveFailedEmbed());
  }

  // Meteen toepassen, zodat de bestaande gangrollen niet tot de volgende actie blijven hangen.
  let volgorde = { ok: false, verplaatst: 0, error: null };
  try {
    volgorde = await gangService.applyRoleOrder(guild);
  } catch (err) {
    logger.warn('De rolvolgorde bijwerken na /setup bodemrol mislukte.', err);
  }

  if (!picked) {
    const uit = volgorde.ok
      ? embeds.successEmbed('Bodemrol uitgezet')
      : embeds.warningEmbed('Bodemrol uitgezet, maar let op');
    addField(uit, 'Wat dit betekent',
      'Gangrollen worden voortaan alleen nog boven @everyone gehouden. Waar ze nu staan '
        + 'blijven ze staan; nieuwe gangrollen komen weer onderaan terecht zolang daar ruimte is.');
    addRoleOrderResult(uit, volgorde);
    return respond(interaction, uit);
  }

  const embed = volgorde.ok
    ? embeds.successEmbed('Bodemrol opgeslagen')
    : embeds.warningEmbed('Bodemrol opgeslagen, maar let op');
  addField(embed, 'Bodemrol', `<@&${picked.id}> (positie ${picked.position})`);
  addField(embed, 'Wat er nu gebeurt', [
    'Nieuwe gangrollen (gangrol, boss en underboss) komen altijd boven deze rol te staan.',
    'Dat geldt ook na `/gang herstel`, hernoemen en verwijderen: de volgorde wordt elke keer '
      + 'opnieuw gezet.',
    'De rol van de bot moet wel boven alle gangrollen blijven staan, anders mag Discord ze '
      + 'niet verplaatsen.',
  ]);
  addRoleOrderResult(embed, volgorde);
  return respond(interaction, embed);
}

/* -------------------------------------------------------------------------- */
/* /setup gedeelde-categorie                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Geeft alle bestaande gangs toegang tot de gedeelde categorieen via gangService.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @returns {Promise<{gangs: number, synced: number, overwrites: number, failed: string[],
 *   notices: string[]}>} Aantal gangs, hoeveel er gelukt zijn, hoeveel overwrites er
 *   gewijzigd zijn, de mislukte gangs en de (ontdubbelde) algemene meldingen.
 */
async function syncAllGangsToShared(guild) {
  let gangs = [];
  try {
    gangs = store.listGangs(guild.id) || [];
  } catch (err) {
    logger.error('Kon de gangs niet lezen bij het synchroniseren van gedeelde categorieën.', err);
    return {
      gangs: 0,
      synced: 0,
      overwrites: 0,
      failed: ['de gangs konden niet gelezen worden'],
      notices: [],
    };
  }

  let synced = 0;
  let overwrites = 0;
  const failed = [];
  // syncSharedCategories geeft bij succes soms nog een melding over de lijst zelf; die is
  // voor elke gang identiek, dus ontdubbelen we hem.
  const notices = new Set();

  for (const gang of gangs) {
    const naam = gang?.name || `gang #${gang?.id ?? '?'}`;
    try {
      const result = await gangService.syncSharedCategories(guild, gang);
      if (result?.ok) {
        synced += 1;
        overwrites += Number(result.added) || 0;
        if (result.error) notices.add(String(result.error));
      } else {
        failed.push(`${naam}: ${result?.error || 'onbekende fout'}`);
      }
    } catch (err) {
      logger.error(`Synchroniseren van gedeelde categorieën mislukte voor ${naam}.`, err);
      failed.push(`${naam}: onverwachte fout`);
    }
  }
  return { gangs: gangs.length, synced, overwrites, failed, notices: [...notices] };
}

/**
 * Synchroniseert elk kanaal in een categorie met de permissies van die categorie.
 * LET OP: `lockPermissions()` OVERSCHRIJFT de bestaande overwrites van elk kanaal.
 *
 * @param {import('discord.js').CategoryChannel} category De categorie.
 * @returns {Promise<{total: number, synced: number, failed: string[]}>} Aantal kinderen,
 *   hoeveel er gesynchroniseerd zijn en welke niet lukten.
 */
async function lockChildPermissions(category) {
  let children = [];
  try {
    const cache = category?.children?.cache;
    children = cache ? Array.from(cache.values()) : [];
  } catch (err) {
    logger.warn('Kon de kanalen van de categorie niet uitlezen.', err);
    return { total: 0, synced: 0, failed: ['de kanalen van deze categorie waren niet leesbaar'] };
  }

  let synced = 0;
  const failed = [];
  for (const child of children) {
    if (!child || typeof child.lockPermissions !== 'function') continue;
    try {
      await child.lockPermissions();
      synced += 1;
    } catch (err) {
      logger.warn(`Kon de permissies van kanaal ${child.id} niet synchroniseren.`, err);
      failed.push(child.name || child.id);
    }
  }
  return { total: children.length, synced, failed };
}

/**
 * Bepaalt de nieuwe lijst met gedeelde categorieen voor de gekozen actie.
 *
 * @param {object} config Huidige serverconfiguratie.
 * @param {string} categoryId Id van de gekozen categorie.
 * @param {'toevoegen'|'verwijderen'} actie De gekozen actie.
 * @returns {{next: string[]|null, already: boolean, error: string|null}} De nieuwe lijst,
 *   of een foutmelding als de actie niets zou doen.
 */
function nextSharedCategories(config, categoryId, actie) {
  const huidig = Array.isArray(config?.sharedCategoryIds) ? config.sharedCategoryIds : [];
  const already = huidig.includes(categoryId);

  if (actie === 'verwijderen') {
    if (!already) {
      return {
        next: null,
        already,
        error: `<#${categoryId}> staat niet in de lijst met gedeelde categorieën. `
          + 'Bekijk de huidige lijst met `/setup toon`.',
      };
    }
    return { next: huidig.filter((id) => id !== categoryId), already, error: null };
  }
  return { next: already ? [...huidig] : [...huidig, categoryId], already, error: null };
}

/**
 * Voegt de resultaatvelden van een gedeelde-categorie-actie toe aan de embed.
 *
 * @param {import('discord.js').EmbedBuilder} embed De embed.
 * @param {{gangs: number, synced: number, overwrites: number, failed: string[],
 *   notices: string[]}|null} sync Resultaat van syncAllGangsToShared, of null als er niet
 *   gesynchroniseerd is.
 * @param {{total: number, synced: number, failed: string[]}|null} lock
 *   Resultaat van lockChildPermissions, of null als sync_kinderen uit stond.
 * @returns {void}
 */
function addSharedResultFields(embed, sync, lock) {
  if (sync) {
    const regels = sync.gangs
      ? [`${sync.synced} van de ${sync.gangs} gangs toegelaten `
        + `(${sync.overwrites} permissies gewijzigd).`]
      : ['Er zijn nog geen gangs; nieuwe gangs krijgen deze categorie automatisch.'];
    if (sync.failed.length) regels.push(`⚠️ Niet gelukt: ${sync.failed.slice(0, 5).join(' · ')}`);
    for (const notice of sync.notices.slice(0, 3)) regels.push(`⚠️ ${notice}`);
    addField(embed, 'Gangs toegelaten', regels);
  }

  if (lock) {
    const regels = [
      `${lock.synced} van de ${lock.total} kanalen gesynchroniseerd met de categorie.`,
      '⚠️ **Dit heeft de bestaande kanaalpermissies van die kanalen overschreven.** '
        + 'Afwijkende rechten per kanaal zijn verdwenen en moet je zelf opnieuw zetten.',
    ];
    if (lock.failed.length) regels.push(`Niet gelukt: ${lock.failed.slice(0, 5).join(', ')}`);
    addField(embed, 'Kanalen gesynchroniseerd (sync_kinderen)', regels);
  }
}

/**
 * Subcommand `gedeelde-categorie`: beheert de lijst met server-brede categorieen waar
 * elke gang toegang toe krijgt. Bij `toevoegen` worden alle bestaande gangs meteen
 * toegelaten; bij `sync_kinderen` worden alle kanalen in de categorie gelijkgezet.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction De interactie.
 * @returns {Promise<void>}
 */
async function handleGedeeldeCategorie(interaction) {
  if (!(await deferEphemeral(interaction))) return;
  const guild = interaction.guild;
  const picked = interaction.options.getChannel('categorie');
  const actie = interaction.options.getString('actie') === 'verwijderen' ? 'verwijderen' : 'toevoegen';
  const syncChildren = interaction.options.getBoolean('sync_kinderen') === true;

  // Het gekozen kanaal MOET een categorie zijn; de kanaalfilter van Discord is niet genoeg
  // (oude clients en rechtstreekse API-aanroepen kunnen er iets anders in stoppen).
  const category = resolveGuildChannel(guild, picked?.id) || picked;
  if (!category || category.type !== ChannelType.GuildCategory) {
    return respond(interaction, embeds.errorEmbed(
      'Dat is geen categorie',
      `${picked ? `<#${picked.id}>` : 'Het gekozen kanaal'} is geen categorie maar een gewoon `
        + 'kanaal. Kies de categorie zelf (de kop waaronder de kanalen hangen), niet een '
        + 'kanaal dat erin staat.',
    ));
  }

  const config = readConfig(guild.id);
  if (!config) return respond(interaction, saveFailedEmbed());

  const { next, already, error } = nextSharedCategories(config, category.id, actie);
  if (error) return respond(interaction, embeds.errorEmbed('Niets gewijzigd', error));
  if (!writeConfig(guild.id, { sharedCategoryIds: next })) {
    return respond(interaction, saveFailedEmbed());
  }

  // Eerst de gangs toelaten, daarna pas de kinderen gelijkzetten: zo erven die kanalen
  // meteen de zojuist toegevoegde overwrites van de categorie.
  const sync = actie === 'toevoegen' ? await syncAllGangsToShared(guild) : null;
  const lock = syncChildren ? await lockChildPermissions(category) : null;

  const titel = actie === 'toevoegen'
    ? (already ? 'Gedeelde categorie bijgewerkt' : 'Gedeelde categorie toegevoegd')
    : 'Gedeelde categorie verwijderd';
  const heeftWaarschuwing = Boolean(lock)
    || Boolean(sync && (sync.failed.length || sync.notices.length));
  const embed = heeftWaarschuwing ? embeds.warningEmbed(titel) : embeds.successEmbed(titel);

  addField(embed, 'Categorie', `<#${category.id}> — **${category.name || category.id}**`);
  addField(embed, 'Gedeelde categorieën', next.length
    ? next.slice(0, MAX_SHARED_SHOWN).map((id) => describeChannel(guild, id)).join('\n')
    : 'De lijst is nu leeg.');
  addSharedResultFields(embed, sync, lock);

  if (actie === 'verwijderen') {
    addField(embed, 'Let op', [
      'De categorie staat niet meer in de lijst, maar de al gezette permissies voor de '
        + 'gangrollen blijven staan. Verwijder die zelf in de categorie-instellingen als de '
        + 'gangs er geen toegang meer toe mogen hebben.',
    ]);
  }
  return respond(interaction, embed);
}

/* -------------------------------------------------------------------------- */
/* /setup extrarollen                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Subcommand `extrarollen`: beheert de rollen die in ELKE gangcategorie mogen kijken en
 * typen (OWC, wapendealers). Anders dan bij de staffrol passen we de wijziging meteen toe
 * op alle bestaande gangs, zodat er geen `/gang herstel` per gang nodig is.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction De interactie.
 * @returns {Promise<void>} Niets.
 */
async function handleExtraRollen(interaction) {
  const guild = interaction.guild;
  const picked = interaction.options.getRole('rol');
  const actie = interaction.options.getString('actie') || 'toevoegen';

  if (!picked) {
    return respond(interaction, embeds.errorEmbed('Geen rol gekozen', 'Kies een rol met de optie `rol`.'));
  }
  if (picked.id === guild.id) {
    return respond(interaction, embeds.errorEmbed(
      '@everyone kan hier niet',
      'Dan zou de hele server in alle gangkanalen kunnen kijken. Kies een aparte rol.',
    ));
  }

  const config = readConfig(guild.id);
  if (!config) return respond(interaction, saveFailedEmbed());

  const huidig = Array.isArray(config.globalRoleIds) ? [...config.globalRoleIds] : [];

  let nieuw;
  if (actie === 'verwijderen') {
    // Bewust GEEN staffrol- of gangrolcontrole op deze tak: is een rol uit de lijst intussen
    // staffrol of gangrol geworden, dan moet hij er juist uit kunnen. Die controles horen
    // alleen bij het toevoegen thuis.
    if (!huidig.includes(picked.id)) {
      return respond(interaction, embeds.errorEmbed(
        'Stond er niet in',
        `<@&${picked.id}> heeft geen server-brede toegang, dus er valt niets te verwijderen.`,
      ));
    }
    nieuw = huidig.filter((id) => id !== picked.id);
  } else {
    if (huidig.includes(picked.id)) {
      return respond(interaction, embeds.errorEmbed(
        'Stond er al in',
        `<@&${picked.id}> heeft al toegang tot alle gangkanalen.`,
      ));
    }
    if (picked.id === config.staffRoleId) {
      return respond(interaction, embeds.errorEmbed(
        'Dit is al de staffrol',
        `<@&${picked.id}> is ingesteld als staffrol en heeft daardoor al toegang tot alles. `
          + 'Voeg hem niet nog een keer toe.',
      ));
    }
    const eigenaar = gangOfRole(guild.id, picked.id);
    if (eigenaar) {
      return respond(interaction, embeds.errorEmbed(
        'Dit is een gangrol',
        `<@&${picked.id}> hoort bij de gang **${eigenaar.name}**. Zet je die rol in de `
          + `extrarollen, dan krijgt heel ${eigenaar.name} toegang tot de kanalen van ELKE `
          + 'andere gang, ook 💀・boss en 👤・dark-chat. Bij haar eigen kanalen kan die gang al. '
          + 'Moet een groep als OWC of de wapendealers er wel overal bij, maak dan een aparte '
          + 'rol aan die geen gangrol is en kies die hier.',
      ));
    }
    nieuw = [...huidig, picked.id];
  }

  if (!await deferEphemeral(interaction)) return;
  if (!writeConfig(guild.id, { globalRoleIds: nieuw })) {
    return respond(interaction, saveFailedEmbed());
  }

  // Meteen doorvoeren op alle bestaande gangs; anders zou de rol pas werken na /gang herstel.
  let gangs = [];
  try {
    gangs = store.listGangs(guild.id) || [];
  } catch (err) {
    logger.warn('Kon de gangs niet lezen na het aanpassen van de extrarollen.', err);
  }
  let gelukt = 0;
  const mislukt = [];
  for (const gang of gangs) {
    try {
      const res = await gangService.applyCategoryPermissions(guild, gang);
      if (res && res.ok === false) mislukt.push(`${gang.name}: ${res.error}`);
      else gelukt += 1;
    } catch (err) {
      logger.warn(`Permissies bijwerken mislukt voor ${gang?.name}.`, err);
      mislukt.push(`${gang?.name || 'onbekende gang'}: onverwachte fout`);
    }
  }

  // Ook het register bijwerken: een toegevoegde rol moet daar meteen kunnen typen. Een
  // verwijderde rol raakt haar eigen recht daar niet automatisch kwijt - dat meldt de bot
  // als waarschuwing, want dit zijn kanalen die de beheerder zelf heeft ingericht.
  const flow = await applyFlowPermissions(guild);

  const titel = actie === 'verwijderen'
    ? 'Rol verwijderd uit de extrarollen'
    : 'Rol toegevoegd aan de extrarollen';
  const embed = flowHasWarnings(flow) ? embeds.warningEmbed(titel) : embeds.successEmbed(titel);
  addField(embed, 'Rol', `<@&${picked.id}>`, true);
  addField(embed, 'Actie', actie === 'verwijderen' ? 'Verwijderd' : 'Toegevoegd', true);
  addField(
    embed,
    'Rollen met toegang tot alles',
    nieuw.length ? nieuw.map((id) => `<@&${id}>`).join(', ') : 'Geen',
  );
  addField(embed, 'Wat deze rollen mogen', [
    'Alle kanalen van elke gang zien, ook 💀・boss en 👤・dark-chat.',
    'In elk gangkanaal typen, inclusief 📢・mededelingen.',
    'Het 📞・oortje binnenlopen en daar praten.',
  ]);
  if (gangs.length) {
    addField(
      embed,
      'Doorgevoerd',
      mislukt.length
        ? `${gelukt} van ${gangs.length} gangs bijgewerkt. Mislukt:\n${mislukt.slice(0, 5).join('\n')}`
        : `Alle ${gangs.length} bestaande gang(s) zijn meteen bijgewerkt.`,
    );
  }
  addFlowResultFields(embed, flow);
  const role = resolveGuildRole(guild, picked.id);
  if (role?.managed) {
    addField(embed, 'Let op', '⚠️ Dit is een beheerde rol (van een bot of van boosten). '
      + 'Discord laat die niet handmatig aan mensen toekennen.');
  }
  return respond(interaction, embed);
}

/* -------------------------------------------------------------------------- */
/* /setup limieten                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Subcommand `limieten`: past de standaardlimieten aan die NIEUWE gangs meekrijgen.
 * Bestaande gangs houden hun eigen limieten.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction De interactie.
 * @returns {Promise<void>}
 */
async function handleLimieten(interaction) {
  const guild = interaction.guild;
  const leden = interaction.options.getInteger('leden');
  const bosses = interaction.options.getInteger('bosses');
  const underbosses = interaction.options.getInteger('underbosses');

  if (leden === null && bosses === null && underbosses === null) {
    return respond(interaction, embeds.errorEmbed(
      'Niets opgegeven',
      'Geef minstens één limiet op: `leden`, `bosses` of `underbosses`.',
    ));
  }

  const patch = {};
  if (leden !== null) patch.defaultMemberLimit = leden;
  if (bosses !== null) patch.defaultBossLimit = bosses;
  if (underbosses !== null) patch.defaultUnderbossLimit = underbosses;

  const config = writeConfig(guild.id, patch);
  if (!config) return respond(interaction, saveFailedEmbed());

  // Boss en underboss hebben de gangrol ook, dus ze tellen mee binnen de ledenlimiet. Past de
  // leiding niet binnen die limiet, dan loopt de eerstvolgende gang meteen vast: dat zeggen we
  // hier, met de oplossing erbij.
  const notities = [
    'Boss en underboss tellen mee binnen de ledenlimiet: een nieuwe gang heeft dus '
      + `${config.defaultMemberLimit} plekken in totaal, leiding inbegrepen.`,
  ];
  const leiding = config.defaultBossLimit + config.defaultUnderbossLimit;
  const teKrap = leiding > config.defaultMemberLimit;
  if (teKrap) {
    notities.push(
      `⚠️ De leiding (${config.defaultBossLimit} bosses + ${config.defaultUnderbossLimit} `
        + `underbosses = ${leiding}) past niet binnen de ledenlimiet van `
        + `${config.defaultMemberLimit}. Verhoog \`leden\` of verlaag \`bosses\`/\`underbosses\` `
        + 'met dit commando.',
    );
  }

  const embed = teKrap
    ? embeds.warningEmbed('Standaardlimieten bijgewerkt, maar let op')
    : embeds.successEmbed('Standaardlimieten bijgewerkt');
  embed.setDescription('Deze waarden gelden alleen voor **nieuwe** gangs. **Bestaande gangs '
    + 'houden hun eigen limieten** — pas die per gang aan met `/gang limiet`.');
  addField(embed, 'Leden', `${config.defaultMemberLimit}`, true);
  addField(embed, 'Bosses', `${config.defaultBossLimit}`, true);
  addField(embed, 'Underbosses', `${config.defaultUnderbossLimit}`, true);
  addField(embed, 'Toelichting', notities);
  return respond(interaction, embed);
}

/* -------------------------------------------------------------------------- */
/* /setup dashboard                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Subcommand `dashboard`: kiest het kanaal voor het live bezettingsoverzicht en
 * plaatst dat overzicht meteen via dashboardService.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction De interactie.
 * @returns {Promise<void>}
 */
async function handleDashboard(interaction) {
  if (!(await deferEphemeral(interaction))) return;
  const guild = interaction.guild;
  const picked = interaction.options.getChannel('kanaal');
  const channel = resolveGuildChannel(guild, picked?.id) || picked;

  if (!channel || !TEXT_CHANNEL_TYPES.includes(channel.type)) {
    return respond(interaction, embeds.errorEmbed(
      'Ongeldig kanaal',
      'Kies een gewoon tekstkanaal waarin de bot het bezettingsoverzicht mag plaatsen.',
    ));
  }

  const huidig = readConfig(guild.id);
  if (!huidig) return respond(interaction, saveFailedEmbed());

  const patch = { dashboardChannelId: channel.id };
  // Ander kanaal? Dan is het oude bericht-id waardeloos en plaatsen we een nieuw bericht.
  if (huidig.dashboardChannelId !== channel.id) patch.dashboardMessageId = null;
  if (!writeConfig(guild.id, patch)) return respond(interaction, saveFailedEmbed());

  const missend = missingChannelPermissions(guild, channel, POST_CHANNEL_PERMS);
  let result = { ok: false, error: null };
  try {
    result = await dashboardService.updateDashboard(guild);
  } catch (err) {
    logger.error('Onverwachte fout bij het plaatsen van het dashboard.', err);
    result = { ok: false, error: 'Onverwachte fout bij het plaatsen van het dashboardbericht.' };
  }

  const gelukt = Boolean(result?.ok) && !missend.length;
  const embed = gelukt
    ? embeds.successEmbed('Dashboard ingesteld')
    : embeds.warningEmbed('Dashboardkanaal opgeslagen, maar niet geplaatst');
  addField(embed, 'Kanaal', `<#${channel.id}>`);
  if (missend.length) {
    addField(embed, 'Ontbrekende kanaalrechten', [
      `De bot mist in <#${channel.id}>: ${missend.join(', ')}.`,
      'Geef de botrol die rechten in de kanaalinstellingen en voer dit commando opnieuw uit.',
    ]);
  }
  if (!result?.ok && result?.error) addField(embed, 'Melding', result.error);
  addField(embed, 'Hoe het werkt', [
    'De bot houdt één bericht bij met de bezetting van alle gangs en ververst dat elke 5 minuten.',
    'Verwijder je dat bericht, dan plaatst de bot bij de volgende ronde vanzelf een nieuw bericht.',
  ]);
  return respond(interaction, embed);
}

/* -------------------------------------------------------------------------- */
/* /setup toon                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Bouwt de checklist met wat er nog ontbreekt in de configuratie.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} config De serverconfiguratie.
 * @returns {{lines: string[], open: number}} De regels en het aantal openstaande punten.
 */
function buildChecklist(guild, config) {
  const lines = [];
  let open = 0;

  for (const item of CHECKLIST_ITEMS) {
    const id = config ? config[item.key] : null;
    const bestaat = item.kind === 'role'
      ? Boolean(resolveGuildRole(guild, id))
      : Boolean(resolveGuildChannel(guild, id));

    if (id && bestaat) {
      lines.push(`✅ ${item.label}`);
    } else if (id) {
      open += 1;
      const soort = item.kind === 'role' ? 'de ingestelde rol' : 'het ingestelde kanaal';
      lines.push(`⚠️ ${item.label} — ${soort} bestaat niet meer. `
        + `Stel opnieuw in met \`${item.hint}\`.`);
    } else {
      open += 1;
      lines.push(`❌ ${item.label} — ontbreekt. Stel in met \`${item.hint}\`.`);
    }
  }
  return { lines, open };
}

/**
 * Controleert per gang of de botrol boven alle drie de gangrollen staat en of er
 * rollen ontbreken.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {Array<object>} gangs Alle GangRecords van deze server.
 * @returns {{tooLow: string[], missing: string[]}} Gangnamen per probleem.
 */
function checkRoleHierarchy(guild, gangs) {
  const tooLow = [];
  const missing = [];

  for (const gang of gangs) {
    const naam = gang?.name || `gang #${gang?.id ?? '?'}`;
    const ids = [gang?.roleId, gang?.bossRoleId, gang?.underbossRoleId];
    let teLaag = false;
    let ontbreekt = ids.some((id) => !id);

    for (const id of ids) {
      if (!id) continue;
      if (!resolveGuildRole(guild, id)) ontbreekt = true;
      else if (!permissions.botCanManageRole(guild, id)) teLaag = true;
    }
    if (teLaag) tooLow.push(naam);
    if (ontbreekt) missing.push(naam);
  }
  return { tooLow, missing };
}

/**
 * Bouwt de regels voor het veld 'Botrechten en rolhiërarchie'.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {Array<object>} gangs Alle GangRecords van deze server.
 * @returns {{lines: string[], problems: boolean}} De regels en of er iets mis is.
 */
function buildPermissionLines(guild, gangs) {
  const lines = [];
  let problems = false;

  const missend = permissions.missingBotPermissions(guild);
  if (missend.length) {
    problems = true;
    lines.push(`❌ Ontbrekende serverrechten: ${missend.join(', ')}.`);
    lines.push('Geef de botrol deze rechten via Serverinstellingen → Rollen.');
  } else {
    lines.push('✅ De bot heeft alle vereiste serverrechten.');
  }

  const { tooLow, missing } = checkRoleHierarchy(guild, gangs);
  if (tooLow.length) {
    problems = true;
    lines.push(
      `❌ **De botrol staat niet boven de gangrollen van: ${tooLow.slice(0, 8).join(', ')}.** `
        + 'Sleep de botrol in Serverinstellingen → Rollen boven alle gangrollen; anders kan de '
        + 'bot geen leden aannemen of ontslaan.',
    );
  } else if (gangs.length) {
    lines.push('✅ De botrol staat boven alle gangrollen.');
  }
  if (missing.length) {
    problems = true;
    lines.push(`⚠️ Ontbrekende gangrollen bij: ${missing.slice(0, 8).join(', ')}. `
      + 'Voer `/gang herstel` uit om ze opnieuw aan te maken.');
  }
  return { lines, problems };
}

/**
 * Beschrijft de gedeelde categorieen uit de configuratie als veldwaarde.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} config De serverconfiguratie.
 * @returns {string} Veldwaarde met mentions en namen.
 */
function describeSharedCategories(guild, config) {
  const ids = Array.isArray(config?.sharedCategoryIds) ? config.sharedCategoryIds : [];
  if (!ids.length) return '— *geen*';

  const regels = ids.slice(0, MAX_SHARED_SHOWN).map((id) => {
    const category = resolveGuildChannel(guild, id);
    if (!category) return `<#${id}> *(bestaat niet meer)*`;
    return `<#${id}> — ${category.name || id}`;
  });
  if (ids.length > regels.length) regels.push(`… en ${ids.length - regels.length} meer`);
  return regels.join('\n');
}

/**
 * Beschrijft de leidingkanalen als veldwaarde voor /setup toon.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} config De serverconfiguratie.
 * @returns {string} Regels voor in de embed.
 */
function describeLeaderChannels(guild, config) {
  const ids = Array.isArray(config?.leaderChannelIds) ? config.leaderChannelIds : [];
  if (!ids.length) return '— *geen*';

  const regels = ids.slice(0, MAX_SHARED_SHOWN).map((id) => (resolveGuildChannel(guild, id)
    ? `<#${id}>`
    : `<#${id}> *(bestaat niet meer)*`));
  if (ids.length > regels.length) regels.push(`… en ${ids.length - regels.length} meer`);
  return regels.join('\n');
}

/**
 * Beschrijft de extrarollen (globalRoleIds) als veldwaarde.
 *
 * Deze horen in /setup toon thuis: ze geven toegang tot ELK gangkanaal, ook 💀・boss en
 * 👤・dark-chat, dus wie het overzicht leest moet ze kunnen zien zonder eerst
 * `/setup extrarollen` te proberen.
 *
 * @param {import('discord.js').Guild} guild De server.
 * @param {object} config De serverconfiguratie.
 * @returns {string} Veldwaarde met rolmentions.
 */
function describeGlobalRoles(guild, config) {
  const ids = Array.isArray(config?.globalRoleIds) ? config.globalRoleIds : [];
  if (!ids.length) return '— *geen* — toevoegen met `/setup extrarollen`';

  const regels = ids.slice(0, MAX_ROLES_SHOWN).map((id) => (resolveGuildRole(guild, id)
    ? `<@&${id}>`
    : `<@&${id}> *(bestaat niet meer — haal hem weg met \`/setup extrarollen\`)*`));
  if (ids.length > regels.length) regels.push(`… en ${ids.length - regels.length} meer`);
  return regels.join('\n');
}

/**
 * Beschrijft de gangs van deze server als veldwaarde.
 *
 * @param {Array<object>} gangs Alle GangRecords.
 * @returns {string} Veldwaarde.
 */
function describeGangs(gangs) {
  if (!gangs.length) return 'Nog geen gangs. Maak er een aan met `/gang aanmaken`.';
  const namen = gangs.map((gang) => gang?.name || `#${gang?.id ?? '?'}`).join(', ');
  return `${gangs.length} geregistreerd: ${namen}`;
}

/**
 * Subcommand `toon`: de volledige configuratie met kanaal- en rolmentions, een
 * checklist van wat nog ontbreekt en de ontbrekende botrechten/rolhiërarchie.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction De interactie.
 * @returns {Promise<void>}
 */
async function handleToon(interaction) {
  const guild = interaction.guild;
  const config = readConfig(guild.id);
  if (!config) {
    return respond(interaction, embeds.errorEmbed(
      'Configuratie onleesbaar',
      'De opslag `data/owc.json` kon niet gelezen worden. Bekijk de botlogs voor de oorzaak.',
    ));
  }

  let gangs = [];
  try {
    gangs = store.listGangs(guild.id) || [];
  } catch (err) {
    logger.error('Kon de gangs niet lezen voor /setup toon.', err);
  }

  const checklist = buildChecklist(guild, config);
  const perms = buildPermissionLines(guild, gangs);
  const register = buildFlowLockLines(guild, config);

  let embed;
  if (perms.problems) {
    embed = embeds.errorEmbed('⚙️ Configuratie — actie nodig');
  } else if (checklist.open || register.open) {
    embed = embeds.warningEmbed('⚙️ Configuratie — nog niet compleet');
  } else {
    embed = embeds.successEmbed('⚙️ Configuratie — volledig ingesteld');
  }
  embed.setDescription(`Instellingen van **${guild.name || guild.id}**. Alleen jij ziet dit overzicht.`);

  addField(embed, 'Aangenomen', describeChannel(guild, config.hireChannelId), true);
  addField(embed, 'Ontslagen', describeChannel(guild, config.fireChannelId), true);
  addField(embed, 'Logboek', describeChannel(guild, config.logChannelId), true);
  addField(embed, 'Staffrol', describeRole(guild, config.staffRoleId), true);
  addField(embed, 'Meldrol (ping bij problemen)', describeRole(guild, config.alertRoleId), true);
  addField(embed, 'Bodemrol (gangrollen blijven hierboven)',
    config.roleFloorId ? describeRole(guild, config.roleFloorId) : '— *niet ingesteld*', true);
  addField(embed, 'Dashboardkanaal', describeChannel(guild, config.dashboardChannelId), true);
  addField(embed, 'Dashboardbericht', config.dashboardMessageId
    ? `\`${config.dashboardMessageId}\``
    : '— *nog niet geplaatst*', true);
  addField(embed, 'Leidingkanalen (alleen boss en underboss)',
    describeLeaderChannels(guild, config));
  addField(embed, 'Gedeelde categorieën', describeSharedCategories(guild, config));
  addField(embed, 'Extrarollen (toegang tot alle gangkanalen)', describeGlobalRoles(guild, config));
  addField(embed, 'Standaardlimieten (nieuwe gangs)',
    `${config.defaultMemberLimit} leden · ${config.defaultBossLimit} bosses · `
      + `${config.defaultUnderbossLimit} underbosses — bestaande gangs houden hun eigen limieten.`);
  addField(embed, 'Gangs', describeGangs(gangs));
  addField(
    embed,
    checklist.open ? `Checklist — ${checklist.open} punt(en) open` : 'Checklist — compleet',
    checklist.lines,
  );
  addField(
    embed,
    register.open
      ? `Schrijfrechten register — ${register.open} punt(en) open`
      : 'Schrijfrechten register — dichtgezet',
    [
      ...register.lines,
      'Dichtgezet betekent: alleen boss, underboss, staff en de extrarollen kunnen in het '
        + 'aanname- en ontslagkanaal typen; alle andere leden lezen alleen mee.',
    ],
  );
  addField(embed, 'Botrechten en rolhiërarchie', perms.lines);
  return respond(interaction, embed);
}

/* -------------------------------------------------------------------------- */
/* Commandodefinitie                                                           */
/* -------------------------------------------------------------------------- */

const data = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Stel het gangbeheer van deze server in (alleen voor staff).')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) => sub
    .setName('kanalen')
    .setDescription('Stel het aanname-, ontslag- en logkanaal in.')
    .addChannelOption((opt) => opt
      .setName('aangenomen')
      .setDescription('Kanaal waarin leiders leden aannemen.')
      .addChannelTypes(...TEXT_CHANNEL_TYPES))
    .addChannelOption((opt) => opt
      .setName('ontslagen')
      .setDescription('Kanaal waarin leiders leden ontslaan.')
      .addChannelTypes(...TEXT_CHANNEL_TYPES))
    .addChannelOption((opt) => opt
      .setName('logboek')
      .setDescription('Staffkanaal voor het actielogboek met terugdraaiknop.')
      .addChannelTypes(...TEXT_CHANNEL_TYPES)))
  .addSubcommand((sub) => sub
    .setName('extrarollen')
    .setDescription('Rollen die alle gangkanalen mogen zien en er typen (OWC, wapendealers).')
    .addRoleOption((opt) => opt
      .setName('rol')
      .setDescription('Welke rol?')
      .setRequired(true))
    .addStringOption((opt) => opt
      .setName('actie')
      .setDescription('Toevoegen of verwijderen? (standaard: toevoegen)')
      .addChoices(
        { name: 'toevoegen', value: 'toevoegen' },
        { name: 'verwijderen', value: 'verwijderen' },
      )))
  .addSubcommand((sub) => sub
    .setName('staffrol')
    .setDescription('Bepaal welke rol als staff geldt.')
    .addRoleOption((opt) => opt
      .setName('rol')
      .setDescription('De rol die staffrechten krijgt binnen het gangbeheer.')
      .setRequired(true)))
  .addSubcommand((sub) => sub
    .setName('meldrol')
    .setDescription('Welke rol krijgt een ping als de bot er niet uitkomt?')
    .addRoleOption((opt) => opt
      .setName('rol')
      .setDescription('De rol die gepingd wordt. Leeg laten zet de ping uit.')
      .setRequired(false)))
  .addSubcommand((sub) => sub
    .setName('leidingkanaal')
    .setDescription('Een kanaal waar alleen boss en underboss van elke gang bij kunnen.')
    .addChannelOption((opt) => opt
      .setName('kanaal')
      .setDescription('Het kanaal dat alleen voor de gangleiding is.')
      .addChannelTypes(...TEXT_CHANNEL_TYPES)
      .setRequired(true))
    .addStringOption((opt) => opt
      .setName('actie')
      .setDescription('Toevoegen (standaard) of weer loskoppelen.')
      .addChoices(
        { name: 'toevoegen', value: 'toevoegen' },
        { name: 'verwijderen', value: 'verwijderen' },
      )
      .setRequired(false)))
  .addSubcommand((sub) => sub
    .setName('bodemrol')
    .setDescription('Houd gangrollen altijd boven deze rol in de rollenlijst.')
    .addRoleOption((opt) => opt
      .setName('rol')
      .setDescription('De rol waar gangrollen nooit onder mogen zakken. Leeg laten zet dit uit.')
      .setRequired(false)))
  .addSubcommand((sub) => sub
    .setName('gedeelde-categorie')
    .setDescription('Beheer de categorieën waar alle gangs toegang toe krijgen.')
    .addChannelOption((opt) => opt
      .setName('categorie')
      .setDescription('De gedeelde categorie.')
      .addChannelTypes(ChannelType.GuildCategory)
      .setRequired(true))
    .addStringOption((opt) => opt
      .setName('actie')
      .setDescription('Toevoegen aan of verwijderen uit de lijst.')
      .setRequired(true)
      .addChoices(
        { name: 'toevoegen', value: 'toevoegen' },
        { name: 'verwijderen', value: 'verwijderen' },
      ))
    .addBooleanOption((opt) => opt
      .setName('sync_kinderen')
      .setDescription('Kanalen erin gelijkzetten aan de categorie — OVERSCHRIJFT hun permissies.')))
  .addSubcommand((sub) => sub
    .setName('limieten')
    .setDescription('Stel de standaardlimieten voor nieuwe gangs in.')
    .addIntegerOption((opt) => opt
      .setName('leden')
      .setDescription('Standaard aantal leden per gang (boss en underboss tellen mee).')
      .setMinValue(1)
      .setMaxValue(100))
    .addIntegerOption((opt) => opt
      .setName('bosses')
      .setDescription('Standaard aantal bosses per gang.')
      .setMinValue(1)
      .setMaxValue(10))
    .addIntegerOption((opt) => opt
      .setName('underbosses')
      .setDescription('Standaard aantal underbosses per gang.')
      .setMinValue(0)
      .setMaxValue(10)))
  .addSubcommand((sub) => sub
    .setName('dashboard')
    .setDescription('Kies het kanaal voor het live bezettingsoverzicht.')
    .addChannelOption((opt) => opt
      .setName('kanaal')
      .setDescription('Kanaal waarin het dashboardbericht komt te staan.')
      .addChannelTypes(...TEXT_CHANNEL_TYPES)
      .setRequired(true)))
  .addSubcommand((sub) => sub
    .setName('toon')
    .setDescription('Toon de huidige configuratie, de checklist en de botrechten.'));

/** Koppeling van subcommandnaam naar afhandelaar. */
const HANDLERS = {
  kanalen: handleKanalen,
  staffrol: handleStaffrol,
  bodemrol: handleBodemrol,
  meldrol: handleMeldrol,
  leidingkanaal: handleLeidingkanaal,
  'gedeelde-categorie': handleGedeeldeCategorie,
  extrarollen: handleExtraRollen,
  limieten: handleLimieten,
  dashboard: handleDashboard,
  toon: handleToon,
};

/**
 * Voert /setup uit: bepaalt het subcommando en roept de bijbehorende afhandelaar aan.
 * Antwoordt altijd ephemeral en gooit nooit — onverwachte fouten worden gelogd en als
 * nette Nederlandse melding teruggegeven.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction De interactie.
 * @returns {Promise<void>}
 */
async function execute(interaction) {
  if (!interaction.inGuild() || !interaction.guild) {
    return respond(interaction, embeds.errorEmbed(
      'Alleen in een server',
      'Gebruik `/setup` in de server die je wilt instellen, niet in een DM.',
    ));
  }

  let sub = '';
  try {
    sub = interaction.options.getSubcommand();
  } catch {
    sub = '';
  }

  const handler = HANDLERS[sub];
  if (!handler) {
    return respond(interaction, embeds.errorEmbed(
      'Onbekend subcommando',
      'Kies een van: `kanalen`, `leidingkanaal`, `staffrol`, `meldrol`, `bodemrol`, '
        + '`extrarollen`, `gedeelde-categorie`, `limieten`, `dashboard` of `toon`.',
    ));
  }

  try {
    await handler(interaction);
  } catch (err) {
    logger.error(`/setup ${sub} mislukte in server ${interaction.guildId}.`, err);
    await respond(interaction, embeds.errorEmbed(
      'Er ging iets mis',
      'Het commando kon niet afgerond worden. Controleer of de bot de juiste rechten heeft '
        + 'en probeer het opnieuw; de details staan in de botlogs.',
    ));
  }
}

module.exports = { data, execute };
