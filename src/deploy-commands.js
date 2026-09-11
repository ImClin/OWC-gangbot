// src/deploy-commands.js — registreert de slash-commando's bij Discord.
// Draai dit met `npm run deploy` na elke wijziging aan src/commands.
// Is GUILD_ID gezet in .env, dan worden de commando's op die ene server gezet
// (direct zichtbaar). Zonder GUILD_ID gaan ze globaal (kan tot een uur duren).

const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');

const config = require('./config');
const logger = require('./lib/logger');

/** Map met de slash-commando's; elk bestand exporteert { data, execute }. */
const COMMANDS_DIR = path.join(__dirname, 'commands');

/**
 * Leest src/commands uit en zet elk geldig commando om naar het JSON-formaat
 * dat de Discord-API verwacht. Ongeldige bestanden worden overgeslagen met uitleg.
 *
 * @returns {{body: object[], names: string[], skipped: number}}
 *   `body` = de payload voor de REST-call, `names` = de commandonamen in dezelfde
 *   volgorde, `skipped` = aantal overgeslagen bestanden.
 */
function collectCommands() {
  const body = [];
  const names = [];
  let skipped = 0;

  let entries;
  try {
    entries = fs.readdirSync(COMMANDS_DIR, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      logger.error(`De map met commando's bestaat niet: ${COMMANDS_DIR}`);
    } else {
      logger.error(`De map met commando's kon niet gelezen worden: ${err.message}`);
    }
    return { body, names, skipped };
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js') && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort();

  for (const bestand of files) {
    const volledigPad = path.join(COMMANDS_DIR, bestand);
    let command;
    try {
      command = require(volledigPad);
    } catch (err) {
      logger.error(`Commando ${bestand} kon niet geladen worden: ${err.message}`);
      skipped += 1;
      continue;
    }

    const data = command && command.data;
    if (!data || typeof data.name !== 'string' || typeof command.execute !== 'function') {
      logger.warn(
        `Commando ${bestand} wordt overgeslagen: het bestand moet `
        + '{ data: SlashCommandBuilder, execute(interaction) } exporteren.',
      );
      skipped += 1;
      continue;
    }

    let json;
    try {
      json = typeof data.toJSON === 'function' ? data.toJSON() : data;
    } catch (err) {
      logger.error(
        `Commando /${data.name} (${bestand}) is ongeldig opgebouwd en wordt overgeslagen: ${err.message}`,
      );
      skipped += 1;
      continue;
    }

    if (names.includes(json.name)) {
      logger.warn(`Commando /${json.name} uit ${bestand} wordt overgeslagen: die naam staat er al in.`);
      skipped += 1;
      continue;
    }

    body.push(json);
    names.push(json.name);
  }

  return { body, names, skipped };
}

/**
 * Vertaalt een REST-fout naar begrijpelijke Nederlandse uitleg met een oplossing.
 *
 * @param {any} err De fout uit de REST-call (DiscordAPIError, HTTPError of netwerkfout).
 * @returns {string} Meerdere regels tekst, klaar om te loggen.
 */
function explainRestError(err) {
  const status = err && typeof err.status === 'number' ? err.status : null;
  const code = err && (typeof err.code === 'number' || typeof err.code === 'string') ? err.code : null;
  const melding = err && err.message ? err.message : 'onbekende fout';

  if (status === 401 || code === 0) {
    return 'Discord accepteert het token niet (401 Unauthorized).\n'
      + '  - Controleer DISCORD_TOKEN in .env; kopieer hem opnieuw via\n'
      + '    Developer Portal > jouw applicatie > Bot > Reset Token.\n'
      + '  - Let op: het token is niet hetzelfde als de Client Secret of de Public Key.';
  }

  if (status === 403 || code === 50001) {
    return config.guildId
      ? 'Geen toegang tot deze server (403 / Missing Access).\n'
        + `  - Staat de bot wel in server ${config.guildId}?\n`
        + '  - Is de bot uitgenodigd met de scope "applications.commands" naast "bot"?\n'
        + '    Nodig hem opnieuw uit via Developer Portal > OAuth2 > URL Generator met beide scopes.'
      : 'Geen toegang (403 / Missing Access).\n'
        + '  - Is de bot uitgenodigd met de scope "applications.commands"?';
  }

  if (status === 404 || code === 10002 || code === 10004) {
    return 'Discord kent deze applicatie of server niet (404).\n'
      + `  - Klopt CLIENT_ID (${config.clientId || 'leeg'})? Dit is de Application ID uit General Information.\n`
      + (config.guildId ? `  - Klopt GUILD_ID (${config.guildId})? Zet Discord op ontwikkelaarsmodus en kopieer het server-ID.\n` : '')
      + '  - Staat de bot in de server?';
  }

  if (code === 50035) {
    const details = err && err.rawError ? JSON.stringify(err.rawError.errors || err.rawError) : melding;
    return 'Discord keurt een commando-definitie af (50035 Invalid Form Body).\n'
      + '  - Controleer namen (lowercase, geen spaties), beschrijvingen (1-100 tekens)\n'
      + '    en het aantal opties per commando.\n'
      + `  - Details van Discord: ${details}`;
  }

  if (code === 30034) {
    return "Het daglimiet voor het aanmaken van commando's is bereikt (30034).\n"
      + '  - Wacht 24 uur of gebruik een testserver via GUILD_ID.';
  }

  if (status === 429) {
    return 'Discord vraagt om af te remmen (429 Rate limited).\n'
      + '  - Wacht een minuut en probeer het opnieuw.';
  }

  const netwerk = err && (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT'
    || /fetch failed|network|getaddrinfo/i.test(melding));
  if (netwerk) {
    return 'Er kon geen verbinding met Discord gemaakt worden.\n'
      + '  - Controleer de internetverbinding, DNS of een firewall/proxy.\n'
      + `  - Technische melding: ${melding}`;
  }

  return `Onverwachte fout bij het registreren: ${melding}`
    + (status ? ` (HTTP-status ${status})` : '')
    + (code !== null ? ` (Discord-code ${code})` : '');
}

/**
 * Meldt per commando of Discord het teruggeeft als geregistreerd.
 *
 * @param {string[]} verstuurd Namen die zijn aangeboden.
 * @param {any} antwoord Het antwoord van de REST-call (normaal een array met commando's).
 * @returns {void}
 */
function reportResult(verstuurd, antwoord) {
  const geregistreerd = Array.isArray(antwoord)
    ? antwoord.map((cmd) => (cmd && typeof cmd.name === 'string' ? cmd.name : '')).filter(Boolean)
    : [];

  for (const naam of verstuurd) {
    if (geregistreerd.includes(naam)) logger.info(`  /${naam} — geregistreerd`);
    else logger.warn(`  /${naam} — niet teruggevonden in het antwoord van Discord; controleer dit commando`);
  }

  for (const naam of geregistreerd) {
    if (!verstuurd.includes(naam)) logger.info(`  /${naam} — door Discord teruggegeven maar niet aangeboden`);
  }
}

/**
 * Voert de registratie uit: configuratie controleren, commando's verzamelen en
 * via REST wegzetten (guild als GUILD_ID gezet is, anders globaal).
 *
 * @returns {Promise<void>} Beëindigt het proces met code 1 als er iets misgaat.
 */
async function main() {
  try {
    config.assertConfig();
  } catch (err) {
    // Geen stacktrace: dit is een instructie voor de beheerder, geen bug.
    logger.error(`Registreren kan niet starten.\n${err.message}`);
    process.exit(1);
    return;
  }

  const { body, names, skipped } = collectCommands();
  if (body.length === 0) {
    logger.error(
      `Er zijn geen geldige commando's gevonden in ${COMMANDS_DIR}. Er is niets geregistreerd.`,
    );
    process.exit(1);
    return;
  }

  const doel = config.guildId ? `server ${config.guildId}` : 'alle servers (globaal)';
  logger.info(`${body.length} commando(s) worden geregistreerd voor ${doel}: ${names.map((n) => `/${n}`).join(', ')}`);
  if (skipped > 0) logger.warn(`${skipped} bestand(en) overgeslagen; zie de meldingen hierboven.`);

  const rest = new REST({ version: '10' }).setToken(config.token);
  const route = config.guildId
    ? Routes.applicationGuildCommands(config.clientId, config.guildId)
    : Routes.applicationCommands(config.clientId);

  try {
    const antwoord = await rest.put(route, { body });
    logger.info('Discord heeft de registratie geaccepteerd:');
    reportResult(names, antwoord);
    logger.info(
      config.guildId
        ? 'Klaar. Serverspecifieke commando\'s zijn direct beschikbaar; herlaad Discord met Ctrl+R als je ze nog niet ziet.'
        : 'Klaar. Globale commando\'s kunnen tot een uur duren voordat ze overal zichtbaar zijn.',
    );
  } catch (err) {
    logger.error(`Registreren is mislukt.\n${explainRestError(err)}`);
    process.exit(1);
  }
}

// Alleen uitvoeren als dit bestand direct gedraaid wordt (`npm run deploy`).
if (require.main === module) {
  main().catch((err) => {
    logger.error(`Onverwachte fout tijdens het registreren: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
}

module.exports = { collectCommands, explainRestError, main };
