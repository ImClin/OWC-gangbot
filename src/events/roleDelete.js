// src/events/roleDelete.js
// Er is een rol verwijderd in Discord. Hoorde die bij het gangbeheer, dan meldt de bot dat
// meteen in het logkanaal, met het commando dat het rechtzet.
//
// Een verwijderde gangrol is ingrijpender dan een verwijderd kanaal: iedereen die hem droeg
// is in één klap geen lid meer, de bezetting klopt niet meer en de registerkanalen laten die
// mensen niet meer typen. Dat hoort niet stilletjes te gebeuren.
//
// De opgeslagen id's blijven met opzet staan: /gangbeheer herstel ziet daaraan welke rol
// ontbreekt en maakt hem opnieuw aan (leeg, want de leden zijn hun rol kwijt).

const { Events } = require('discord.js');

const logger = require('../lib/logger');
const store = require('../store');
const logService = require('../services/logService');
const { warningEmbed } = require('../lib/embeds');

/** De drie rolvelden van een gang, met hun Nederlandse naam. */
const GANG_ROL_VELDEN = [
  { key: 'roleId', label: 'gangrol' },
  { key: 'bossRoleId', label: 'bossrol' },
  { key: 'underbossRoleId', label: 'underbossrol' },
];

/**
 * Zoekt waar deze rol voor gebruikt werd binnen het gangbeheer.
 *
 * @param {string} guildId Server-id.
 * @param {string} roleId Id van de verwijderde rol.
 * @returns {{titel: string, uitleg: string, herstel: string}|null} Wat het was, of null.
 */
function herkenRol(guildId, roleId) {
  let config = null;
  let gangs = [];
  try {
    config = store.getGuildConfig(guildId);
    gangs = store.listGangs(guildId) || [];
  } catch (err) {
    logger.warn(`roleDelete: instellingen lezen mislukt (${err.message}).`);
    return null;
  }

  for (const gang of gangs) {
    for (const veld of GANG_ROL_VELDEN) {
      if (gang?.[veld.key] !== roleId) continue;
      return {
        titel: `De ${veld.label} van ${gang.name} is verwijderd`,
        uitleg: veld.key === 'roleId'
          ? `Iedereen die bij **${gang.name}** zat is daarmee zijn gangrol kwijt. De bezetting `
            + 'klopt niet meer en die leden komen de gangkanalen niet meer in.'
          : `**${gang.name}** heeft daardoor geen ${veld.label} meer. Wie hem droeg is zijn `
            + 'leidingsrechten kwijt, maar houdt wel de gangrol.',
        herstel: `/gangbeheer herstel gang:${gang.name}`,
      };
    }
  }

  const serverRollen = [
    {
      key: 'staffRoleId',
      titel: 'De staffrol is verwijderd',
      uitleg: 'Niemand geldt nog als staff via die rol. Wie het serverrecht **Server beheren** '
        + 'heeft, blijft wel staff voor de bot.',
      herstel: '/setup staffrol rol:@rol',
    },
    {
      key: 'alertRoleId',
      titel: 'De meldrol is verwijderd',
      uitleg: 'Meldingen komen nog in het logkanaal, maar zonder ping.',
      herstel: '/setup meldrol rol:@rol',
    },
    {
      key: 'roleFloorId',
      titel: 'De bodemrol is verwijderd',
      uitleg: 'De ondergrens voor de gangrollen is weg; ze worden voortaan alleen nog boven '
        + '@everyone gehouden.',
      herstel: '/setup bodemrol rol:@rol',
    },
  ];
  for (const item of serverRollen) {
    if (config?.[item.key] === roleId) return item;
  }

  if (Array.isArray(config?.globalRoleIds) && config.globalRoleIds.includes(roleId)) {
    return {
      titel: 'Een extrarol is verwijderd',
      uitleg: 'Deze rol gaf toegang tot alle gangkanalen en staat nog in de lijst, terwijl hij '
        + 'niet meer bestaat.',
      herstel: '/setup extrarollen rol:@rol actie:verwijderen',
    };
  }

  return null;
}

module.exports = {
  name: Events.GuildRoleDelete,
  once: false,

  /**
   * @param {import('discord.js').Role} role De verwijderde rol.
   * @returns {Promise<void>}
   */
  async execute(role) {
    try {
      const guild = role?.guild;
      if (!guild || !guild.id || typeof role.id !== 'string') return;

      const gevonden = herkenRol(guild.id, role.id);
      // Een rol die niets met het gangbeheer te maken heeft gaat ons niet aan.
      if (!gevonden) return;

      const embed = warningEmbed(gevonden.titel, [
        gevonden.uitleg,
        '',
        `Rol: **${role.name || role.id}** (\`${role.id}\`)`,
        `Herstellen: \`${gevonden.herstel}\``,
      ].join('\n'));

      await logService.logNotice(guild, embed);
      logger.warn(`roleDelete: ${gevonden.titel} (${role.id}) in server ${guild.id}.`);
    } catch (err) {
      logger.error('Onverwachte fout bij het verwerken van een verwijderde rol', err);
    }
  },
};
