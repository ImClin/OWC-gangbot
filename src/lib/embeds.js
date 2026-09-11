// src/lib/embeds.js
// Alle embedbouwers van de bot. Elke functie geeft een EmbedBuilder terug met een
// consistente footer ('OWC Gangbeheer') en een kleur uit COLORS (constants.js).
// Alle dynamische tekst wordt afgekapt met truncate() uit parse.js zodat de
// Discord-limieten (256 titel, 4096 beschrijving, 1024 per veld, 25 velden) nooit
// overschreden worden.

const { EmbedBuilder } = require('discord.js');
const { COLORS } = require('./constants');
const { truncate } = require('./parse');
const { formatCapacity, capacityBar, capacityColor } = require('./capacity');

/**
 * @typedef {Object} GangRecord
 * @property {number} id
 * @property {string} name
 * @property {string} slug
 * @property {string} emoji
 * @property {string} categoryId
 * @property {string} roleId
 * @property {string} bossRoleId
 * @property {string} underbossRoleId
 * @property {Object} channels
 * @property {number} memberLimit
 * @property {number} bossLimit
 * @property {number} underbossLimit
 * @property {number} createdAt
 * @property {string} createdBy
 */

/**
 * Telling uit countGang() (capacity.js). Een gang heeft nog maar een soort lid: iedereen
 * met de gangrol telt mee, boss en underboss inbegrepen. De ledenlimiet is daarmee de
 * enige grens op het aantal personen in de gang.
 * @typedef {Object} Counts
 * @property {number} members
 * @property {number} memberLimit
 * @property {string[]} memberIds
 * @property {boolean} memberFull
 * @property {string[]} bossIds
 * @property {string[]} underbossIds
 * @property {number} bossLimit
 * @property {number} underbossLimit
 * @property {boolean} bossFull
 * @property {boolean} underbossFull
 * @property {string[]} [missingRoles]
 */

/**
 * @typedef {Object} ActionRecord
 * @property {number} id
 * @property {string} type
 * @property {number} gangId
 * @property {string} gangName
 * @property {string} targetId
 * @property {string} targetTag
 * @property {string} actorId
 * @property {string} actorTag
 * @property {string|null} reason
 * @property {number} createdAt
 * @property {boolean} reverted
 * @property {string|null} revertedBy
 * @property {number|null} revertedAt
 */

const FOOTER_TEXT = 'OWC Gangbeheer';

/** Harde Discord-limieten. */
const LIMIT = {
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  fields: 25,
};

/** Hoeveel mentions maximaal per veld getoond worden voordat '+ x meer' verschijnt. */
const MAX_MENTIONS_SHOWN = 20;

/** Fallbackkleuren, mocht COLORS onverhoopt onvolledig zijn. */
const FALLBACK_COLORS = {
  success: 0x2ecc71,
  danger: 0xe74c3c,
  warning: 0xf1c40f,
  info: 0x5865f2,
  neutral: 0x2b2d31,
};

// Sleutels = de waarden uit ACTION (constants.js). Bewust als letterlijke strings
// zodat een ontbrekende constante nooit een 'undefined'-sleutel oplevert.
const ACTION_META = {
  hire: { title: '✅ Aangenomen', color: 'success' },
  // hire_meeloper is historisch: er komen geen nieuwe meer bij, maar oude acties met dit
  // type staan nog in data/owc.json en moeten leesbaar blijven in /gang historie en in het
  // logkanaal. Daarom blijft dit label staan.
  hire_meeloper: { title: '📜 Aangenomen (meeloper, oude regeling)', color: 'success' },
  fire: { title: '❌ Ontslagen', color: 'danger' },
  left_server: { title: '🚪 Server verlaten', color: 'warning' },
  manual: { title: '✏️ Handmatige rolwijziging', color: 'warning' },
  leadership: { title: '⭐ Leiding gewijzigd', color: 'info' },
  revert: { title: '↩️ Actie teruggedraaid', color: 'neutral' },
};

/* -------------------------------------------------------------------------- */
/* Interne helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Kapt een waarde veilig af tot maximaal `max` tekens (via truncate uit parse.js).
 * @param {*} value
 * @param {number} max
 * @returns {string}
 */
