// src/lib/parse.js
// Parse-helpers voor vrije gebruikersinvoer: berichten in #aangenomen / #ontslagen
// en tekstopties van slash-commando's. Alles is defensief: elke functie accepteert
// ook null/undefined/niet-strings zonder te gooien.

/** Maximale lengte van een gang-slug. */
const MAX_SLUG_LENGTH = 60;

/** Maximale lengte van een vastgelegde reden. */
const MAX_REASON_LENGTH = 400;

/** Maximaal aantal code points in een unicode-emoji (de vlag van Wales telt er 8). */
const MAX_EMOJI_CODE_POINTS = 8;

// --- Regexes (Discord snowflakes zijn 17-20 cijfers) -------------------------

/** Rolmention: <@&123456789012345678> */
const ROLE_MENTION_RE = /<@&(\d{17,20})>/g;

/** Kanaalmention: <#123456789012345678> */
const CHANNEL_MENTION_RE = /<#(\d{17,20})>/g;

/** Custom emoji ergens in de tekst: <:naam:id> / <a:naam:id> (bevat een snowflake). */
const CUSTOM_EMOJI_ANY_RE = /<a?:[A-Za-z0-9_~]{1,32}:\d{17,20}>/g;

/** Discord-tijdstempel: <t:1710000000:R> */
const TIMESTAMP_RE = /<t:-?\d{1,20}(?::[tTdDfFR])?>/g;

/**
 * Gebruikersmention (<@123> / <@!123>) of een los snowflake-getal.
 * De lookarounds voorkomen dat we een stuk uit een langer getal oppikken.
 */
const USER_ID_RE = /<@!?(\d{17,20})>|(?<!\d)(\d{17,20})(?!\d)/g;

/** Custom emoji als volledige waarde: <:naam:id> of <a:naam:id> */
const CUSTOM_EMOJI_EXACT_RE = /^<a?:[A-Za-z0-9_~]{2,32}:\d{17,20}>$/;

