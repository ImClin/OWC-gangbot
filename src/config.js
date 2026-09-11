// src/config.js — leest de omgevingsvariabelen uit .env en stelt ze centraal beschikbaar.
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./lib/logger');

/** Projectroot = de map boven src/. */
const PROJECT_ROOT = path.resolve(__dirname, '..');

// .env staat naast het project, niet per se in de map waar de bot gestart wordt.
// Zonder expliciet pad zoekt dotenv in process.cwd() en vindt hij niets zodra je de bot
// vanaf een andere map of via een dienst/taakplanner start.
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env') });

/** Discord-ID's (snowflakes) zijn 17 t/m 20 cijfers. */
const SNOWFLAKE_RE = /^\d{17,20}$/;

/**
 * Leest een omgevingsvariabele en trimt spaties/aanhalingstekens weg.
 * @param {string} name Naam van de omgevingsvariabele.
 * @returns {string} De waarde, of '' als hij ontbreekt.
 */
function readEnv(name) {
  const raw = process.env[name];
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/^["']|["']$/g, '').trim();
}

/** @type {string} Bot-token uit process.env.DISCORD_TOKEN ('' als niet gezet). */
const token = readEnv('DISCORD_TOKEN');

/** @type {string} Application-ID uit process.env.CLIENT_ID ('' als niet gezet). */
const clientId = readEnv('CLIENT_ID');

/** @type {string|null} Server-ID uit process.env.GUILD_ID; null = commands globaal registreren. */
const guildId = readEnv('GUILD_ID') || null;

/**
 * Vult ~ en omgevingsvariabelen in een pad in, zodat hetzelfde .env-bestand zowel
 * op je eigen pc als op een hostingserver werkt:
 *   ~/OWC-gangbot-data -> C:\Users\jouwnaam\OWC-gangbot-data of /home/container/OWC-gangbot-data
 * Ook %USERPROFILE% (Windows) en $HOME / ${HOME} (Linux/macOS) worden ingevuld.
 * @param {string} waarde Het pad zoals het in .env staat.
 * @returns {string} Het pad met alles ingevuld; '' blijft ''.
 */
function expandPath(waarde) {
  if (!waarde) return '';
  let pad = waarde;
  if (pad === '~' || pad.startsWith('~/') || pad.startsWith('~\\')) {
    pad = path.join(os.homedir(), pad.slice(1));
  }
  pad = pad.replace(/%([^%\s]+)%/g, (heel, naam) => process.env[naam] || heel);
  pad = pad.replace(
    /\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (heel, metAccolades, zonderAccolades) => process.env[metAccolades || zonderAccolades] || heel,
  );
  return pad;
}

/** @type {string} DATA_DIR uit .env, met ~ en variabelen ingevuld ('' = standaardmap). */
const dataDirUitEnv = expandPath(readEnv('DATA_DIR'));

/**
 * Een Windows-pad (C:\...) op een Linux-server betekent bijna altijd dat een .env
 * van een pc is meeverhuisd naar de hosting. Zonder deze controle maakt Node
 * doodleuk een map met de naam "C:\Users\..." aan en lijkt er niets aan de hand.
 * In dat geval negeren we DATA_DIR en valt de bot terug op de standaardmap.
 */
const dataDirOnbruikbaarOpDitOs = process.platform !== 'win32' && /^[A-Za-z]:[\\/]/.test(dataDirUitEnv);

/**
 * Map waarin de JSON-opslag staat. Standaard <projectroot>/data — dat werkt op
 * elke hosting zonder aanpassing. Met DATA_DIR zet je hem ergens anders neer
 * (een relatief pad wordt vanaf de projectmap gerekend), bijvoorbeeld buiten OneDrive.
 */
const dataDir = dataDirUitEnv && !dataDirOnbruikbaarOpDitOs
  ? path.resolve(PROJECT_ROOT, dataDirUitEnv)
  : path.join(PROJECT_ROOT, 'data');

if (dataDirOnbruikbaarOpDitOs) {
  logger.warn(
    `DATA_DIR ("${dataDirUitEnv}") is een Windows-pad, maar deze server draait geen Windows. `
      + `DATA_DIR wordt genegeerd; de bot gebruikt ${dataDir}. `
      + 'Gebruik ~/OWC-gangbot-data als je hetzelfde .env-bestand overal wilt kunnen gebruiken.',
  );
}

/**
 * Maakt de datamap aan als hij nog niet bestaat.
 * @returns {boolean} true als de map (nu) bestaat.
 */
function ensureDataDir() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    return true;
  } catch (err) {
    logger.error(`Kon de datamap niet aanmaken: ${dataDir}`, err);
    return false;
  }
}

// Direct bij het laden aanmaken, zodat de store meteen kan schrijven.
ensureDataDir();

/**
 * Controleert of alle verplichte instellingen aanwezig en geldig zijn.
 * Gooit een Error met een duidelijke Nederlandse uitleg zodra er iets mist,
 * zodat de bot niet halverwege met een vage Discord-fout omvalt.
 * @throws {Error} Als DISCORD_TOKEN of CLIENT_ID ontbreekt, of als een ID ongeldig is.
 * @returns {void}
 */
function assertConfig() {
  const problemen = [];

  if (!token) {
    problemen.push(
      'DISCORD_TOKEN ontbreekt. Zet je bot-token in het .env-bestand '
        + '(Discord Developer Portal > jouw applicatie > tabblad "Bot" > "Reset Token").',
    );
  }

  if (!clientId) {
    problemen.push(
      'CLIENT_ID ontbreekt. Dit is de Application ID '
        + '(Discord Developer Portal > jouw applicatie > tabblad "General Information").',
    );
  } else if (!SNOWFLAKE_RE.test(clientId)) {
    problemen.push(`CLIENT_ID "${clientId}" is geen geldig Discord-ID (verwacht 17 t/m 20 cijfers).`);
  }

  if (guildId && !SNOWFLAKE_RE.test(guildId)) {
    problemen.push(
      `GUILD_ID "${guildId}" is geen geldig Discord-ID (verwacht 17 t/m 20 cijfers). `
        + "Laat GUILD_ID leeg om de commando's globaal te registreren.",
    );
  }

  if (!ensureDataDir()) {
    problemen.push(
      `De datamap kon niet aangemaakt worden: ${dataDir}. `
        + 'Controleer of de bot schrijfrechten heeft op deze locatie, of laat DATA_DIR '
        + `leeg in .env om de standaardmap te gebruiken (${path.join(PROJECT_ROOT, 'data')}).`,
    );
  }

  if (problemen.length > 0) {
    const lijst = problemen.map((p) => `  - ${p}`).join('\n');
    throw new Error(
      `Configuratie onvolledig. Los het volgende op in je .env-bestand:\n${lijst}\n`
        + 'Kopieer eventueel .env.example naar .env en vul de waarden in.',
    );
  }
}

module.exports = { token, clientId, guildId, dataDir, assertConfig };
