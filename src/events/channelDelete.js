// src/events/channelDelete.js
// Er is een kanaal of categorie verwijderd in Discord. Hoorde dat bij het gangbeheer, dan
// meldt de bot dat meteen in het logkanaal met het commando dat het repareert.
//
// WAAROM DIT ER IS: zonder dit event merkt niemand het verschil. De bot ontdekte een
// verwijderd kanaal pas als iemand toevallig /gangbeheer herstel draaide, of als er een
// actie stukliep op een kanaal dat niet meer bestond - soms dagen later, en dan is niet
// meer te achterhalen wat er precies weg is.
//
// De opgeslagen id's blijven met opzet staan: /gangbeheer herstel gebruikt ze om te zien
// welk kanaal ontbreekt en maakt het dan opnieuw aan. Wissen we ze hier, dan weet het
// herstel niet meer wat het terug moet zetten.

const { Events, ChannelType } = require('discord.js');

const logger = require('../lib/logger');
const store = require('../store');
const logService = require('../services/logService');
const { warningEmbed } = require('../lib/embeds');

/**
 * Zoekt waar dit kanaal voor gebruikt werd binnen het gangbeheer.
 *
 * @param {string} guildId Server-id.
 * @param {string} channelId Id van het verwijderde kanaal.
 * @returns {{titel: string, uitleg: string, herstel: string}|null} Wat het was, of null.
 */
function herkenKanaal(guildId, channelId) {
  let config = null;
  let gangs = [];
  try {
    config = store.getGuildConfig(guildId);
    gangs = store.listGangs(guildId) || [];
  } catch (err) {
    logger.warn(`channelDelete: instellingen lezen mislukt (${err.message}).`);
    return null;
  }

  for (const gang of gangs) {
    if (gang?.categoryId === channelId) {
      return {
        titel: `Categorie van ${gang.name} verwijderd`,
        uitleg: `De hele categorie van **${gang.name}** is weg, en daarmee alle kanalen erin.`,
        herstel: `/gangbeheer herstel gang:${gang.name}`,
      };
    }
    const kanalen = gang?.channels && typeof gang.channels === 'object' ? gang.channels : {};
    for (const [soort, id] of Object.entries(kanalen)) {
      if (id === channelId) {
        return {
          titel: `Kanaal van ${gang.name} verwijderd`,
          uitleg: `Het **${soort}**-kanaal van **${gang.name}** bestaat niet meer.`,
          herstel: `/gangbeheer herstel gang:${gang.name}`,
        };
      }
    }
  }

  const serverKanalen = [
    { key: 'hireChannelId', label: 'aannamekanaal', herstel: '/setup kanalen aangenomen: #kanaal' },
    { key: 'fireChannelId', label: 'ontslagkanaal', herstel: '/setup kanalen ontslagen: #kanaal' },
    { key: 'logChannelId', label: 'logkanaal', herstel: '/setup kanalen logboek: #kanaal' },
    { key: 'dashboardChannelId', label: 'dashboardkanaal', herstel: '/setup dashboard kanaal: #kanaal' },
  ];
  for (const item of serverKanalen) {
    if (config?.[item.key] === channelId) {
      return {
        titel: `Het ${item.label} is verwijderd`,
        uitleg: `Het ingestelde ${item.label} bestaat niet meer, dus de bot kan er niets meer mee.`,
        herstel: item.herstel,
      };
    }
  }

  if (Array.isArray(config?.leaderChannelIds) && config.leaderChannelIds.includes(channelId)) {
    return {
      titel: 'Een leidingkanaal is verwijderd',
      uitleg: 'Dit kanaal stond in de lijst met leidingkanalen. Die verwijzing klopt nu niet meer.',
      herstel: '/setup leidingkanaal kanaal:#kanaal actie:verwijderen',
    };
  }

  if (Array.isArray(config?.sharedCategoryIds) && config.sharedCategoryIds.includes(channelId)) {
    return {
      titel: 'Een gedeelde categorie is verwijderd',
      uitleg: 'Deze categorie stond in de lijst met gedeelde categorieën. Die verwijzing klopt nu niet meer.',
      herstel: '/setup gedeelde-categorie categorie:#categorie actie:verwijderen',
    };
  }

  return null;
}

module.exports = {
  name: Events.ChannelDelete,
  once: false,

  /**
   * @param {import('discord.js').GuildChannel} channel Het verwijderde kanaal.
   * @returns {Promise<void>}
   */
  async execute(channel) {
    try {
      const guild = channel?.guild;
      if (!guild || !guild.id || typeof channel.id !== 'string') return;

      const gevonden = herkenKanaal(guild.id, channel.id);
      // Een kanaal dat niets met het gangbeheer te maken heeft gaat ons niet aan.
      if (!gevonden) return;

      const soort = channel.type === ChannelType.GuildCategory ? 'Categorie' : 'Kanaal';
      const embed = warningEmbed(gevonden.titel, [
        gevonden.uitleg,
        '',
        `${soort}: **${channel.name || channel.id}** (\`${channel.id}\`)`,
        `Herstellen: \`${gevonden.herstel}\``,
      ].join('\n'));

      await logService.logNotice(guild, embed);
      logger.warn(`channelDelete: ${gevonden.titel} (${channel.id}) in server ${guild.id}.`);
    } catch (err) {
      logger.error('Onverwachte fout bij het verwerken van een verwijderd kanaal', err);
    }
  },
};
