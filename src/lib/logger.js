// src/lib/logger.js — minimalistische logger met tijdstempel-prefix.
// Dit is de ENIGE plek in het project waar console.* gebruikt mag worden.

/**
 * Vult een getal aan tot twee cijfers ('7' => '07').
 * @param {number} n
 * @returns {string}
 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Huidige lokale tijd als '[HH:MM:SS]'.
 * @returns {string}
 */
function timestamp() {
  const now = new Date();
  return `[${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}]`;
}

/**
 * Bouwt de prefix voor een regel: '[HH:MM:SS] [INFO ]'.
 * @param {string} level
 * @returns {string}
 */
function prefix(level) {
  return `${timestamp()} [${level.padEnd(5, ' ')}]`;
}

/**
 * Zet een willekeurige waarde om naar iets dat netjes op één regel past.
 * Errors tonen hun message (stack gaat als extra argument mee naar console).
 * @param {*} value
 * @returns {*}
 */
function normalize(value) {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  return value;
}

/**
 * Informatieve melding (normale werking van de bot).
 * @param {*} msg Hoofdbericht.
 * @param {...*} args Extra waarden die achter het bericht geprint worden.
 * @returns {void}
 */
function info(msg, ...args) {
  console.log(prefix('INFO'), normalize(msg), ...args.map(normalize));
}

/**
 * Waarschuwing: iets is niet in orde, maar de bot draait door.
 * @param {*} msg Hoofdbericht.
 * @param {...*} args Extra waarden die achter het bericht geprint worden.
 * @returns {void}
 */
function warn(msg, ...args) {
  console.warn(prefix('WARN'), normalize(msg), ...args.map(normalize));
}

/**
 * Fout: een actie is mislukt. De bot mag hierdoor nooit stoppen.
 * @param {*} msg Hoofdbericht.
 * @param {...*} args Extra waarden die achter het bericht geprint worden.
 * @returns {void}
 */
function error(msg, ...args) {
  console.error(prefix('ERROR'), normalize(msg), ...args.map(normalize));
}

/**
 * Debugmelding. Wordt alleen geprint als omgevingsvariabele DEBUG gelijk is aan '1'.
 * De check gebeurt bij elke aanroep, zodat het aan/uit kan zonder herstart-volgorde-gedoe.
 * @param {*} msg Hoofdbericht.
 * @param {...*} args Extra waarden die achter het bericht geprint worden.
 * @returns {void}
 */
function debug(msg, ...args) {
  if (process.env.DEBUG !== '1') return;
  console.log(prefix('DEBUG'), normalize(msg), ...args.map(normalize));
}

module.exports = { info, warn, error, debug };
