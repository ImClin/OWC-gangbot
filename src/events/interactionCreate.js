// src/events/interactionCreate.js
// Router voor alles wat via de Discord-interface binnenkomt:
//  - slash-commando's  -> client.commands.get(naam).execute(interaction)
//  - autocomplete      -> command.autocomplete(interaction)
//  - knoppen           -> owc:revert:<actieId> wordt hier afgehandeld;
//                         owc:confirmdelete:... en owc:cancel:... gaan onbewerkt
//                         naar commands/gang.js -> handleButton() (enige afhandelaar)
//
// Regels in dit bestand:
//  - er ontsnapt nooit een fout: alles wordt gelogd en de gebruiker krijgt een
//    ephemeral melding;
//  - voordat er geantwoord wordt, controleren we altijd interaction.replied /
//    interaction.deferred zodat reply/editReply/followUp nooit botsen;
//  - onbekende interacties worden stil genegeerd (debug-log).

const { Events, MessageFlags } = require('discord.js');

const logger = require('../lib/logger');
const store = require('../store');
const membershipService = require('../services/membershipService');
const logService = require('../services/logService');
const dashboardService = require('../services/dashboardService');
const { BUTTON } = require('../lib/constants');
const { isStaff } = require('../lib/permissions');
const { truncate } = require('../lib/parse');
const {
  successEmbed, errorEmbed, warningEmbed,
} = require('../lib/embeds');

/* -------------------------------------------------------------------------- */
/* Antwoord-helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Beantwoordt een interactie ephemeral, met de juiste methode voor de huidige staat:
 * editReply na een defer, followUp als er al geantwoord is, anders reply.
 *
 * @param {import('discord.js').BaseInteraction} interaction De interactie.
 * @param {import('discord.js').EmbedBuilder} embed De embed voor de gebruiker.
 * @returns {Promise<void>}
 */
async function answer(interaction, embed) {
  try {
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply({ embeds: [embed] });
      return;
    }
    if (interaction.replied) {
      await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  } catch (err) {
    logger.warn(`Kon niet antwoorden op interactie ${interaction?.id}: ${err?.message || err}`);
  }
}

/**
 * Haalt het GuildMember-object van de klikker op; `interaction.member` kan een kale
 * API-structuur zonder rolcache zijn.
 *
 * @param {import('discord.js').BaseInteraction} interaction De interactie.
 * @returns {Promise<import('discord.js').GuildMember|null>} Het lid, of null.
 */
async function resolveMember(interaction) {
  const member = interaction.member;
  if (member && member.roles && member.roles.cache) return member;
  try {
    return await interaction.guild.members.fetch(interaction.user.id);
  } catch (err) {
    logger.warn(`Kon het serverprofiel van ${interaction.user?.id} niet ophalen: ${err?.message || err}`);
    return null;
  }
}

/**
 * Leest de serverconfiguratie zonder te gooien.
 *
 * @param {string} guildId Server-id.
 * @returns {object} De configuratie (leeg object bij een fout).
 */
function readConfig(guildId) {
  try {
    return store.getGuildConfig(guildId) || {};
  } catch (err) {
    logger.error(`Serverconfiguratie van ${guildId} kon niet gelezen worden`, err);
    return {};
  }
}

/**
 * Zoekt het commandomodule-object op naam in client.commands.
 *
 * @param {import('discord.js').BaseInteraction} interaction De interactie.
 * @param {string} name Naam van het commando.
 * @returns {object|null} De module, of null.
 */
function getCommand(interaction, name) {
  const commands = interaction.client?.commands;
  if (!commands || typeof commands.get !== 'function' || !name) return null;
  return commands.get(name) || null;
}

/**
 * Werkt het dashboard bij zonder erop te wachten.
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
/* Slash-commando's en autocomplete                                           */
/* -------------------------------------------------------------------------- */

/**
 * Voert een slash-commando uit.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction De interactie.
 * @returns {Promise<void>}
 */
async function handleCommand(interaction) {
  const command = getCommand(interaction, interaction.commandName);
  if (!command || typeof command.execute !== 'function') {
    logger.warn(`Onbekend commando /${interaction.commandName} aangeroepen.`);
    await answer(
      interaction,
      errorEmbed(
        'Onbekend commando',
        `\`/${interaction.commandName}\` is hier niet (meer) beschikbaar. Laat staff \`npm run deploy\` uitvoeren.`,
      ),
    );
    return;
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    logger.error(`Commando /${interaction.commandName} mislukt`, err);
    await answer(
      interaction,
      errorEmbed(
        'Er ging iets mis',
        `Het commando kon niet uitgevoerd worden: ${truncate(String(err?.message || 'onbekende fout'), 200)}`,
      ),
    );
  }
}

