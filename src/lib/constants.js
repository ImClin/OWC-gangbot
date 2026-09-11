// src/lib/constants.js — vaste waarden en permissiesets voor het gangbeheer.
// Alles wat hier staat is de enige bron van waarheid voor namen, limieten en rechten.

const { PermissionFlagsBits } = require('discord.js');

/**
 * Scheidingsteken tussen emoji en kanaalnaam: U+30FB (KATAKANA MIDDLE DOT).
 * @type {string}
 */
const CHANNEL_NAME_SEPARATOR = '・';

/** Maximale lengte van een Discord-kanaalnaam. */
const MAX_CHANNEL_NAME_LENGTH = 100;

/**
 * De zes kanalen van elke gang, in aanmaak- en weergavevolgorde.
 * Kanaalnaam = `${emoji}${CHANNEL_NAME_SEPARATOR}${base}` waarbij
 * base = useSlug ? slug + suffix : fixedName.
 * @type {ReadonlyArray<{kind: string, emoji: string, suffix?: string, fixedName?: string, useSlug: boolean, type: 'text'|'voice'}>}
 */
const CHANNEL_BLUEPRINT = [
  { kind: 'mededeling', emoji: '📢', suffix: '-mededeling', useSlug: true, type: 'text' },
  { kind: 'boss', emoji: '💀', suffix: '-boss', useSlug: true, type: 'text' },
  { kind: 'chat', emoji: '💭', suffix: '-chat', useSlug: true, type: 'text' },
  { kind: 'media', emoji: '📷', fixedName: 'media', useSlug: false, type: 'text' },
  { kind: 'dark', emoji: '👤', fixedName: 'dark-chat', useSlug: false, type: 'text' },
  { kind: 'oortje', emoji: '📞', suffix: '-oortje', useSlug: true, type: 'voice' },
];

/** Standaard aantal leden per gang (boss en underboss tellen mee). */
const DEFAULT_MEMBER_LIMIT = 22;

/** Standaard aantal bosses per gang. */
const DEFAULT_BOSS_LIMIT = 2;

/** Standaard aantal underbosses per gang. */
const DEFAULT_UNDERBOSS_LIMIT = 2;

/** Embedkleuren. */
const COLORS = {
  success: 0x2ecc71,
  danger: 0xe74c3c,
  warning: 0xf1c40f,
  info: 0x5865f2,
  neutral: 0x2b2d31,
};

/**
 * Types die in een ActionRecord.type terechtkomen.
 * HIRE_MEELOPER is historisch: er komen geen nieuwe meer bij, maar oude acties met dit
 * type staan nog in data/owc.json en moeten leesbaar blijven in /gang historie.
 */
const ACTION = {
  HIRE: 'hire',
  FIRE: 'fire',
  HIRE_MEELOPER: 'hire_meeloper',
  LEFT_SERVER: 'left_server',
  MANUAL: 'manual',
  REVERT: 'revert',
  LEADERSHIP: 'leadership',
};

/** De drie rolsoorten binnen een gang. */
const ROLE_KIND = {
  GANG: 'gang',
  BOSS: 'boss',
  UNDERBOSS: 'underboss',
};

/** Vaste prefixen voor knop-customIds. Volledige id = `${BUTTON.X}:${extra}`. */
const BUTTON = {
  REVERT: 'owc:revert',
  CONFIRM_DELETE: 'owc:confirmdelete',
  CANCEL: 'owc:cancel',
};

/** Kleur van de hoofdrol van een gang. */
const GANG_ROLE_COLOR = 0x992d22;

/** Kleuren per rolsoort, in dezelfde aardse familie als GANG_ROLE_COLOR. */
const ROLE_COLORS = {
  gang: GANG_ROLE_COLOR,
  boss: 0xc0392b,
  underboss: 0xc27c0e,
};

