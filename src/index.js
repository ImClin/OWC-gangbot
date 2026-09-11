// src/index.js — opstartbestand van de OWC gangbot.
// Bouwt de Discord-client, laadt de commando's en events dynamisch uit hun mappen,
// zet de proceshandlers op en logt in bij Discord.

const fs = require('fs');
const path = require('path');
const { Client, Collection, GatewayIntentBits, Partials } = require('discord.js');

const config = require('./config');
const logger = require('./lib/logger');

/** Map met de slash-commando's; elk bestand exporteert { data, execute, autocomplete? }. */
const COMMANDS_DIR = path.join(__dirname, 'commands');

/** Map met de event-handlers; elk bestand exporteert { name, once, execute }. */
const EVENTS_DIR = path.join(__dirname, 'events');

/** Maximale wachttijd (ms) bij het afsluiten voordat het proces geforceerd stopt. */
const SHUTDOWN_TIMEOUT_MS = 5000;

/** @type {boolean} Voorkomt dat SIGINT en SIGTERM het afsluiten dubbel starten. */
let shuttingDown = false;

/**
 * Bouwt de Discord-client met de intents en partials die deze bot nodig heeft.
 * GuildMembers en MessageContent zijn privileged intents: die moeten in de
 * Discord Developer Portal aangezet staan, anders weigert Discord de login.
 *
 * @returns {import('discord.js').Client} Een nog niet ingelogde client met een lege commandolijst.
 */
function createClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
  });

  // Wordt door interactionCreate.js gebruikt om het juiste commando te vinden.
  client.commands = new Collection();
  return client;
}

/**
 * Zoekt alle laadbare .js-bestanden in een map. Ontbreekt de map of kan hij niet
 * gelezen worden, dan volgt een waarschuwing en een lege lijst (de bot start door).
 *
 * @param {string} dir Absoluut pad naar de map.
 * @param {string} label Woord voor in de logregels, bijv. "commando's".
 * @returns {string[]} Absolute paden, alfabetisch gesorteerd.
 */
function listModuleFiles(dir, label) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      logger.warn(`De map met ${label} bestaat niet: ${dir}. Er worden geen ${label} geladen.`);
    } else {
      logger.error(`De map met ${label} kon niet gelezen worden: ${dir} (${err.message})`);
    }
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js') && !entry.name.startsWith('_'))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

/**
 * Laadt alle slash-commando's uit src/commands in client.commands, met de naam uit
 * `command.data.name` als sleutel. Bestanden zonder geldige `data`/`execute` worden
 * overgeslagen met een waarschuwing; een kapot bestand mag de bot niet tegenhouden.
 *
 * @param {import('discord.js').Client} client De client met een `commands`-Collection.
 * @returns {string[]} De namen van de geladen commando's (zonder schuine streep).
 */
function loadCommands(client) {
  const files = listModuleFiles(COMMANDS_DIR, "commando's");
  const loaded = [];

  for (const file of files) {
    const bestand = path.basename(file);
    let command;
    try {
      command = require(file);
    } catch (err) {
      logger.error(`Commando ${bestand} kon niet geladen worden: ${err.message}`, err);
      continue;
    }

    const naam = command && command.data && typeof command.data.name === 'string'
      ? command.data.name
      : null;

    if (!naam || typeof command.execute !== 'function') {
      logger.warn(
        `Commando ${bestand} wordt overgeslagen: het bestand moet `
        + '{ data: SlashCommandBuilder, execute(interaction) } exporteren.',
      );
      continue;
    }

    if (client.commands.has(naam)) {
      logger.warn(`Commando /${naam} uit ${bestand} wordt overgeslagen: die naam is al geladen.`);
      continue;
    }

    client.commands.set(naam, command);
    loaded.push(naam);
    logger.debug(`Commando /${naam} geladen uit ${bestand}.`);
  }

  if (loaded.length === 0) {
    logger.warn("Er zijn geen commando's geladen; slash-commando's zullen niet werken.");
  } else {
    const lijst = loaded.map((naam) => `/${naam}`).join(', ');
    logger.info(`${loaded.length} commando(s) geladen: ${lijst}`);
  }
  return loaded;
}

/**
 * Verpakt een event-handler zodat een fout in dat event nooit een unhandled
 * rejection of een crash oplevert.
 *
 * @param {{name: string, execute: Function}} event De event-module.
 * @param {string} bestand Bestandsnaam, voor in de foutmelding.
 * @returns {(...args: any[]) => Promise<void>} De veilige handler.
 */
function wrapEvent(event, bestand) {
  return async (...args) => {
    try {
      await event.execute(...args);
    } catch (err) {
      logger.error(`Fout in event ${event.name} (${bestand}): ${err.message}`, err);
    }
  };
}

/**
 * Laadt alle events uit src/events en bindt ze aan de client: `client.once` als
 * het veld `once` waar is, anders `client.on`.
 *
 * @param {import('discord.js').Client} client De client waaraan gebonden wordt.
 * @returns {string[]} Beschrijvingen van de gebonden events, bijv. 'ready (eenmalig)'.
 */