/**
 * Beantwoordt een autocomplete-verzoek via het commando zelf; lukt dat niet, dan
 * sturen we een lege lijst zodat Discord niet blijft laden.
 *
 * @param {import('discord.js').AutocompleteInteraction} interaction De interactie.
 * @returns {Promise<void>}
 */
async function handleAutocomplete(interaction) {
  const command = getCommand(interaction, interaction.commandName);
  if (!command || typeof command.autocomplete !== 'function') {
    await respondEmpty(interaction);
    return;
  }
  try {
    await command.autocomplete(interaction);
  } catch (err) {
    logger.warn(`Autocomplete van /${interaction.commandName} mislukt: ${err?.message || err}`);
    await respondEmpty(interaction);
  }
}

/**
 * Stuurt een lege keuzelijst terug (alleen als er nog niet geantwoord is).
 *
 * @param {import('discord.js').AutocompleteInteraction} interaction De interactie.
 * @returns {Promise<void>}
 */
async function respondEmpty(interaction) {
  try {
    if (!interaction.responded) await interaction.respond([]);
  } catch (err) {
    logger.debug(`Lege autocomplete kon niet verstuurd worden: ${err?.message || err}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Knop: terugdraaien                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Handelt de knop 'Terugdraaien' onder een logbericht af (customId
 * `owc:revert:<actieId>`). Alleen staff mag terugdraaien; daarna wordt het
 * oorspronkelijke logbericht bijgewerkt via logService.markReverted.
 *
 * @param {import('discord.js').ButtonInteraction} interaction De knopinteractie.
 * @param {string} rawId Het actie-id uit de customId.
 * @returns {Promise<void>}
 */
async function handleRevertButton(interaction, rawId) {
  const guild = interaction.guild;
  const member = await resolveMember(interaction);
  const config = readConfig(guild.id);

  if (!member || !isStaff(member, config)) {
    await answer(
      interaction,
      errorEmbed('Alleen voor staff', 'Alleen staff mag een actie terugdraaien. Vraag een staflid om hulp.'),
    );
    return;
  }

  const actionId = Number.parseInt(String(rawId), 10);
  if (!Number.isInteger(actionId) || actionId <= 0) {
    await answer(interaction, errorEmbed('Onbruikbare knop', 'Deze knop hoort niet bij een geldige actie.'));
    return;
  }

  let action = null;
  try {
    action = store.getAction(guild.id, actionId);
  } catch (err) {
    logger.error(`Actie #${actionId} kon niet gelezen worden`, err);
  }
  if (!action) {
    await answer(
      interaction,
      errorEmbed('Actie niet gevonden', `Actie #${actionId} staat niet meer in het logboek en kan niet teruggedraaid worden.`),
    );
    return;
  }

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } catch (err) {
    logger.warn(`Terugdraaien kon niet uitgesteld worden: ${err?.message || err}`);
    return;
  }

  const result = await membershipService.revertAction(guild, action, member);
  if (!result || !result.ok) {
    await answer(interaction, errorEmbed('Terugdraaien mislukt', truncate(String(result?.error || 'onbekende fout'), 1000)));
    return;
  }

  try {
    await logService.markReverted(guild, result.action);
  } catch (err) {
    logger.warn(`Logbericht van actie #${actionId} kon niet bijgewerkt worden: ${err?.message || err}`);
  }
  refreshDashboard(guild);
  await answer(
    interaction,
    successEmbed('Actie teruggedraaid', truncate(String(result.message || `Actie #${actionId} is teruggedraaid.`), 1000)),
  );
}

/* -------------------------------------------------------------------------- */
/* Knoppen: gang verwijderen bevestigen / annuleren                           */
/* -------------------------------------------------------------------------- */

/**
 * Geeft de knoppen `owc:confirmdelete:<gangId>:<rollen 0|1>:<eigenaarId>` en
 * `owc:cancel:<gangId>:<rollen 0|1>:<eigenaarId>` door aan de enige afhandelaar:
 * `handleButton()` in src/commands/gang.js.
 *
 * WAAROM dit bestand hier zelf niets meer doet: eerder handelde `/gangbeheer verwijderen` zijn
 * knoppen met een collector af TERWIJL dit bestand er een eigen terugvalpad voor had. Die
 * twee raceten om dezelfde klik (de wachttijd van 400 ms was een gok, want
 * ButtonInteraction#update zet `replied` pas ná de REST-call), waardoor
 * gangService.deleteGang twee keer op dezelfde gang kon draaien. Erger nog: dat
 * terugvalpad las de rollenvlag uit een customId die alleen de gang-id bevatte en
 * verwijderde daardoor altijd alle gangrollen, ook bij `rollen_verwijderen: false`.
 * Voeg hier dus nooit een tweede afhandeling toe: alle context zit in de customId en
 * gang.js beslist — dat werkt ook nog na een herstart van de bot.
 *
 * @param {import('discord.js').ButtonInteraction} interaction De knopinteractie.
 * @returns {Promise<void>}
 */