function cut(value, max) {
  const str = value === null || value === undefined ? '' : String(value);
  if (!str || !Number.isFinite(max) || max <= 0) return '';
  // str.length is de UTF-16-lengte: past die, dan passen ook de code points.
  if (str.length <= max) return str;
  if (typeof truncate === 'function') return String(truncate(str, max));
  // Fallback zonder parse.js: knip op code points zodat emoji niet halveren.
  const chars = Array.from(str);
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/**
 * Haalt een kleur op uit COLORS met een veilige fallback.
 * @param {'success'|'danger'|'warning'|'info'|'neutral'} name
 * @returns {number}
 */
function color(name) {
  const value = COLORS && COLORS[name];
  return typeof value === 'number' ? value : FALLBACK_COLORS[name] || FALLBACK_COLORS.neutral;
}

/**
 * Basisembed met vaste footer en tijdstempel.
 * @param {number} colorValue
 * @returns {EmbedBuilder}
 */
function baseEmbed(colorValue) {
  return new EmbedBuilder()
    .setColor(typeof colorValue === 'number' ? colorValue : color('neutral'))
    .setFooter({ text: FOOTER_TEXT })
    .setTimestamp(new Date());
}

/**
 * Zet milliseconden (of seconden) om naar een Discord-unixtijdstempel in seconden.
 * @param {*} value
 * @returns {number|null}
 */
function unix(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num > 1e11 ? Math.floor(num / 1000) : Math.floor(num);
}

/**
 * Relatieve Discord-tijd, of een streepje als de tijd onbekend is.
 * @param {*} value
 * @returns {string}
 */
function relTime(value) {
  const seconds = unix(value);
  return seconds === null ? '—' : `<t:${seconds}:R>`;
}

/**
 * Voegt een veld toe zolang de 25-veldengrens niet geraakt is; kapt naam en waarde af.
 * @param {EmbedBuilder} embed
 * @param {string} name
 * @param {string} value
 * @param {boolean} [inline=false]
 * @returns {EmbedBuilder}
 */
function addField(embed, name, value, inline = false) {
  const current = embed.data && Array.isArray(embed.data.fields) ? embed.data.fields.length : 0;
  if (current >= LIMIT.fields) return embed;
  const safeName = cut(name, LIMIT.fieldName) || '​';
  const raw = value === null || value === undefined || value === '' ? '—' : value;
  return embed.addFields({ name: safeName, value: cut(raw, LIMIT.fieldValue), inline: Boolean(inline) });
}

/**
 * Zet een beschrijving alleen als er daadwerkelijk tekst is (Discord weigert leeg).
 * @param {EmbedBuilder} embed
 * @param {Array<string|null|undefined>} lines
 * @returns {EmbedBuilder}
 */
function setDescriptionLines(embed, lines) {
  const text = lines.filter(Boolean).join('\n');
  if (text) embed.setDescription(cut(text, LIMIT.description));
  return embed;
}

/**
 * Bouwt een mentionlijst met veilige afkapping en een '+ x meer'-regel.
 * @param {string[]} ids
 * @param {string} [empty='—']
 * @param {number} [max=MAX_MENTIONS_SHOWN]
 * @returns {string}
 */
function mentionList(ids, empty = '—', max = MAX_MENTIONS_SHOWN) {
  const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (!list.length) return empty;
  const budget = LIMIT.fieldValue - 32; // ruimte voor de '+ x meer'-regel
  const shown = [];
  let length = 0;
  for (const id of list) {
    if (shown.length >= max) break;
    const mention = `<@${id}>`;
    if (length + mention.length + 1 > budget) break;
    shown.push(mention);
    length += mention.length + 1;
  }
  if (!shown.length) return `${list.length} leden (te veel om te tonen)`;
  const rest = list.length - shown.length;
  const text = rest > 0 ? `${shown.join(' ')}\n*+ ${rest} meer*` : shown.join(' ');
  return cut(text, LIMIT.fieldValue);
}

/**
 * Roept capacityBar/formatCapacity defensief aan (externe module kan falen op rare input).
 * @param {Counts|null|undefined} counts
 * @returns {{ bar: string, text: string }}
 */
function capacityText(counts) {
  if (!counts || typeof counts !== 'object') return { bar: '', text: 'bezetting onbekend' };
  let bar = '';
  let text = '';
  try {
    bar = typeof capacityBar === 'function' ? String(capacityBar(counts) || '') : '';
  } catch (err) {
    bar = '';
  }
  try {
    text = typeof formatCapacity === 'function' ? String(formatCapacity(counts) || '') : '';
  } catch (err) {
    text = '';
  }
  if (!text) {
    const members = Number(counts.members) || 0;
    const limit = Number(counts.memberLimit) || 0;
    text = `${members}/${limit} leden`;
  }
  return { bar: cut(bar, 120), text: cut(text, 200) };
}

/**
 * Kleur op basis van bezetting, met fallback naar 'info'.
 * @param {Counts|null|undefined} counts
 * @returns {number}
 */
function capacityColorSafe(counts) {
  if (!counts) return color('info');
  try {
    const value = typeof capacityColor === 'function' ? capacityColor(counts) : null;
    if (typeof value === 'number') return value;
  } catch (err) {
    // valt terug op de standaardkleur
  }
  return color('info');
}

/**
 * Haalt counts op uit een Map of een gewoon object, op id (number of string).
 * @param {Map<*, Counts>|Object<string, Counts>|null|undefined} source
 * @param {number|string} gangId
 * @returns {Counts|null}
 */
function pickCounts(source, gangId) {
  if (!source || gangId === null || gangId === undefined) return null;
  if (typeof source.get === 'function') {
    return source.get(gangId) || source.get(String(gangId)) || source.get(Number(gangId)) || null;
  }
  return source[gangId] || source[String(gangId)] || null;
}

/**
 * Verdeelt regels over blokken van maximaal `maxLen` tekens (voor embedvelden).
 * @param {string[]} lines
 * @param {number} [maxLen=LIMIT.fieldValue]
 * @param {number} [maxChunks=5]
 * @returns {{ chunks: string[], remaining: number }}
 */
function chunkLines(lines, maxLen = LIMIT.fieldValue, maxChunks = 5) {
  const safeLines = (Array.isArray(lines) ? lines : []).map((line) => cut(line, maxLen)).filter(Boolean);
  const chunks = [];
  let current = '';
  let currentCount = 0;
  let used = 0;
  for (const line of safeLines) {
    if (current && current.length + line.length + 1 > maxLen) {
      chunks.push(current);
      used += currentCount;
      current = '';
      currentCount = 0;
      if (chunks.length >= maxChunks) break;
    }
    current = current ? `${current}\n${line}` : line;
    currentCount += 1;
  }
  if (current && chunks.length < maxChunks) {
    chunks.push(current);
    used += currentCount;
  }
  return { chunks, remaining: Math.max(0, safeLines.length - used) };
}

/**
 * Eén overzichtsregel per gang: emoji, naam, capaciteitsbalk en bezetting.
 * @param {GangRecord} gang
 * @param {Counts|null} counts
 * @returns {string}
 */
function gangLine(gang, counts) {
  const emoji = gang && gang.emoji ? `${gang.emoji} ` : '';
  const name = cut(gang && gang.name ? gang.name : 'Onbekende gang', 40);
  const { bar, text } = capacityText(counts);
  const parts = [`${emoji}**${name}**`];
  if (bar) parts.push(bar);
  parts.push(text);
  return cut(parts.join(' — '), LIMIT.fieldValue);
}

/**
 * Bezettingsgraad van een gang (0–1+), voor sorteren op 'volste eerst'.
 * @param {Counts|null} counts
 * @returns {number}
 */
function fillRatio(counts) {
  if (!counts) return -1;
  const members = Number(counts.members) || 0;
  const memberLimit = Number(counts.memberLimit) || 0;
  if (memberLimit > 0) return members / memberLimit;
  // Limiet 0 (of onleesbaar): een gang met leden telt als vol, een lege gang als leeg.
  return members > 0 ? 1 : 0;
}

/**
 * Sorteert gangs op volste eerst, daarna op absoluut aantal leden en naam.
 * @param {GangRecord[]} gangs
 * @param {Map<*, Counts>|Object<string, Counts>} countsByGangId
 * @returns {GangRecord[]}
 */
function sortByFullest(gangs, countsByGangId) {
  return gangs.slice().sort((a, b) => {
    const ca = pickCounts(countsByGangId, a && a.id);
    const cb = pickCounts(countsByGangId, b && b.id);
    const diff = fillRatio(cb) - fillRatio(ca);
    if (diff !== 0) return diff;
    const membersDiff = (Number(cb && cb.members) || 0) - (Number(ca && ca.members) || 0);
    if (membersDiff !== 0) return membersDiff;
    return String((a && a.name) || '').localeCompare(String((b && b.name) || ''));
  });
}

/**
 * Voegt de leiding- en ledenvelden toe aan een gang-embed. De ledenteller telt iedereen
 * met de gangrol, boss en underboss inbegrepen; in de mentionlijst staan alleen de leden
 * zonder leidersrol, want boss en underboss hebben hun eigen veld.
 * @param {EmbedBuilder} embed
 * @param {Counts|null} counts
 * @returns {EmbedBuilder}
 */
function addRosterFields(embed, counts) {
  const c = counts || {};
  const bossIds = Array.isArray(c.bossIds) ? c.bossIds.filter(Boolean) : [];
  const underbossIds = Array.isArray(c.underbossIds) ? c.underbossIds.filter(Boolean) : [];
  const memberIds = Array.isArray(c.memberIds) ? c.memberIds.filter(Boolean) : [];
  const leaders = new Set([...bossIds, ...underbossIds]);
  const plainMembers = memberIds.filter((id) => !leaders.has(id));

  addField(embed, `👑 Boss (${bossIds.length})`, mentionList(bossIds, '*geen boss*'), true);
  addField(embed, `🛡️ Underboss (${underbossIds.length})`, mentionList(underbossIds, '*geen underboss*'), true);
  addField(
    embed,
    `Leden (${Number(c.members) || memberIds.length}/${Number(c.memberLimit) || 0})`,
    mentionList(plainMembers, '*nog geen leden buiten de leiding*'),
  );
  return embed;
}

/* -------------------------------------------------------------------------- */
/* Eenvoudige embeds                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Bouwt een eenvoudige embed met titel en optionele beschrijving.
 * @param {'success'|'danger'|'warning'|'info'|'neutral'} colorName
 * @param {string} title
 * @param {string} [description]
 * @returns {EmbedBuilder}
 */
function simpleEmbed(colorName, title, description) {
  const embed = baseEmbed(color(colorName));
  const safeTitle = cut(title, LIMIT.title);
  if (safeTitle) embed.setTitle(safeTitle);
  const safeDescription = cut(description, LIMIT.description);
  if (safeDescription) embed.setDescription(safeDescription);
  return embed;
}

/**
 * Groene bevestigingsembed.
 * @param {string} title Titel van de melding.
 * @param {string} [description] Toelichting (optioneel).
 * @returns {EmbedBuilder}
 */
function successEmbed(title, description) {
  return simpleEmbed('success', title, description);
}

/**
 * Rode foutembed.
 * @param {string} title Titel van de foutmelding.
 * @param {string} [description] Toelichting met de oplossing (optioneel).
 * @returns {EmbedBuilder}
 */
function errorEmbed(title, description) {
  return simpleEmbed('danger', title, description);
}

/**
 * Gele waarschuwingsembed.
 * @param {string} title Titel van de waarschuwing.
 * @param {string} [description] Toelichting (optioneel).
 * @returns {EmbedBuilder}
 */
function warningEmbed(title, description) {
  return simpleEmbed('warning', title, description);
}

/**
 * Blauwe informatie-embed.
 * @param {string} title Titel van de melding.
 * @param {string} [description] Toelichting (optioneel).
 * @returns {EmbedBuilder}
 */
function infoEmbed(title, description) {
  return simpleEmbed('info', title, description);
}

/* -------------------------------------------------------------------------- */
/* Gang-embeds                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Bevestiging na het aanmaken van een gang: rollen, kanalen, categorie en limieten.
 * @param {GangRecord} gang De zojuist aangemaakte gang.
 * @param {Counts|null} [counts] Verse telling uit countGang() (optioneel).
 * @returns {EmbedBuilder}
 */
function gangCreatedEmbed(gang, counts) {
  const g = gang || {};
  const embed = baseEmbed(color('success'))
    .setTitle(cut(`✅ Gang aangemaakt — ${g.emoji ? `${g.emoji} ` : ''}${g.name || 'onbekend'}`, LIMIT.title));

  const { text } = capacityText(counts);
  setDescriptionLines(embed, [
    g.categoryId ? `Categorie: <#${g.categoryId}>` : null,
    `Bezetting: ${text}`,
    g.slug ? `Kanaalnamen: \`${g.slug}\`${g.abbreviation ? ' *(afkorting)*' : ''}` : null,
  ]);

  const roles = [
    g.roleId ? `Gang: <@&${g.roleId}>` : null,
    g.bossRoleId ? `Boss: <@&${g.bossRoleId}>` : null,
    g.underbossRoleId ? `Underboss: <@&${g.underbossRoleId}>` : null,
  ].filter(Boolean).join('\n');
  addField(embed, 'Rollen', roles, true);

  addField(
    embed,
    'Limieten',
    `Leden: ${Number(g.memberLimit) || 0}\nBosses: ${Number(g.bossLimit) || 0}\nUnderbosses: ${Number(g.underbossLimit) || 0}`,
    true,
  );

  const channels = g.channels && typeof g.channels === 'object' ? g.channels : {};
  const channelList = Object.keys(channels)
    .map((kind) => (channels[kind] ? `<#${channels[kind]}>` : null))
    .filter(Boolean)
    .join(' ');
  if (channelList) addField(embed, 'Kanalen', channelList);

  addField(
    embed,
    'Volgende stap',
    'Neem leden aan in het #aangenomen-kanaal en maak er met `/gang promoveer` een underboss '
      + 'of boss van; een trede terug gaat met `/gang degradeer`.',
  );
  return embed;
}

/**
 * Volledig gangoverzicht: boss(sen), underboss(sen) en de overige leden als mentions,
 * plus de limieten en de categorie-link. Lange lijsten worden afgekapt met '+ x meer'
 * zodat de veldlimiet van 1024 tekens nooit overschreden wordt.
 * @param {GangRecord} gang De gang.
 * @param {Counts|null} counts Resultaat van countGang().
 * @param {import('discord.js').Guild|null} [guild] Server, om de categorie te controleren.
 * @param {{detail?: boolean}} [options] `detail: false` laat de beheergegevens weg: kanaalnamen,
 *   wie de gang aanmaakte en de herstelmeldingen. Standaard aan.
 * @returns {EmbedBuilder}
 */
function gangInfoEmbed(gang, counts, guild, options = {}) {
  const g = gang || {};
  const c = counts || null;
  // `detail` staat aan voor staff en de leiding van de gang. Zonder detail blijven de
  // beheergegevens weg: kanaalnamen, wie de gang aanmaakte en de herstelmeldingen zeggen
  // een gewoon lid niets en nodigen alleen maar uit tot vragen aan staff.
  const detail = options?.detail !== false;
  const embed = baseEmbed(capacityColorSafe(c))
    .setTitle(cut(`${g.emoji ? `${g.emoji} ` : ''}${g.name || 'Onbekende gang'}`, LIMIT.title));

  const { bar, text } = capacityText(c);
  const category = guild && guild.channels && guild.channels.cache
    ? guild.channels.cache.get(g.categoryId)
    : undefined;

  setDescriptionLines(embed, [
    bar || null,
    `**${text}**`,
    g.categoryId
      ? `Categorie: ${category ? `<#${g.categoryId}>` : '*niet gevonden — gebruik `/gang herstel`*'}`
      : null,
    detail && g.slug ? `Kanaalnamen: \`${g.slug}\`${g.abbreviation ? ' *(afkorting)*' : ''}` : null,
    detail && g.createdAt
      ? `Aangemaakt ${relTime(g.createdAt)}${g.createdBy ? ` door <@${g.createdBy}>` : ''}`
      : null,
  ]);

  addRosterFields(embed, c);

  const memberLimit = Number(g.memberLimit) || Number(c && c.memberLimit) || 0;
  const bossLimit = Number(g.bossLimit) || Number(c && c.bossLimit) || 0;
  const underbossLimit = Number(g.underbossLimit) || Number(c && c.underbossLimit) || 0;
  addField(
    embed,
    'Limieten',
    `Leden: **${memberLimit}** · Bosses: **${bossLimit}** · Underbosses: **${underbossLimit}**`,
  );

  const missing = detail && c && Array.isArray(c.missingRoles) ? c.missingRoles.filter(Boolean) : [];
  if (missing.length) {
    addField(
      embed,
      '⚠️ Ontbrekende rollen',
      `${cut(missing.join(', '), 900)}\nGebruik \`/gang herstel\` om ze opnieuw aan te maken.`,
    );
  }

  if (c && c.memberFull) {
    addField(
      embed,
      'Status',
      `Deze gang zit vol: ${Number(c.members) || 0}/${memberLimit} leden.`
        + (detail
          ? ' Ontsla eerst iemand met `/gang ontslaan`, of verhoog de limiet met'
            + ' `/gang limiet leden:<aantal>`.'
          : ' Er kan pas weer iemand bij als de leiding ruimte maakt.'),
    );
  }
  return embed;
}

/**
 * Overzicht van alle gangs: per gang één regel met emoji, naam, capaciteitsbalk en
 * bezetting. De regels worden over meerdere velden verdeeld als ze niet passen.
 * @param {GangRecord[]} gangs Alle gangs.
 * @param {Map<*, Counts>|Object<string, Counts>} countsByGangId Bezetting per gang-id.
 * @returns {EmbedBuilder}
 */
function gangListEmbed(gangs, countsByGangId) {
  const list = Array.isArray(gangs) ? gangs.filter(Boolean) : [];
  const embed = baseEmbed(color('info')).setTitle(`📋 Gangs (${list.length})`);

  if (!list.length) {
    embed.setDescription('Er zijn nog geen gangs aangemaakt. Gebruik `/gang aanmaken` om te beginnen.');
    return embed;
  }

  const sorted = list.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  const lines = sorted.map((gang) => gangLine(gang, pickCounts(countsByGangId, gang.id)));
  const { chunks, remaining } = chunkLines(lines);

  chunks.forEach((chunk, index) => {
    addField(embed, index === 0 ? 'Overzicht' : `Overzicht (${index + 1})`, chunk);
  });
  if (remaining > 0) {
    addField(
      embed,
      'Niet getoond',
      `Nog ${remaining} gang(s) passen niet in dit overzicht. Gebruik \`/gang info\` voor details.`,
    );
  }

  const totalMembers = sorted.reduce((sum, gang) => {
    const c = pickCounts(countsByGangId, gang.id);
    return sum + (Number(c && c.members) || 0);
  }, 0);
  embed.setDescription(cut(`In totaal **${totalMembers}** leden in **${sorted.length}** gang(s).`, LIMIT.description));
  return embed;
}

/* -------------------------------------------------------------------------- */
/* Log- en historie-embeds                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Logembed voor het staff-logkanaal; titel en kleur per actietype, met velden voor
 * gang, lid, uitvoerder, reden en de bezetting na de actie.
 * @param {ActionRecord} action De opgeslagen actie.
 * @param {Counts|null} [counts] Bezetting van de gang ná de actie (optioneel).
 * @returns {EmbedBuilder}
 */
function actionLogEmbed(action, counts) {
  const a = action || {};
  const meta = ACTION_META[a.type] || { title: 'ℹ️ Actie', color: 'neutral' };
  const reverted = Boolean(a.reverted);
  const embed = baseEmbed(color(reverted ? 'neutral' : meta.color))
    .setTitle(cut(reverted ? `${meta.title} (teruggedraaid)` : meta.title, LIMIT.title));

  setDescriptionLines(embed, [
    `Actie **#${a.id === undefined || a.id === null ? '?' : a.id}** · ${relTime(a.createdAt)}`,
  ]);

  addField(embed, 'Gang', cut(a.gangName || 'onbekend', 200), true);
  addField(
    embed,
    'Lid',
    a.targetId
      ? `<@${a.targetId}>${a.targetTag ? `\n${cut(a.targetTag, 100)}` : ''}`
      : cut(a.targetTag || 'onbekend', 200),
    true,
  );
  addField(
    embed,
    'Door',
    a.actorId
      ? `<@${a.actorId}>${a.actorTag ? `\n${cut(a.actorTag, 100)}` : ''}`
      : cut(a.actorTag || 'systeem', 200),
    true,
  );
  if (a.reason) addField(embed, 'Reden', cut(a.reason, 900));

  if (counts) {
    const { bar, text } = capacityText(counts);
    addField(embed, 'Bezetting', bar ? `${bar}\n${text}` : text);
  }
  if (reverted) {
    addField(
      embed,
      'Teruggedraaid door',
      `${a.revertedBy ? `<@${a.revertedBy}>` : 'onbekend'} · ${relTime(a.revertedAt)}`,
    );
  }
  return embed;
}

/**
 * Compacte actiehistorie met relatieve tijdstempels; teruggedraaide acties staan
 * doorgestreept.
 * @param {GangRecord|null} gang De gang, of null voor een gecombineerd overzicht.
 * @param {ActionRecord[]} actions Acties, nieuwste eerst.
 * @returns {EmbedBuilder}
 */
function historyEmbed(gang, actions) {
  const list = Array.isArray(actions) ? actions.filter(Boolean) : [];
  const g = gang || null;
  const titleName = g ? `${g.emoji ? `${g.emoji} ` : ''}${g.name || 'gang'}` : 'alle gangs';
  const embed = baseEmbed(color('info')).setTitle(cut(`🗒️ Historie — ${titleName}`, LIMIT.title));

  if (!list.length) {
    embed.setDescription('Er zijn nog geen acties vastgelegd.');
    return embed;
  }

  const visible = list.slice(0, 25);
  const lines = visible.map((action) => {
    const meta = ACTION_META[action.type] || { title: 'ℹ️ Actie' };
    const label = meta.title.replace(/^\S+\s+/, '');
    const target = action.targetId ? `<@${action.targetId}>` : cut(action.targetTag || 'onbekend', 60);
    const actor = action.actorId ? `<@${action.actorId}>` : cut(action.actorTag || 'systeem', 60);
    const gangPart = g ? '' : ` · ${cut(action.gangName || 'onbekend', 40)}`;
    const reasonPart = action.reason ? ` · _${cut(action.reason, 60)}_` : '';
    const line = `\`#${action.id === undefined || action.id === null ? '?' : action.id}\` **${label}** ${target} · door ${actor}${gangPart} · ${relTime(action.createdAt)}${reasonPart}`;
    return action.reverted ? `~~${line}~~` : line;
  });

  const { chunks, remaining } = chunkLines(lines);
  chunks.forEach((chunk, index) => {
    addField(embed, index === 0 ? 'Laatste acties' : `Laatste acties (${index + 1})`, chunk);
  });

  const hidden = remaining + Math.max(0, list.length - visible.length);
  setDescriptionLines(embed, [
    `${list.length} actie(s) gevonden${hidden > 0 ? ` — ${hidden} niet getoond` : ''}.`,
    'Doorgestreepte regels zijn teruggedraaid.',
  ]);
  return embed;
}

/**
 * Live bezettingsoverzicht voor het dashboardkanaal; volste gang bovenaan, met een
 * regel 'Laatst bijgewerkt <t:unix:R>'.
 * @param {GangRecord[]} gangs Alle gangs.
 * @param {Map<*, Counts>|Object<string, Counts>} countsByGangId Bezetting per gang-id.
 * @param {number} updatedAtUnix Tijdstip van bijwerken (unix in seconden; ms wordt omgezet).
 * @returns {EmbedBuilder}
 */
function dashboardEmbed(gangs, countsByGangId, updatedAtUnix) {
  const list = Array.isArray(gangs) ? gangs.filter(Boolean) : [];
  const embed = baseEmbed(color('info')).setTitle('📊 Gangoverzicht');
  const stamp = relTime(updatedAtUnix === undefined || updatedAtUnix === null ? Date.now() : updatedAtUnix);

  if (!list.length) {
    embed.setDescription(`Er zijn nog geen gangs aangemaakt.\nLaatst bijgewerkt ${stamp}`);
    return embed;
  }

  const sorted = sortByFullest(list, countsByGangId);
  const lines = sorted.map((gang) => gangLine(gang, pickCounts(countsByGangId, gang.id)));
  const { chunks, remaining } = chunkLines(lines);

  chunks.forEach((chunk, index) => {
    addField(embed, index === 0 ? 'Bezetting (volste eerst)' : `Bezetting (${index + 1})`, chunk);
  });
  if (remaining > 0) {
    addField(embed, 'Niet getoond', `Nog ${remaining} gang(s) passen niet in dit overzicht.`);
  }

  const totals = sorted.reduce((acc, gang) => {
    const c = pickCounts(countsByGangId, gang.id);
    acc.members += Number(c && c.members) || 0;
    if (c && c.memberFull) acc.full += 1;
    return acc;
  }, { members: 0, full: 0 });

  setDescriptionLines(embed, [
    `**${sorted.length}** gang(s) · **${totals.members}** leden${totals.full > 0 ? ` · **${totals.full}** vol` : ''}`,
    `Laatst bijgewerkt ${stamp}`,
  ]);
  return embed;
}

module.exports = {
  successEmbed,
  errorEmbed,
  warningEmbed,
  infoEmbed,
  gangCreatedEmbed,
  gangInfoEmbed,
  gangListEmbed,
  actionLogEmbed,
  historyEmbed,
  dashboardEmbed,
};
