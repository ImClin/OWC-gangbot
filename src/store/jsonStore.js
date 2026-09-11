const fs = require('fs');
const path = require('path');
const logger = require('../lib/logger');

/**
 * Blokkeert de thread een aantal milliseconden. Nodig omdat het opslaan synchroon is
 * (zodat een crash nooit halverwege een schrijfactie valt) en er dus geen await bestaat
 * om een mislukte rename even mee uit te stellen.
 *
 * @param {number} ms Aantal milliseconden.
 * @returns {void}
 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Atomics.wait mag niet op elke thread; dan slaan we het wachten simpelweg over.
  }
}

/**
 * Controleert of een waarde een 'plain object' is (dus geen array en niet null).
 *
 * @param {*} value Willekeurige waarde.
 * @returns {boolean} true als het een gewoon object is.
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Maakt een JSON-veilige diepe kopie. Waarden die niet in JSON passen
 * (functies, undefined, symbolen) vallen weg - precies wat we willen voor een JSON-store.
 *
 * @param {*} value De te kopieren waarde.
 * @returns {*} Een losstaande kopie, of een leeg object als kopieren mislukt.
 */
function deepClone(value) {
  try {
    return JSON.parse(JSON.stringify(value === undefined ? {} : value));
  } catch (err) {
    logger.warn(`JsonStore: kon waarde niet kopieren (${err.message}); leeg object gebruikt.`);
    return {};
  }
}

/**
 * Kleine atomische JSON-store zonder externe dependencies.
 *
 * - Leest lui van schijf en houdt de data in een in-memory cache.
 * - Schrijft atomisch: eerst naar `<bestand>.tmp`, daarna `fs.renameSync` eroverheen.
 * - Corrupt JSON wordt hernoemd naar `<bestand>.corrupt-<timestamp>`, gelogd als warn,
 *   waarna er met de meegegeven defaults verder wordt gegaan.
 */