/**
 * Welke rollen Discord apart bovenaan de ledenlijst zet ("Rolleden los van online leden
 * weergeven"). Elke gang krijgt zo eigen kopjes in de ledenlijst.
 *
 * Alle drie staan aan: Boss, Underboss en de gangrol krijgen elk een eigen kopje. Let op
 * hoe Discord dat toont: iemand staat maar onder EEN kopje, namelijk dat van zijn hoogste
 * apart weergegeven rol. Een boss verschijnt dus onder "<Gang> Boss" en niet meer onder
 * "<Gang>" - het kopje van de gangrol houdt de leden over die geen leiding zijn.
 *
 * Aanpassen? Zet de waarde hier om en draai daarna `/gangbeheer rolweergave`; dat zet de
 * instelling van alle bestaande gangrollen in één keer goed, beide kanten op.
 * @type {Readonly<Record<'gang'|'boss'|'underboss', boolean>>}
 */
const ROLE_HOIST = {
  gang: true,
  boss: true,
  underboss: true,
};

/** Achtervoegsels achter de gangnaam bij het maken van de rollen. */
const ROLE_SUFFIX = {
  boss: 'Boss',
  underboss: 'Underboss',
};

/** Maximaal aantal bewaarde acties per guild; oudere worden weggetrimd. */
const MAX_ACTIONS_KEPT = 5000;

/** Vaste footertekst onder elke embed. */
const EMBED_FOOTER = 'OWC Gangbeheer';

/**
 * Kant-en-klare permissiesets voor de gangcategorie (alle kanalen erven deze).
 * Elke waarde is een array van PermissionFlagsBits-bitfields die direct in
 * `permissionOverwrites` gebruikt kan worden, bijv.
 * `{ id: gang.roleId, allow: CATEGORY_PERMS.gang }`.
 *
 * De arrays zijn bevroren: kopieer ze (`[...CATEGORY_PERMS.gang]`) voordat je ze aanpast.
 * @type {Readonly<Record<'everyoneDeny'|'gang'|'underboss'|'boss'|'staff'|'bot'|'shared', ReadonlyArray<bigint>>>}
 */
const CATEGORY_PERMS = {
  // @everyone mag de categorie niet zien.
  everyoneDeny: [PermissionFlagsBits.ViewChannel],

  // Iedereen met de gangrol: lezen, chatten en in het oortje zitten om MEE TE LUISTEREN.
  // Bewust GEEN Speak/Stream: in het oortje geeft alleen de leiding orders; gewone leden
  // horen mee. Zie CHANNEL_PERMS.oortje voor de expliciete deny die dit afdwingt.
  gang: [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.SendMessagesInThreads,
    PermissionFlagsBits.AddReactions,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.UseExternalEmojis,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.UseVAD,
  ],

  // Underboss: modereren en spraakbeheer (zonder DeafenMembers/PrioritySpeaker).
  underboss: [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.MuteMembers,
    PermissionFlagsBits.MoveMembers,
  ],

  // Boss: alles van de underboss plus doof zetten en voorrang in spraak.
  boss: [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.MuteMembers,
    PermissionFlagsBits.DeafenMembers,
    PermissionFlagsBits.MoveMembers,
    PermissionFlagsBits.PrioritySpeaker,
  ],

  // Staffrol (alleen toevoegen als staffRoleId geconfigureerd is): overal bij, overal
  // typen, en in het oortje mogen praten.
  staff: [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.SendMessagesInThreads,
    PermissionFlagsBits.AddReactions,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.UseExternalEmojis,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.Speak,
    PermissionFlagsBits.Stream,
    PermissionFlagsBits.UseVAD,
  ],

  // Server-brede rollen die overal bij mogen (OWC, wapendealers): zien en typen in elk
  // gangkanaal, inclusief bosskanaal en dark-chat. Omdat een allow op de ene rol in Discord
  // wint van een deny op een andere rol, komen ze ook binnen in de kanalen die voor gewone
  // leden dichtstaan. In het oortje halen CHANNEL_PERMS.oortje.globalDeny hun spreekrechten
  // er weer af: daar praat niemand.
  global: [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.SendMessagesInThreads,
    PermissionFlagsBits.AddReactions,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.UseExternalEmojis,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.Speak,
    PermissionFlagsBits.Stream,
    PermissionFlagsBits.UseVAD,
  ],

  // De bot zelf, zodat hij zijn eigen kanalen kan blijven beheren.
  bot: [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.SendMessages,
  ],

  // Extra rechten die de gangrol krijgt in de gedeelde (server-brede) categorieen.
  shared: [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.AddReactions,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.Speak,
  ],
};

