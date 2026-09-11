// src/commands/gangbeheer.js
// De staff-kant van het gangbeheer: gangs aanmaken, verwijderen, hernoemen, limieten
// aanpassen en herstellen.
//
// Waarom een apart bestand en niet gewoon meer subcommands onder /gang? Discord kan losse
// subcommands niet verbergen: setDefaultMemberPermissions geldt altijd voor het hele
// commando. Zolang deze vijf onder /gang hingen, zag elke speler ze in de lijst staan.
// Als eigen commando kan Discord ze wél verbergen voor wie geen 'Server beheren' heeft.
//
// Alle logica staat in commands/gang.js; hier wordt niets gedupliceerd. De loader in
// index.js verwacht per bestand { data, execute }, dus dit bestand koppelt die twee aan
// de beheer-variant.

const gang = require('./gang');

module.exports = {
  data: gang.beheerData,
  execute: gang.executeBeheer,
  // De gang-optie van hernoemen, limiet, herstel en verwijderen heeft dezelfde suggesties
  // als bij /gang; staff ziet daar alle gangs.
  autocomplete: gang.autocomplete,
};