class JsonStore {
  /**
   * @param {string} filePath Pad naar het JSON-bestand (relatief pad wordt geresolved).
   * @param {object} [defaults={}] Standaardinhoud bij een ontbrekend of corrupt bestand.
   * @throws {Error} Als er geen bruikbaar bestandspad is meegegeven.
   */
  constructor(filePath, defaults = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new Error('JsonStore: filePath is verplicht en moet een string zijn.');
    }
    /** @type {string} Absoluut pad naar het databestand. */
    this.filePath = path.resolve(filePath);
    /** @type {string} Absoluut pad naar het tijdelijke schrijfbestand. */
    this.tmpPath = `${this.filePath}.tmp`;
    /** @type {object} Standaardinhoud. */
    this.defaults = isPlainObject(defaults) ? defaults : {};
    /** @type {object|null} In-memory cache. */
    this.data = null;
    /** @type {boolean} true zodra er (geprobeerd is te) laden van schijf. */
    this.loaded = false;
  }

  /**
   * Geeft de volledige data terug. Laadt lui van schijf bij de eerste aanroep.
   * Let op: dit is de levende cache, geen kopie - muteren zonder `write()` wordt niet bewaard.
   *
   * @returns {object} De data uit het bestand, aangevuld met de defaults.
   */
  read() {
    if (!this.loaded) this._load();
    return this.data;
  }

  /**
   * Muteert de data en schrijft die atomisch weg.
   *
   * @param {(data: object) => (void|object)} mutator Krijgt de data mee; muteer die,
   *   of geef een nieuw object terug dat de huidige data volledig vervangt.
   * @returns {object} De nieuwe data na het schrijven.
   */
  write(mutator) {
    const data = this.read();
    if (typeof mutator === 'function') {
      const result = mutator(data);
      if (isPlainObject(result)) this.data = result;
    } else if (mutator !== undefined) {
      logger.warn('JsonStore.write: mutator is geen functie; alleen de huidige data is weggeschreven.');
    }
    this._persist();
    return this.data;
  }

  /**
   * Forceert een flush van de in-memory data naar schijf.
   *
   * @returns {boolean} true als het wegschrijven is gelukt.
   */
  save() {
    if (!this.loaded) this._load();
    return this._persist();
  }

  /**
   * Laadt het bestand van schijf in de cache. Interne methode.
   *
   * @private
   * @returns {void}
   */
  _load() {
    this.loaded = true;
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      this.data = deepClone(this.defaults);
      if (err && err.code === 'ENOENT') {
        // Eerste start: bestand meteen aanmaken zodat back-ups en rechten direct kloppen.
        this._persist();
      } else {
        logger.warn(`JsonStore: kon ${this.filePath} niet lezen (${err.message}); standaardwaarden gebruikt.`);
      }
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
      if (!isPlainObject(parsed)) throw new Error('inhoud is geen JSON-object');
    } catch (err) {
      this._backupCorrupt(err);
      this.data = deepClone(this.defaults);
      this._persist();
      return;
    }

    this.data = this._applyDefaults(parsed);
  }

  /**
   * Vult ontbrekende sleutels op het hoogste niveau aan met de defaults.
   *
   * @private
   * @param {object} parsed De ingelezen data.
   * @returns {object} De aangevulde data.
   */
  _applyDefaults(parsed) {
    const base = deepClone(this.defaults);
    for (const key of Object.keys(base)) {
      if (parsed[key] === undefined || parsed[key] === null) parsed[key] = base[key];
    }
    return parsed;
  }

  /**
   * Hernoemt een corrupt bestand naar `<bestand>.corrupt-<timestamp>` en logt een waarschuwing.
   *
   * @private
   * @param {Error} cause De parse-fout die het bestand als corrupt markeerde.
   * @returns {void}
   */
  _backupCorrupt(cause) {
    const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(this.filePath, backupPath);
      logger.warn(
        `JsonStore: ${this.filePath} bevat ongeldige JSON (${cause.message}). `
        + `Bestand bewaard als ${backupPath}; er wordt met de standaardwaarden verder gegaan.`,
      );
    } catch (err) {
      logger.warn(
        `JsonStore: ${this.filePath} bevat ongeldige JSON (${cause.message}) en kon niet hernoemd worden `
        + `(${err.message}); er wordt met de standaardwaarden verder gegaan.`,
      );
    }
  }

  /**
   * Schrijft de cache atomisch naar schijf via een tijdelijk bestand.
   *
   * @private
   * @returns {boolean} true als het wegschrijven is gelukt.
   */
  _persist() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.tmpPath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
      this._replaceTarget();
      return true;
    } catch (err) {
      logger.error(`JsonStore: opslaan van ${this.filePath} is mislukt: ${err.message}`);
      this._cleanupTmp();
      return false;
    }
  }

  /**
   * Zet het tijdelijke bestand op de plek van het echte bestand.
   * Valt terug op kopieren als rename geblokkeerd wordt (komt voor bij virusscanners
   * of gesynchroniseerde mappen zoals OneDrive op Windows).
   *
   * @private
   * @returns {void}
   */
  _replaceTarget() {
    // Op Windows geeft rename regelmatig een kortstondige EPERM/EBUSY omdat een virusscanner
    // of de zoekindexering het net geschreven bestand nog vasthoudt. Dat is bijna altijd binnen
    // enkele tientallen milliseconden over, dus proberen we het een paar keer opnieuw voordat we
    // terugvallen op kopiëren — kopiëren is namelijk NIET atomisch en kan bij een crash midden
    // in de schrijfactie een half bestand achterlaten.
    const wachttijden = [15, 40, 100, 250];
    let laatste = null;

    for (let poging = 0; poging <= wachttijden.length; poging += 1) {
      try {
        fs.renameSync(this.tmpPath, this.filePath);
        if (poging > 0) {
          logger.debug(`JsonStore: hernoemen lukte na ${poging} extra poging(en).`);
        }
        return;
      } catch (err) {
        laatste = err;
        const retryable = err && ['EPERM', 'EACCES', 'EBUSY', 'EEXIST'].includes(err.code);
        if (!retryable) throw err;
        if (poging < wachttijden.length) sleepSync(wachttijden[poging]);
      }
    }

    logger.warn(
      `JsonStore: hernoemen bleef mislukken (${laatste && laatste.code}) na ${wachttijden.length} `
        + `pogingen; er wordt nu gekopieerd naar ${this.filePath}. Draait er een virusscanner of `
        + 'staat de datamap in een synchronisatiemap zoals OneDrive?',
    );
    fs.copyFileSync(this.tmpPath, this.filePath);
    this._cleanupTmp();
  }

  /**
   * Ruimt een achtergebleven tijdelijk bestand op. Falen is hier niet erg.
   *
   * @private
   * @returns {void}
   */
  _cleanupTmp() {
    try {
      if (fs.existsSync(this.tmpPath)) fs.unlinkSync(this.tmpPath);
    } catch (err) {
      logger.debug(`JsonStore: tijdelijk bestand ${this.tmpPath} kon niet opgeruimd worden: ${err.message}`);
    }
  }
}

module.exports = { JsonStore };