/**
 * Kanaal-specifieke overwrites bovenop CATEGORY_PERMS, per blueprint-kind.
 * Kanalen die hier niet in staan erven simpelweg alles van de categorie.
 *
 * `gangDeny` gaat op de gangrol, `leaderAllow` en `leaderDeny` op de boss- en underbossrol,
 * `staffAllow` op de staffrol, `everyoneDeny` op @everyone en `globalDeny` op de extrarollen
 * uit /setup extrarollen. Een recht dat in een deny-lijst staat wordt eerst uit de allow van
 * diezelfde rol gehaald, zodat er nooit een overwrite ontstaat die een recht tegelijk
 * toestaat en weigert.
 *
 * WAAROM WEIGEREN EN NIET GEWOON WEGLATEN: de bot schrijft overwrites weg met
 * `permissionOverwrites.edit()`, en dat is een merge. Een recht dat je uit een allow-lijst
 * haalt verdwijnt daarmee NIET van een kanaal dat het al had staan - je moet het expliciet
 * weigeren. Vandaar dat het oortje boss en underboss het spreekrecht actief afneemt in
 * plaats van het alleen niet meer uit te delen.
 * @type {Readonly<Record<string, Readonly<Record<'gangDeny'|'leaderAllow'|'leaderDeny'|'staffAllow'|'everyoneDeny'|'globalDeny', ReadonlyArray<bigint>>>>>}
 */
const CHANNEL_PERMS = {
  // Mededelingen: leden lezen alleen, boss en underboss mogen posten en opruimen.
  mededeling: {
    gangDeny: [
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.SendMessagesInThreads,
      PermissionFlagsBits.CreatePublicThreads,
    ],
    leaderAllow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages],
  },

  // Bosskanaal: alleen boss en underboss zien dit.
  boss: {
    gangDeny: [PermissionFlagsBits.ViewChannel],
    leaderAllow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
  },

  // Dark chat: net als het bosskanaal alleen voor boss en underboss. De deny staat op de
  // GANGROL zelf, want die heeft elk lid; boss en underboss krijgen het kijkrecht terug via
  // leaderAllow, en in Discord wint een allow op de ene rol van een deny op een andere.
  dark: {
    gangDeny: [PermissionFlagsBits.ViewChannel],
    leaderAllow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
  },

  // Oortje: alleen STAFF praat hier. Het is een luisterkanaal - het praten gebeurt in-game,
  // dit kanaal is alleen om erbij te zitten.
  //
  // De weigering moet op elke rol apart, want Discord laat een allow op de ene rol winnen
  // van een deny op een andere. @everyone vangt iedereen zonder eigen spreekrecht,
  // gangDeny de gangrol, leaderDeny de boss- en underbossrol (die hadden Speak eerder
  // expliciet toegestaan, en een merge haalt zo'n allow er nooit vanzelf af) en globalDeny
  // de extrarollen, die via CATEGORY_PERMS.global anders Speak zouden houden.
  //
  // Wat hier niet tegen helpt: het serverrecht Beheerder. Dat negeert alle kanaalrechten,
  // dus een admin kan altijd praten.
  oortje: {
    everyoneDeny: [PermissionFlagsBits.Speak, PermissionFlagsBits.Stream],
    gangDeny: [PermissionFlagsBits.Speak, PermissionFlagsBits.Stream],
    leaderDeny: [PermissionFlagsBits.Speak, PermissionFlagsBits.Stream],
    globalDeny: [PermissionFlagsBits.Speak, PermissionFlagsBits.Stream],
    staffAllow: [PermissionFlagsBits.Speak, PermissionFlagsBits.Stream],
  },
};