function loadEvents(client) {
  const files = listModuleFiles(EVENTS_DIR, 'events');
  const loaded = [];

  for (const file of files) {
    const bestand = path.basename(file);
    let event;
    try {
      event = require(file);
    } catch (err) {
      logger.error(`Event ${bestand} kon niet geladen worden: ${err.message}`, err);
      continue;
    }

    const geldig = event
      && typeof event.name === 'string' && event.name.length > 0
      && typeof event.execute === 'function';

    if (!geldig) {
      logger.warn(
        `Event ${bestand} wordt overgeslagen: het bestand moet `
        + '{ name, once, execute } exporteren.',
      );
      continue;
    }

    const handler = wrapEvent(event, bestand);
    if (event.once === true) client.once(event.name, handler);
    else client.on(event.name, handler);

    loaded.push(`${event.name}${event.once === true ? ' (eenmalig)' : ''}`);
    logger.debug(`Event ${event.name} gebonden vanuit ${bestand}.`);
  }

  if (loaded.length === 0) {
    logger.warn('Er zijn geen events geladen; de bot reageert dan nergens op.');
  } else {
    logger.info(`${loaded.length} event(s) geladen: ${loaded.join(', ')}`);
  }
  return loaded;
}

/**
 * Schrijft de JSON-opslag weg naar schijf. De store schrijft elke wijziging al
 * atomisch en synchroon weg; dit is het vangnet bij het afsluiten.
 *
 * @returns {void}
 */
function flushStore() {
  try {
    const store = require('./store');
    if (typeof store.save === 'function') store.save();
    else if (typeof store.flush === 'function') store.flush();
    else logger.debug('De store schrijft elke wijziging direct weg; een extra flush is niet nodig.');
    logger.info('Gegevens opgeslagen.');
  } catch (err) {
    logger.error(`De gegevens konden bij het afsluiten niet weggeschreven worden: ${err.message}`);
  }
}

/**
 * Sluit de bot netjes af: opslag flushen, de Discord-verbinding verbreken en stoppen.
 * Een tweede signaal tijdens het afsluiten wordt genegeerd.
 *
 * @param {import('discord.js').Client} client De (mogelijk ingelogde) client.
 * @param {string} signaal Naam van het signaal, bijv. 'SIGINT'.
 * @returns {Promise<void>}
 */
async function shutdown(client, signaal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signaal} ontvangen — de bot wordt afgesloten...`);

  // Vangnet: blijft Discord hangen, dan stopt het proces alsnog.
  const noodstop = setTimeout(() => {
    logger.warn('Afsluiten duurt te lang; het proces wordt nu geforceerd gestopt.');
    process.exit(0);
  }, SHUTDOWN_TIMEOUT_MS);
  if (typeof noodstop.unref === 'function') noodstop.unref();

  flushStore();

  try {
    if (client && typeof client.destroy === 'function') {
      await client.destroy();
      logger.info('Verbinding met Discord gesloten.');
    }
  } catch (err) {
    logger.warn(`De Discord-verbinding kon niet netjes gesloten worden: ${err.message}`);
  }

  clearTimeout(noodstop);
  logger.info('Tot ziens.');
  process.exit(0);
}

/**
 * Zet de proceshandlers op: onverwachte fouten worden gelogd zonder het proces te
 * killen, SIGINT en SIGTERM sluiten netjes af.
 *
 * @param {import('discord.js').Client} client De client die afgesloten moet worden.
 * @returns {void}
 */
function registerProcessHandlers(client) {
  process.on('unhandledRejection', (reden) => {
    logger.error('Onafgehandelde promise-fout (de bot draait door):', reden);
  });

  process.on('uncaughtException', (err) => {
    logger.error('Onverwachte fout (de bot draait door):', err);
  });

  process.on('SIGINT', () => { shutdown(client, 'SIGINT'); });
  process.on('SIGTERM', () => { shutdown(client, 'SIGTERM'); });
}

/**
 * Startpunt: controleert de configuratie, laadt commando's en events en logt in.
 *
 * @returns {Promise<void>}
 */
async function start() {
  try {
    config.assertConfig();
  } catch (err) {
    // Bewust zonder stacktrace: dit is een instructie voor de beheerder, geen bug.
    logger.error(`De bot kan niet starten.\n${err.message}`);
    process.exit(1);
    return;
  }

  logger.info('OWC gangbot wordt gestart...');
  const client = createClient();
  registerProcessHandlers(client);
  loadCommands(client);
  loadEvents(client);
  logger.info(`Datamap: ${config.dataDir}`);
  logger.info(
    config.guildId
      ? `Doelserver uit .env: ${config.guildId}.`
      : "Geen GUILD_ID ingesteld: slash-commando's worden globaal geregistreerd.",
  );

  try {
    await client.login(config.token);
  } catch (err) {
    logger.error(
      'Inloggen bij Discord is mislukt. Controleer het volgende:\n'
      + '  - Klopt DISCORD_TOKEN in je .env-bestand? (Developer Portal > Bot > Reset Token)\n'
      + '  - Staan "Server Members Intent" en "Message Content Intent" aan bij Bot > Privileged Gateway Intents?\n'
      + '  - Heeft de server internetverbinding?\n'
      + `  - Melding van Discord: ${err.message}`,
    );
    process.exit(1);
  }
}

// Alleen starten als dit bestand direct gedraaid wordt (`npm start` / `node src/index.js`),
// zodat `require('./index')` in een test de bot niet ongevraagd laat inloggen.
if (require.main === module) start();

module.exports = { createClient, loadCommands, loadEvents, shutdown, start };