/** Keycap-emoji: 0-9, # of * gevolgd door (optioneel) VS16 en U+20E3. */
const KEYCAP_RE = /^[0-9#*]\u{FE0F}?\u{20E3}$/u;

/** Vlag: exact twee regionale indicatoren. */
const REGIONAL_PAIR_RE = /^[\u{1F1E6}-\u{1F1FF}]{2}$/u;

/**
 * Een pictogram: het enige code point waarmee een gewone emoji-sequentie mag
 * beginnen. Regionale indicatoren en keycap-cijfers vallen hier bewust buiten;
 * die worden apart afgehandeld.
 */
const PICTOGRAPH_RE = /^\p{Extended_Pictographic}$/u;

/** Huidskleur-modifier (U+1F3FB t/m U+1F3FF). */
const EMOJI_MODIFIER_RE = /^\p{Emoji_Modifier}$/u;

/** Variation selector 15/16: tekst- of emoji-weergave. */
const VARIATION_SELECTOR_RE = /^[\u{FE0E}\u{FE0F}]$/u;

/** Tag-tekens voor subdivisievlaggen (bijv. de vlag van Wales). */
const EMOJI_TAG_RE = /^[\u{E0020}-\u{E007F}]$/u;

/** Zero width joiner: koppelt twee pictogrammen tot een emoji. */
const ZWJ_CODE_POINT = 0x200d;

/** 'reden: ...' als expliciete markering van de reden. */
const REASON_KEYWORD_RE = /\breden\s*:\s*([\s\S]+)/i;

/**
 * Maakt van een gangnaam een kanaalvriendelijke slug.
 * Diakrieten worden gestript ('Munoz' met tilde => 'munoz'), alles buiten a-z0-9
 * wordt een streepje, dubbele/leidende/sluitende streepjes verdwijnen en het
 * resultaat is maximaal MAX_SLUG_LENGTH tekens.
 *
 * @param {string} name Vrije naam, bijvoorbeeld 'Los Zetas!'.
 * @returns {string} De slug, bijvoorbeeld 'los-zetas'. Lege string bij ongeldige invoer.
 */
function slugify(name) {
  if (typeof name !== 'string' || !name) return '';
  const base = name
    .normalize('NFKD')
    .replace(/[\u{0300}-\u{036F}]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  // Na het afkappen kan er opnieuw een streepje aan het eind staan.
  return base.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, '');
}

/**
 * Haalt alle gebruikers-id's uit een bericht: mentions (<@123>, <@!123>) en losse
 * snowflake-getallen (17-20 cijfers).
 *
 * Rolmentions (<@&123>), kanaalmentions (<#123>), custom emoji (<:naam:123>) en
 * tijdstempels worden EERST weggestript, zodat een gang-rolmention nooit als
 * gebruiker wordt gezien.
 *
 * @param {string} content Ruwe berichtinhoud.
 * @returns {string[]} Unieke gebruikers-id's, in de volgorde waarin ze voorkomen.
 */
function extractUserIds(content) {
  if (typeof content !== 'string' || !content) return [];
  const cleaned = content
    .replace(ROLE_MENTION_RE, ' ')
    .replace(CHANNEL_MENTION_RE, ' ')
    .replace(CUSTOM_EMOJI_ANY_RE, ' ')
    .replace(TIMESTAMP_RE, ' ');

  const ids = [];
  const seen = new Set();
  for (const match of cleaned.matchAll(USER_ID_RE)) {
    const id = match[1] || match[2];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Haalt alle rol-id's uit een bericht (<@&123>).
 *
 * @param {string} content Ruwe berichtinhoud.
 * @returns {string[]} Unieke rol-id's, in de volgorde waarin ze voorkomen.
 */
function extractRoleIds(content) {
  if (typeof content !== 'string' || !content) return [];
  const ids = [];
  const seen = new Set();
  for (const match of content.matchAll(ROLE_MENTION_RE)) {
    const id = match[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Haalt de opgegeven reden uit een bericht.
 * 'reden: ...' heeft voorrang; anders geldt alles na het eerste '|'-teken.
 *
 * @param {string} content Ruwe berichtinhoud, bijvoorbeeld '@Sara | reden: verraden'.
 * @returns {string|null} De getrimde reden (max 400 tekens) of null als er geen is.
 */
function extractReason(content) {
  if (typeof content !== 'string' || !content) return null;

  let raw = null;
  const keyed = content.match(REASON_KEYWORD_RE);
  if (keyed) {
    raw = keyed[1];
  } else {
    const pipe = content.indexOf('|');
    if (pipe !== -1) raw = content.slice(pipe + 1);
  }
  if (raw === null) return null;

  const reason = raw.replace(/\s+/g, ' ').trim();
  if (!reason) return null;
  return truncate(reason, MAX_REASON_LENGTH);
}

/**
 * Controleert of een reeks code points precies een pictogram-sequentie vormt:
 * een pictogram, eventueel gevolgd door variation selectors, huidskleuren,
 * tag-tekens en met ZWJ gekoppelde vervolgpictogrammen.
 * Twee losse emoji naast elkaar (zonder ZWJ) zijn dus ongeldig.
 *
 * @param {string[]} points Code points van de te controleren string.
 * @returns {boolean} true bij een geldige sequentie.
 */
function isPictographSequence(points) {
  if (!points.length || !PICTOGRAPH_RE.test(points[0])) return false;

  let index = 1;
  while (index < points.length) {
    const point = points[index];
    if (
      VARIATION_SELECTOR_RE.test(point)
      || EMOJI_MODIFIER_RE.test(point)
      || EMOJI_TAG_RE.test(point)
    ) {
      index += 1;
      continue;
    }
    if (point.codePointAt(0) === ZWJ_CODE_POINT) {
      const next = points[index + 1];
      // Na een ZWJ MOET een pictogram volgen, anders is het geen emoji.
      if (!next || !PICTOGRAPH_RE.test(next)) return false;
      index += 2;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Controleert of een string precies een bruikbare emoji is: ofwel een unicode-emoji
 * (inclusief variation selectors, ZWJ-sequenties, huidskleuren, vlaggen en keycaps),
 * ofwel een custom Discord-emoji in de vorm <:naam:id> / <a:naam:id>.
 *
 * @param {string} str Te controleren waarde.
 * @returns {boolean} true als het precies een geldige emoji is.
 */
function isValidEmoji(str) {
  if (typeof str !== 'string') return false;
  const value = str.trim();
  if (!value) return false;

  if (CUSTOM_EMOJI_EXACT_RE.test(value)) return true;

  // Tellen per code point, niet via .length (surrogate pairs tellen anders dubbel).
  const points = Array.from(value);
  if (points.length === 0 || points.length > MAX_EMOJI_CODE_POINTS) return false;

  // Keycaps (1) en landvlaggen (twee regionale indicatoren) hebben een eigen vorm.
  if (KEYCAP_RE.test(value)) return true;
  if (REGIONAL_PAIR_RE.test(value)) return true;

  return isPictographSequence(points);
}

/**
 * Kapt een string veilig af op code-point-grens en zet er een beletselteken achter.
 *
 * @param {string} str Te verkorten tekst.
 * @param {number} n Maximale lengte in code points (het beletselteken telt mee).
 * @returns {string} De (eventueel) afgekapte tekst; lege string bij ongeldige invoer.
 */
function truncate(str, n) {
  if (typeof str !== 'string' || !str) return '';
  const max = Number.isFinite(n) ? Math.floor(n) : 0;
  if (max <= 0) return '';
  const chars = Array.from(str);
  if (chars.length <= max) return str;
  if (max === 1) return '…';
  return `${chars.slice(0, max - 1).join('')}…`;
}

module.exports = {
  slugify,
  extractUserIds,
  extractRoleIds,
  extractReason,
  isValidEmoji,
  truncate,
};