/**
 * Permissieset voor de twee 'flow'-kanalen van de server: #aangenomen en #ontslagen.
 *
 * WAAROM DIT BESTAAT: dit zijn registers voor de gangs onderling. Iedereen die in een gang
 * zit moet kunnen ZIEN wie er is aangenomen of ontslagen en de geschiedenis kunnen
 * teruglezen, maar alleen de bosses en underbosses van een gang (plus staff, de
 * server-brede rollen uit globalRoleIds en de bot zelf) mogen er iets IN zetten.
 *
 * Buiten de gangs om is het register dicht: @everyone krijgt ook geen kijkrecht. Wie geen
 * gangrol, staffrol of extrarol heeft, ziet het kanaal dus niet staan.
 *
 * En waarom via Discord-overwrites in plaats van via de bot? De bot kan een fout bericht
 * alleen ACHTERAF weigeren: het bericht staat dan al in het kanaal, wordt door iedereen
 * gelezen en blijft in de geschiedenis staan als er iets misgaat bij het opruimen (bot
 * offline, rate limit, geen ManageMessages). Met deze overwrites houdt Discord het bericht
 * al tegen bij het verzenden - er komt dus nooit rommel in het register te staan.
 *
 * Let op de deny-lijst: naast SendMessages moeten ook de thread-rechten dicht, anders
 * omzeilt iemand het kanaal simpelweg door een thread te openen en daarin te typen.
 *
 * De arrays zijn bevroren: kopieer ze (`[...FLOW_PERMS.leaderAllow]`) voordat je ze aanpast.
 * @type {Readonly<Record<'everyoneDeny'|'gangAllow'|'leaderAllow'|'staffAllow'|'botAllow', ReadonlyArray<bigint>>>}
 */
const FLOW_PERMS = {
  // @everyone: niets. Het register is er voor de gangs, dus ook het kijkrecht gaat dicht.
  // De thread-rechten moeten apart genoemd worden: een thread is anders een achterdeur naar
  // hetzelfde kanaal.
  everyoneDeny: [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.SendMessagesInThreads,
    PermissionFlagsBits.CreatePublicThreads,
    PermissionFlagsBits.CreatePrivateThreads,
  ],

  // De gangrol van elke gang: meelezen mag, typen niet. Hiermee ziet iedereen die in een
  // gang zit het hele register, terwijl alleen de leiding er iets in kan zetten. Zonder
  // deze allow zou de deny op @everyone hierboven ook de gewone leden buitensluiten.
  gangAllow: [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
  ],

  // Boss- en underbossrol van elke gang, en de server-brede rollen: die mogen posten.
  // Een allow op een rol wint in Discord van de deny op @everyone, dus SendMessages is
  // genoeg om de deny hierboven op te heffen. ViewChannel en ReadMessageHistory staan er
  // expliciet bij omdat het register in een categorie kan hangen die @everyone niet mag
  // zien: zonder dat eigen kijkrecht kan de gangleiding er dan helemaal niet meer bij.
  leaderAllow: [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.SendMessages,
  ],

  // Staff mag posten en foute regels opruimen. Ook hier het kijkrecht expliciet, om
  // dezelfde reden als bij leaderAllow.
  staffAllow: [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ManageMessages,
  ],

  // De bot zelf. ZONDER deze member-overwrite treft de @everyone-deny ook de bot en kan hij
  // niet meer antwoorden of reageren in het register - dat is de valkuil van deze aanpak.
  botAllow: [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AddReactions,
    PermissionFlagsBits.ManageMessages,
  ],
};

/**
 * Permissieset voor een leidingkanaal (/setup leidingkanaal): een server-breed kanaal waar
 * de leiding van ALLE gangs elkaar spreekt, zoals een gedeelde bosschat.
 *
 * Verschil met FLOW_PERMS: daar mag elke gangrol meelezen en alleen de leiding typen. Hier
 * komt de gangrol er helemaal niet in voor - een gewoon gangslid ziet het kanaal niet eens
 * staan. Alleen boss, underboss, staff, de extrarollen en de bot zitten erin, en die mogen
 * er allemaal ook in typen.
 *
 * De arrays zijn bevroren: kopieer ze voordat je ze aanpast.
 * @type {Readonly<Record<'everyoneDeny'|'leaderAllow'|'staffAllow'|'botAllow', ReadonlyArray<bigint>>>}
 */