async function handleDeleteButtons(interaction) {
  const command = getCommand(interaction, 'gang');
  if (!command || typeof command.handleButton !== 'function') {
    logger.error('/gang exporteert geen handleButton(); de verwijderknoppen kunnen niet afgehandeld worden.');
    await answer(
      interaction,
      errorEmbed(
        'Knop werkt niet meer',
        'Deze knop kan nu niet afgehandeld worden en er is niets verwijderd.'
          + ' Voer `/gangbeheer verwijderen` opnieuw uit; blijft het misgaan, meld het dan bij de staff.',
      ),
    );
    return;
  }

  let handled = false;
  try {
    handled = await command.handleButton(interaction);
  } catch (err) {
    logger.error(`Knop ${interaction.customId} kon niet afgehandeld worden`, err);
    await answer(
      interaction,
      errorEmbed(
        'Er ging iets mis',
        `De knop kon niet verwerkt worden (${truncate(String(err?.message || 'onbekende fout'), 200)}).`
          + ' Controleer met `/gang lijst` of de gang er nog staat en probeer het opnieuw.',
      ),
    );
    return;
  }
  if (handled) return;

  logger.warn(`Knop ${interaction.customId} werd door /gang niet herkend.`);
  await answer(
    interaction,
    warningEmbed(
      'Knop niet herkend',
      'Deze knop hoort niet bij een lopende bevestiging. Er is niets verwijderd;'
        + ' voer `/gangbeheer verwijderen` opnieuw uit.',
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* Knoprouter                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Stuurt een knopklik naar de juiste afhandeling. Knoppen die niet met `owc:`
 * beginnen zijn niet van ons en worden genegeerd.
 *
 * @param {import('discord.js').ButtonInteraction} interaction De knopinteractie.
 * @returns {Promise<void>}
 */
async function handleButton(interaction) {
  const customId = typeof interaction.customId === 'string' ? interaction.customId : '';
  if (!customId.startsWith('owc:')) {
    logger.debug(`Knop ${customId} is niet van deze bot; genegeerd.`);
    return;
  }
  if (!interaction.guild) {
    await answer(interaction, warningEmbed('Alleen in een server', 'Deze knop werkt alleen binnen een server.'));
    return;
  }

  const parts = customId.split(':');
  const prefix = `${parts[0]}:${parts[1] || ''}`;

  if (prefix === BUTTON.REVERT) {
    await handleRevertButton(interaction, parts[2]);
    return;
  }
  if (prefix === BUTTON.CONFIRM_DELETE || prefix === BUTTON.CANCEL) {
    await handleDeleteButtons(interaction);
    return;
  }
  logger.debug(`Onbekende knop ${customId} genegeerd.`);
}

module.exports = {
  name: Events.InteractionCreate,
  once: false,

  /**
   * Routeert elke binnenkomende interactie: slash-commando's, autocomplete en knoppen.
   * Vangt alles af; een gebruiker krijgt bij een fout altijd een ephemeral melding en
   * de bot blijft draaien.
   *
   * @param {import('discord.js').BaseInteraction} interaction De interactie.
   * @returns {Promise<void>}
   */
  async execute(interaction) {
    try {
      if (interaction.isChatInputCommand?.()) {
        await handleCommand(interaction);
        return;
      }
      if (interaction.isAutocomplete?.()) {
        await handleAutocomplete(interaction);
        return;
      }
      if (interaction.isButton?.()) {
        await handleButton(interaction);
        return;
      }
      logger.debug(`Interactietype ${interaction?.type} wordt niet afgehandeld; genegeerd.`);
    } catch (err) {
      logger.error('Onverwachte fout bij het afhandelen van een interactie', err);
      if (interaction && typeof interaction.isAutocomplete === 'function' && interaction.isAutocomplete()) {
        await respondEmpty(interaction);
        return;
      }
      if (interaction && typeof interaction.isRepliable === 'function' && interaction.isRepliable()) {
        await answer(
          interaction,
          errorEmbed('Er ging iets mis', 'Deze actie kon niet uitgevoerd worden. Probeer het opnieuw of meld het bij staff.'),
        );
      }
    }
  },
};