const LEADER_PERMS = {
  // @everyone: het kanaal bestaat niet voor ze. De schrijfrechten gaan er ook af, zodat een
  // losse allow op een andere rol nooit per ongeluk typen toestaat aan wie alleen kijkt.
  everyoneDeny: [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.SendMessagesInThreads,
    PermissionFlagsBits.CreatePublicThreads,
    PermissionFlagsBits.CreatePrivateThreads,
  ],

  // Boss en underboss van elke gang, plus de server-brede extrarollen: lezen en typen.
  leaderAllow: [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.AddReactions,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.UseExternalEmojis,
  ],

  // Staff kan hier ook opruimen.
  staffAllow: [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.AddReactions,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ManageMessages,
  ],

  // De bot zelf, als member-overwrite: zonder dit treft de @everyone-deny ook hem.
  botAllow: [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AddReactions,
    PermissionFlagsBits.ManageMessages,
  ],
};

/**
 * Stelt de volledige kanaalnaam samen uit een blueprint-item en de gang-slug.
 * Voorbeeld: buildChannelName(CHANNEL_BLUEPRINT[0], 'rayuza') geeft de mededelingennaam.
 * Defensief: ontbrekende of ongeldige invoer levert nooit een te lange naam op.
 * @param {{kind?: string, emoji?: string, suffix?: string, fixedName?: string, useSlug?: boolean}} blueprintItem Item uit CHANNEL_BLUEPRINT.
 * @param {string} [slug] Slug van de gang (alleen gebruikt als useSlug true is).
 * @returns {string} De kanaalnaam, of '' als er geen bruikbaar item is meegegeven.
 */
function buildChannelName(blueprintItem, slug) {
  if (!blueprintItem || typeof blueprintItem !== 'object') return '';

  const emoji = typeof blueprintItem.emoji === 'string' ? blueprintItem.emoji : '';
  const suffix = typeof blueprintItem.suffix === 'string' ? blueprintItem.suffix : '';
  const kind = typeof blueprintItem.kind === 'string' ? blueprintItem.kind : '';
  const safeSlug = typeof slug === 'string' ? slug.trim().toLowerCase() : '';

  let base;
  if (blueprintItem.useSlug) {
    // Zonder slug vallen we terug op het achtervoegsel zonder streepje, dan op het kind.
    base = safeSlug ? `${safeSlug}${suffix}` : (suffix.replace(/^-+/, '') || kind);
  } else {
    base = (typeof blueprintItem.fixedName === 'string' && blueprintItem.fixedName) || kind;
  }

  if (!base) return '';
  return `${emoji}${CHANNEL_NAME_SEPARATOR}${base}`.slice(0, MAX_CHANNEL_NAME_LENGTH);
}

/**
 * Bevriest een object of array recursief, zodat constanten niet per ongeluk
 * gemuteerd worden door een van de services.
 * @param {*} value Waarde om te bevriezen.
 * @returns {*} Dezelfde waarde, bevroren.
 */
function deepFreeze(value) {
  if (value && (typeof value === 'object' || typeof value === 'function')) {
    Object.getOwnPropertyNames(value).forEach((key) => deepFreeze(value[key]));
    Object.freeze(value);
  }
  return value;
}

deepFreeze(CHANNEL_BLUEPRINT);
deepFreeze(CATEGORY_PERMS);
deepFreeze(CHANNEL_PERMS);
deepFreeze(FLOW_PERMS);
deepFreeze(COLORS);
deepFreeze(ACTION);
deepFreeze(ROLE_HOIST);
deepFreeze(ROLE_KIND);
deepFreeze(BUTTON);
deepFreeze(ROLE_COLORS);
deepFreeze(ROLE_SUFFIX);

module.exports = {
  CHANNEL_BLUEPRINT,
  CHANNEL_NAME_SEPARATOR,
  MAX_CHANNEL_NAME_LENGTH,
  DEFAULT_MEMBER_LIMIT,
  DEFAULT_BOSS_LIMIT,
  DEFAULT_UNDERBOSS_LIMIT,
  COLORS,
  ACTION,
  ROLE_KIND,
  BUTTON,
  CATEGORY_PERMS,
  CHANNEL_PERMS,
  FLOW_PERMS,
  LEADER_PERMS,
  GANG_ROLE_COLOR,
  ROLE_COLORS,
  ROLE_HOIST,
  ROLE_SUFFIX,
  MAX_ACTIONS_KEPT,
  EMBED_FOOTER,
  buildChannelName,
};
