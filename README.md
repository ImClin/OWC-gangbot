# OWC Gangbot

Discord-bot voor het beheren van gangs op een FiveM-roleplayserver.

De bot maakt per gang een complete werkomgeving aan (categorie, kanalen en rollen),
bewaakt de ledenlimieten en laat bossen en underbosses zelf mensen aannemen en ontslaan
door simpelweg een bericht in `#aangenomen` of `#ontslagen` te plaatsen. Alles wat er
gebeurt komt in een logboek te staan, met een knop om het terug te draaien.

Deze handleiding is geschreven voor de beheerder van een Discord-server. Je hoeft geen
programmeur te zijn: volg de stappen van boven naar beneden.

---

## Lees dit eerst: de drie dingen die altijd misgaan

Negen van de tien keer dat de bot "niet werkt", is het een van deze drie:

| # | Wat | Waar los je het op | Zonder dit gebeurt er dit |
|---|---|---|---|
| **1** | **Server Members Intent** en **Message Content Intent** aanzetten | Developer Portal &rarr; jouw applicatie &rarr; **Bot** &rarr; *Privileged Gateway Intents* | De bot start niet, of leest je berichten niet en telt de leden verkeerd |
| **2** | De **rol van de bot** moet **BOVEN alle gangrollen** staan | Discord &rarr; Serverinstellingen &rarr; **Rollen** &rarr; sleep de botrol omhoog | Aannemen en ontslaan mislukt met "Missing Permissions" |
| **3** | Eerst **`/setup kanalen`** draaien | In Discord, in je eigen server | De bot doet helemaal niets met berichten in `#aangenomen` |

Elk van deze drie heeft verderop een eigen hoofdstuk met klikstappen:
[hoofdstuk 4](#4-discord-developer-portal-bot-aanmaken-en-intents-aanzetten),
[hoofdstuk 6](#6-de-botrol-moet-boven-alle-gangrollen-staan) en
[hoofdstuk 7](#7-eerste-configuratie-met-setup).

---

## Inhoud

1. [Wat de bot doet](#1-wat-de-bot-doet)
2. [Vereisten](#2-vereisten)
3. [Installatie](#3-installatie)
4. [Discord Developer Portal: bot aanmaken en intents aanzetten](#4-discord-developer-portal-bot-aanmaken-en-intents-aanzetten)
5. [De bot uitnodigen op je server](#5-de-bot-uitnodigen-op-je-server)
6. [De botrol moet BOVEN alle gangrollen staan](#6-de-botrol-moet-boven-alle-gangrollen-staan)
7. [Eerste configuratie met /setup](#7-eerste-configuratie-met-setup)
8. [Alle commando's](#8-alle-commandos)
9. [Werken met #aangenomen en #ontslagen](#9-werken-met-aangenomen-en-ontslagen)
10. [De limieten: 22 leden per gang](#10-de-limieten-22-leden-per-gang)
11. [Wat maakt /gangbeheer aanmaken precies aan?](#11-wat-maakt-gangbeheer-aanmaken-precies-aan)
12. [Logboek, terugdraaien en dashboard](#12-logboek-terugdraaien-en-dashboard)
13. [Back-up en herstel](#13-back-up-en-herstel)
14. [Problemen oplossen](#14-problemen-oplossen)
15. [Draaide je de bot al? Dit verandert er](#15-draaide-je-de-bot-al-dit-verandert-er)

---

## 1. Wat de bot doet

- **Gangs aanmaken met een commando.** `/gangbeheer aanmaken` zet in een keer een categorie,
  zes kanalen en drie rollen neer, met alle permissies goed ingesteld. De drie rollen komen
  meteen als een blokje bij elkaar in de rollenlijst te staan.
- **Aannemen en ontslaan zonder staff.** De boss of underboss van een gang plaatst een
  bericht met een @-mention in `#aangenomen` of `#ontslagen`; de bot deelt de rollen uit
  of haalt ze weg. Staff hoeft er niet aan te pas te komen. In die twee kanalen kan
  bovendien niemand anders typen: Discord houdt een bericht van een gewoon lid al tegen
  bij het verzenden.
- **Limieten bewaken.** Een gang heeft één soort lid en één ledenlimiet, standaard **22**
  personen (boss en underboss tellen mee). Zit een gang vol, dan weigert de bot de aanname
  met een duidelijke melding.
- **Alles vastleggen.** Elke aanname, elk ontslag en elke handmatige rolwijziging komt in
  het logboekkanaal, met een **Terugdraaien**-knop voor staff.
- **Live bezettingsoverzicht.** Een dashboardbericht dat elke 5 minuten laat zien hoe vol
  elke gang zit.
- **Zelfherstel.** Is er per ongeluk een kanaal of een rol verwijderd? `/gangbeheer herstel`
  maakt het opnieuw aan en zet alle permissies terug.

---

## 2. Vereisten

| Wat | Waarom |
|---|---|
| **Node.js versie 20 of hoger** | Hierop draait de bot. Controleer met `node -v` in een terminal. Download via [nodejs.org](https://nodejs.org). |
| **Een Discord-account met "Server beheren" op de server** | Anders kun je de bot niet uitnodigen en `/setup` niet gebruiken. |
| **Een Discord-applicatie (bot)** | Die maak je aan in hoofdstuk 4. |
| **Een plek waar de bot 24/7 kan draaien** | Een VPS, een altijd-aan pc of een hostingpakket. Staat de computer uit, dan reageert de bot niet. |

De bot gebruikt maar twee externe pakketten (`discord.js` en `dotenv`) en slaat alles op
in een gewoon tekstbestand. Er is geen database, geen Docker en geen extra software nodig.

---

## 3. Installatie

Open een terminal (Windows: PowerShell of Opdrachtprompt) in de projectmap en voer de
stappen hieronder uit.

### Stap 1 - Pakketten installeren

```
npm install
```

Dit hoef je maar een keer te doen, en opnieuw na een update van de bot.

### Stap 2 - Het .env-bestand maken

Het bestand `.env` bevat je bot-token. **Deel dit bestand nooit met iemand.**

Kopieer eerst het voorbeeldbestand:

```
copy .env.example .env      (Windows)
cp .env.example .env        (Linux / macOS)
```

Open `.env` daarna met Kladblok en vul in:

| Veld | Wat vul je in | Verplicht |
|---|---|---|
| `DISCORD_TOKEN` | Het bot-token uit de Developer Portal (hoofdstuk 4) | Ja |
| `CLIENT_ID` | De Application ID van je applicatie (hoofdstuk 4) | Ja |
| `GUILD_ID` | Het ID van jouw Discord-server | Nee, maar sterk aangeraden |
| `DATA_DIR` | Map waarin `owc.json` wordt opgeslagen. Laat leeg voor `data/` naast het project | Nee, tenzij het project in OneDrive staat |
| `DEBUG` | `0` normaal, `1` voor extra logregels bij het zoeken naar problemen | Nee |

> **Tip:** vul `GUILD_ID` in. Dan zijn de slash-commando's **direct** beschikbaar. Laat je
> het leeg, dan registreert de bot ze globaal en kan het **tot een uur** duren voordat
> `/gang` en `/setup` in Discord verschijnen.
>
> Het server-ID kopieer je zo: Discord &rarr; Instellingen (tandwiel) &rarr;
> **Geavanceerd** &rarr; **Ontwikkelaarsmodus** aanzetten. Klik daarna met de rechtermuis
> op je servernaam &rarr; **Server-ID kopieren**.

Zet **geen** aanhalingstekens om de waarden. Goed is: `CLIENT_ID=123456789012345678`.

> **Staat je projectmap in OneDrive, Dropbox of Google Drive?** Zet `DATA_DIR` dan naar een
> map daarbuiten, bijvoorbeeld `DATA_DIR=~/OWC-gangbot-data` (de tilde staat voor je persoonlijke map en
> werkt zowel op Windows als op een Linux-hostingserver).
> Synchronisatiediensten vergrendelen bestanden terwijl ze uploaden en kunnen bij twee
> apparaten conflictkopieen van je gangdata maken. De bot blijft wel werken, maar je
> loopt onnodig risico op verlies.

### Stap 3 - Commando's registreren bij Discord

```
npm run deploy
```

Je ziet in de terminal welke commando's geregistreerd zijn (`/gang` en `/setup`). Herhaal
dit alleen als er commando's bijkomen of veranderen.

### Stap 4 - De bot starten

```
npm start
```

Bij een goede start zie je regels als:

```
[14:03:21] INFO  Ingelogd als OWC Gangbot#1234 (1234567890).
[14:03:22] INFO  Mijn Server (123...): 412 leden, 3 gang(s) bekend.
```

Waarschuwingen (`WARN`) in dit opstartblok wijzen bijna altijd op een ontbrekende intent,
een ontbrekend recht of een botrol die te laag staat - zie hoofdstuk 14.

De bot stoppen doe je met `Ctrl + C` in de terminal.

---

## 4. Discord Developer Portal: bot aanmaken en intents aanzetten

### 4.1 De applicatie aanmaken

1. Ga naar **https://discord.com/developers/applications** en log in.
2. Klik rechtsboven op **New Application**.
3. Geef een naam op (bijvoorbeeld `OWC Gangbot`) en klik op **Create**.
4. Je staat nu op het tabblad **General Information**. Kopieer hier de
   **Application ID** - dat is de waarde voor `CLIENT_ID` in je `.env`.

### 4.2 Het token ophalen

1. Klik in het linkermenu op **Bot**.
2. Klik op **Reset Token** en bevestig. Discord toont het token **een keer**.
3. Kopieer het en plak het achter `DISCORD_TOKEN=` in je `.env`.

> Het token is het wachtwoord van je bot. Ziet iemand anders het? Klik dan meteen opnieuw
> op **Reset Token**; het oude token werkt daarna niet meer.
> Let op: het token is **niet** de "Client Secret" en **niet** de "Public Key".

### 4.3 DE TWEE INTENTS AANZETTEN (dit vergeet iedereen)

Blijf op het tabblad **Bot** en scroll naar het blok **Privileged Gateway Intents**. Zet
daar deze twee schuifjes **AAN** en klik onderaan op **Save Changes**:

- [x] **SERVER MEMBERS INTENT**
- [x] **MESSAGE CONTENT INTENT**

(**PRESENCE INTENT** mag uit blijven - die gebruikt de bot niet.)

**Waarom dit moet:**

| Intent | Zonder deze intent |
|---|---|
| **Server Members Intent** | De bot kan de leden van je server niet ophalen. De ledentelling klopt niet, "19/22" wordt "0/22" en limieten werken verkeerd. Vaak start de bot zelfs helemaal niet (fout: `Used disallowed intents`). |
| **Message Content Intent** | De bot ziet **de inhoud** van berichten in `#aangenomen` en `#ontslagen` niet. Je typt `@Jan` en er gebeurt gewoon niets: geen reactie, geen foutmelding. |

**Na het aanzetten moet je de bot opnieuw starten** (`Ctrl + C`, daarna `npm start`).

Nog een keer, want dit is verreweg de meest voorkomende oorzaak van "de bot doet niets":
**zonder deze twee schuifjes werkt de bot niet.**

---

## 5. De bot uitnodigen op je server

Gebruik onderstaande link en **vervang `JOUW_CLIENT_ID` door je eigen Application ID** uit
stap 4.1:

```
https://discord.com/api/oauth2/authorize?client_id=JOUW_CLIENT_ID&scope=bot%20applications.commands&permissions=378292006864
```

Open de link in je browser, kies je server, klik op **Doorgaan** en daarna op
**Autoriseren**.

### Wat zit er in die link?

**Scopes** (`scope=bot applications.commands`):

- `bot` - de bot mag lid worden van je server.
- `applications.commands` - de bot mag slash-commando's (`/gang`, `/setup`) aanbieden.

**Rechten** (`permissions=378292006864`):

Dit getal is de optelsom van **22** rechten. Dat lijkt veel, maar het overgrote deel deelt
de bot alleen maar *uit*: Discord weigert namelijk een hele permissie-instelling zodra je
er een recht in zet dat de bot **zelf** niet heeft. Mist de bot bijvoorbeeld "Spreken", dan
kan hij dat de boss in het oortje ook niet geven - en dan valt stilzwijgend de complete
rechteninstelling van dat kanaal om.

Rechten die de bot voor **zichzelf** gebruikt:

| Recht (Nederlands) | Engels | Waarvoor de bot het nodig heeft |
|---|---|---|
| Rollen beheren | Manage Roles | De drie gangrollen aanmaken, uitdelen, afnemen en **op volgorde zetten** |
| Kanalen beheren | Manage Channels | De categorie en de zes kanalen aanmaken, hernoemen, verwijderen en hun rechten zetten |
| Kanalen bekijken | View Channels | Zijn eigen gangkanalen en de registerkanalen zien; zonder dit kan hij er niets in zetten |
| Auditlogboek bekijken | View Audit Log | Zien wie een gangrol handmatig heeft toegevoegd of weggehaald |
| Berichten versturen | Send Messages | Antwoorden in `#aangenomen` en `#ontslagen`, en posten in het logboek |
| Links insluiten | Embed Links | De nette gekleurde berichten (embeds) tonen |
| Berichtgeschiedenis lezen | Read Message History | Het dashboardbericht terugvinden en bijwerken |
| Reacties toevoegen | Add Reactions | De vinkjes en kruisjes onder je bericht zetten |
| Berichten beheren | Manage Messages | Eigen hint- en foutmeldingen opruimen, en dat recht aan staff kunnen geven in het register |

Rechten die de bot **uitdeelt** aan gangleden, leiding, staff en de extrarollen:

| Recht (Nederlands) | Engels | Aan wie de bot het geeft |
|---|---|---|
| Berichten versturen in threads | Send Messages in Threads | Leden en staff in de gangkanalen |
| Openbare threads maken | Create Public Threads | Nodig om dit recht juist te kunnen **weigeren** in `#aangenomen`, `#ontslagen` en `📢・mededeling` |
| Privéthreads maken | Create Private Threads | Idem in de registers: zonder deze twee threadrechten blijft de achterdeur "open een thread en typ daarin" openstaan |
| Bestanden toevoegen | Attach Files | Leden in de gangkanalen en `📷・media` |
| Externe emoji gebruiken | Use External Emojis | Leden in de gangkanalen |
| Deelnemen | Connect | Leden in `📞・oortje` |
| Spreken | Speak | Niemand in het oortje — de bot zet dit recht daar voor iedereen dicht |
| Streamen (Video) | Video / Stream | Niemand in het oortje, om dezelfde reden |
| Spraakactivering gebruiken | Use Voice Activity | Iedereen in het oortje |
| Leden dempen | Mute Members | Boss en underboss in het oortje |
| Leden doof zetten | Deafen Members | Alleen de boss |
| Leden verplaatsen | Move Members | Boss en underboss |
| Prioriteitsspreker | Priority Speaker | Alleen de boss |

> **Let vooral op de twee threadrechten.** Zonder *Openbare threads maken* en *Privéthreads
> maken* kan de bot die rechten in `#aangenomen` en `#ontslagen` niet dichtzetten, en kan
> ieder serverlid het register alsnog binnenkomen door daar een thread te openen en erin te
> typen. De bot zegt dat niet: Discord laat zo'n weigering dan gewoon weg.

Verwijder na het uitnodigen **niets** van deze rechten. Haal je bijvoorbeeld "Rollen
beheren" weg, dan mislukt elke aanname. `/setup toon` laat zien welke van de rechten uit de
eerste tabel de bot mist; ontbreekt er een uit de tweede, dan meldt de bot dat bij
`/gangbeheer aanmaken` en `/gangbeheer herstel`.

---

## 6. De botrol moet BOVEN alle gangrollen staan

Discord heeft een ijzeren regel: **een bot kan alleen rollen uitdelen die onder zijn eigen
rol staan.** Staat de botrol te laag, dan mislukt elke aanname en elk ontslag met een
melding als *"Ik kan de rol Rayuza niet toekennen"* of *"Missing Permissions"*.

### Zo zet je het goed

1. Ga in Discord naar **Serverinstellingen** (klik op de servernaam &rarr;
   Serverinstellingen).
2. Klik in het linkermenu op **Rollen**.
3. Zoek de rol van de bot in de lijst. Die heet meestal net als je bot, bijvoorbeeld
   `OWC Gangbot`.
4. **Sleep die rol naar boven**, boven alle gangrollen (`Rayuza`, `Rayuza Boss`,
   `Rayuza Underboss`, enzovoort).
5. Klik op **Wijzigingen opslaan**.

Praktisch advies: zet de botrol direct **onder** je hoogste stafrol en **boven** alles wat
met gangs te maken heeft. Dan zit je altijd goed, ook bij nieuwe gangs.

```
Serverinstellingen > Rollen (van boven naar beneden)

  Eigenaar / Admin
  Staff                 <- jouw stafrol
  OWC Gangbot           <- de botrol: HIER, boven alles wat hieronder staat
  Rayuza Boss           |
  Rayuza Underboss      |  het blokje van Rayuza
  Rayuza                |
  Los Zetas Boss        |
  Los Zetas Underboss   |  het blokje van Los Zetas
  Los Zetas             |
  ...
  @everyone
```

> De bot controleert dit zelf bij het opstarten. Zie je in de terminal een regel als
> *"De botrol staat te laag voor: Rayuza"*, dan is dit precies het probleem.

### Leidingkanalen: alleen voor boss en underboss

Naast de twee registers kun je kanalen aanwijzen waar **alleen de leiding van alle gangs**
bij mag — een gedeelde bosschat bijvoorbeeld:

```
/setup leidingkanaal kanaal:#bosschat
```

Verschil met `#aangenomen` en `#ontslagen`: daar leest de hele gang mee. In een
leidingkanaal komt de **gangrol er niet in voor**, dus een gewoon gangslid ziet het kanaal
niet eens staan.

| Wie | Zien en lezen | Typen |
|---|---|---|
| `@everyone` en gewone gangleden | **Nee** | **Nee** |
| Boss en underboss van **elke** gang | Ja | **Ja** |
| Staff (`/setup staffrol`) | Ja | **Ja**, plus opruimen |
| Extrarollen (`/setup extrarollen`) | Ja | **Ja** |
| De bot zelf | Ja | Ja |

Je hoeft dit per kanaal maar één keer te doen: maak je later een nieuwe gang aan, dan
worden de verse boss- en underbossrol er automatisch aan toegevoegd. Hetzelfde gebeurt bij
`/gangbeheer herstel`.

Wil je een kanaal weer vrijgeven, dan haalt `/setup leidingkanaal kanaal:#bosschat
actie:verwijderen` de rechtenregels van de bot er ook echt weer af. Let op wat er daarna
overblijft: het kanaal valt terug op de rechten van zijn categorie, en dat kan betekenen
dat iedereen er weer in kan.

**Let op bij een categorie:** Discord geeft categorierechten niet live door aan kanalen.
Een kanaal krijgt de rechten van zijn categorie alleen als je het aanmaakt of als je
handmatig synchroniseert — en synchroniseren **overschrijft** alle eigen rechten van dat
kanaal, dus ook wat de bot er net op gezet heeft. Zet een leidingkanaal of een register dus
nooit "in sync" met zijn categorie.

### De bot zet de gangrollen zelf op volgorde

Je hoeft de gangrollen niet handmatig te sorteren. De bot ordent ze zelf, zodat elke gang
**één blokje** vormt met de hoogste rang bovenaan:

```
<Gang> Boss
<Gang> Underboss
<Gang>
```

- De gangs staan onderling op **aanmaakvolgorde**: de gang die je het eerst aanmaakte staat
  bovenaan. Dat is stabiel, dus de lijst gaat niet dansen bij elke wijziging.
- De bot zet dit neer na `/gangbeheer aanmaken`, `/gangbeheer verwijderen`, `/gangbeheer hernoemen` en
  `/gangbeheer herstel`. Staat alles al goed, dan verplaatst hij niets.
- De blokjes blijven staan **waar de gangrollen al stonden**, en nooit hoger dan vlak onder
  de botrol. Staat je stafrol daarboven, dan komt de bot daar dus niet aan.
- **Staat de botrol te laag?** Dan doet de bot niets - hij verplaatst liever nul rollen dan
  een halve lijst - en meldt: *"De rol van de bot staat te laag in de rollenlijst"*. Sleep
  de botrol dan omhoog zoals hierboven en draai `/gangbeheer herstel gang:<naam>`.
- Zet je zelf een gangrol ergens anders neer, dan trekt de eerstvolgende `/gangbeheer herstel` de
  volgorde weer recht.

**Een ondergrens instellen: `/setup bodemrol`**

Discord zet een nieuwe rol altijd onderaan, vlak boven `@everyone`. Nieuwe gangrollen komen
daardoor standaard onderin de lijst terecht. Wil je dat ze altijd boven een bepaalde rol
uitkomen, wijs die rol dan aan als **bodemrol**:

```
/setup bodemrol rol:@Lid
```

Vanaf dat moment schuift het blok gangrollen bij elke ordening tot boven die rol - bij
`/gangbeheer aanmaken`, `/gangbeheer hernoemen`, `/gangbeheer verwijderen` en `/gangbeheer herstel`. De bodemrol
zelf blijft staan waar hij staat. Laat je de optie `rol` leeg, dan zet je de ondergrens
weer uit en geldt alleen nog `@everyone` als bodem.

Twee dingen waar de bot je voor behoedt: je kunt `@everyone` niet als bodemrol kiezen (dat
is al de standaard) en een gangrol ook niet (die moet juist boven de grens blijven). Past
het blok niet meer tussen de bodemrol en de botrol, dan verplaatst de bot niets en zegt hij
dat erbij - sleep de botrol dan hoger.

---

## 7. Eerste configuratie met /setup

**Belangrijk: zolang je `/setup kanalen` niet hebt uitgevoerd, doet de bot niets met
berichten in `#aangenomen` en `#ontslagen`.** De bot weet dan simpelweg niet welke kanalen
dat zijn. Er komt ook geen foutmelding - hij negeert die berichten gewoon. Dit is na de
intents de meest gemelde "de bot werkt niet".

Alle `/setup`-commando's kun je alleen gebruiken met het serverrecht **Server beheren**.
De antwoorden zijn ephemeral: alleen jij ziet ze.

### Stap 1 - Maak de kanalen aan (gewoon in Discord)

Maak drie tekstkanalen aan, bijvoorbeeld:

- `#aangenomen` - hier melden bossen wie ze aannemen
- `#ontslagen` - hier melden bossen wie ze ontslaan
- `#gang-logboek` - alleen voor staff; hier komt het logboek met de terugdraaiknop

Zorg dat de bot in alle drie de kanalen mag **kijken, lezen, berichten sturen, reageren en
links insluiten**. In `#aangenomen` en `#ontslagen` heeft hij daarnaast **Rollen beheren**
nodig: daarmee zet hij die twee kanalen in stap 2 op slot.

### Stap 2 - Koppel ze aan de bot

```
/setup kanalen aangenomen:#aangenomen ontslagen:#ontslagen logboek:#gang-logboek
```

Je mag ook een kanaal tegelijk instellen; alle drie de opties zijn optioneel. De bot
controleert meteen of hij in die kanalen genoeg rechten heeft en zegt het als er iets
ontbreekt.

> **Dit commando zet `#aangenomen` en `#ontslagen` ook meteen op slot.** Vanaf dat moment
> kan alleen de gangleiding, staff, de extrarollen en de bot daar nog iets in zetten;
> meelezen mag iedereen. Zie [hoofdstuk 9](#wie-mag-er-typen-in-aangenomen-en-ontslagen).
> Koppel je later een **ander** kanaal, dan zet de bot het oude kanaal weer vrij.

### Stap 3 - Stel de stafrol in

```
/setup staffrol rol:@Staff
```

**Wat is "staff" voor deze bot?** Iedereen met het serverrecht **Server beheren**, of
iedereen met de rol die je hier instelt. Staff mag alle `/gang`-commando's gebruiken,
limieten aanpassen en acties terugdraaien.

### Stap 4 (optioneel) - Rollen die overal bij mogen

Heb je groepen die in **elke** gang naar binnen moeten - OWC, de wapendealers - meld die
dan aan als extrarol:

```
/setup extrarollen rol:@OWC actie:toevoegen
```

Zo'n rol ziet en mag alles in elke gang: alle kanalen, ook `💀・boss` en `👤・dark-chat`,
typen in elk gangkanaal inclusief de mededelingen, en praten in het `📞・oortje`. Ook mag
hij posten in `#aangenomen` en `#ontslagen`.

- De wijziging wordt **meteen doorgevoerd op alle bestaande gangs**; `/gangbeheer herstel` is dus
  niet nodig. De bot meldt hoeveel gangs hij heeft bijgewerkt.
- Weghalen doe je met `actie:verwijderen`. Let op: had die rol in `#aangenomen` of
  `#ontslagen` een eigen recht dat je zelf had ingesteld, dan blijft dat staan - de bot
  meldt dat als waarschuwing in plaats van het weg te gooien.
- **Kies hier geen gangrol.** De bot weigert dat, en terecht: dan zou heel Rayuza in de
  kanalen van elke andere gang kunnen kijken. Maak dan een aparte rol aan.
- **Kies hier ook niet `@everyone`.** De bot weigert dat om dezelfde reden.
- De stafrol hoef je hier niet in te zetten; die heeft via `/setup staffrol` al overal
  toegang.

Welke rollen er nu in staan zie je met `/setup toon`.

### Stap 5 (optioneel) - Standaardlimieten

```
/setup limieten leden:22
```

Dit is de waarde die **nieuwe** gangs krijgen. Bestaande gangs veranderen hier niet van;
die pas je per stuk aan met `/gangbeheer limiet`. Je kunt hier ook `bosses` en `underbosses`
meegeven (standaard allebei 2).

### Stap 6 (optioneel) - Dashboard

```
/setup dashboard kanaal:#gang-overzicht
```

De bot post daar meteen een overzicht van alle gangs en hun bezetting, en werkt dat elke
5 minuten bij.

### Stap 7 (optioneel) - Gedeelde categorieen

Heb je categorieen waar **alle** gangs bij mogen (bijvoorbeeld een algemene
onderwereld-lounge)? Meld die aan:

```
/setup gedeelde-categorie categorie:ONDERWERELD actie:toevoegen
```

Vanaf dat moment krijgt elke **nieuw aangemaakte** gang automatisch toegang tot die
categorie.

> **Waarschuwing bij `sync_kinderen:true`:** met die optie zet de bot alle kanalen binnen
> die categorie gelijk aan de categorie zelf. Dat **overschrijft de bestaande permissies
> van die kanalen**. Gebruik het alleen als je zeker weet dat je dat wilt.

### Stap 8 - Controleer je werk

```
/setup toon
```

Dit toont de huidige instellingen, een **checklist** van wat er nog ontbreekt en welke
**botrechten** eventueel missen. Draai dit altijd als laatste stap: staat alles op groen,
dan is de bot klaar voor gebruik.

---

## 8. Alle commando's

**Wie mag wat?**

- **Staff** = iedereen met het serverrecht *Server beheren*, of met de rol uit
  `/setup staffrol`.
- **Leiding** = de boss of underboss van die gang (wie de rol `<Gang> Boss` of
  `<Gang> Underboss` heeft).
- **Iedereen** = elk serverlid.

### /gang

| Subcommando | Opties | Wie mag dit | Wat het doet |
|---|---|---|---|
| `/gang lijst` | (geen) | Iedereen | Overzicht van alle gangs met per gang een bezettingsbalk. Dit antwoord is zichtbaar voor iedereen in het kanaal. |
| `/gang info` | `gang` (optioneel; leeg = je eigen gang) | Leden en leiding van die gang, en staff | Toont boss, underboss, de overige leden en de limieten. Je kunt alleen je eigen gang bekijken, tenzij je staff bent. Staff en de leiding zien er ook de beheergegevens bij (kanaalnaam, wie de gang aanmaakte, ontbrekende rollen); een gewoon lid niet. |
| `/gang promoveer` | `lid`* | **Boss** of staff | Zet iemand **een trede hoger**: lid → underboss → boss. De gang volgt uit de gangrol van het gekozen lid, dus die hoef je niet op te geven. De bot kijkt zelf waar iemand staat. Alleen staff mag de laatste stap naar boss zetten. |
| `/gang degradeer` | `lid`* | **Boss** of staff | Zet iemand **een trede lager**: boss → underboss → lid. Ook hier volgt de gang uit het lid. Aan een zittende boss kan alleen staff iets veranderen. Onder "lid" zit niets meer; moet iemand helemaal uit de gang, gebruik dan `/gang ontslaan`. |
| `/gang aannemen` | `lid`*, `gang` (leeg = je eigen gang) | Leiding of staff | Hetzelfde als een bericht in `#aangenomen`, maar dan als commando. Handig als het aannamekanaal even niet beschikbaar is. De aanname wordt ook **openbaar in `#aangenomen` gepost**. |
| `/gang ontslaan` | `lid`*, `gang` (leeg = je eigen gang), `reden` (max 400 tekens) | Leiding of staff | Hetzelfde als een bericht in `#ontslagen`. Alle gangrollen die de persoon van deze gang heeft, gaan er in een keer af. Het ontslag wordt ook **openbaar in `#ontslagen` gepost**. |
| `/gang historie` | `gang` (optioneel), `lid` (optioneel), `aantal` (1-25, standaard 10) | Staff, en leiding voor de eigen gang | Toont de laatste acties (aannames, ontslagen, handmatige rolwijzigingen, vertrek uit de server) met tijdstip. |

\* = verplichte optie.

### /gangbeheer

Het staffgedeelte, in een **apart commando** zodat Discord het kan verbergen. Wie geen
**Server beheren** heeft, ziet `/gangbeheer` niet eens in de lijst staan.

> **Wil je dat je staffrol het ook ziet?** Discord kan niet filteren op de staffrol uit
> `/setup staffrol` — het kent alleen Discord-rechten. Voeg de rol daarom eenmalig toe in
> **Serverinstellingen → Integraties → OWC Gangbot → `/gangbeheer`**: zet daar de rol op
> *Toegestaan*. Dezelfde plek werkt ook voor `/setup`.
>
> Het verbergen is puur cosmetisch. Elk subcommando controleert nog steeds zelf of je staff
> bent, dus een verkeerd gezette override geeft niemand extra macht.

| Subcommando | Opties | Wat het doet |
|---|---|---|
| `/gangbeheer aanmaken` | `naam`* (2-40 tekens), `emoji`* (precies 1 emoji), `afkorting` (2-20 tekens), `boss` (lid), `ledenlimiet` (1-100) | Maakt de complete gang aan: 1 categorie, 6 kanalen en 3 rollen, en zet die rollen meteen als blokje in de rollenlijst. Geef je `boss` op, dan krijgt die persoon meteen de gangrol en de bossrol. Laat je `ledenlimiet` leeg, dan geldt de serverstandaard uit `/setup limieten`. Mislukt er iets halverwege, dan draait de bot alles terug - er blijft nooit half werk staan. |
| `/gangbeheer verwijderen` | `gang`* (typ om te zoeken), `rollen_verwijderen` (ja/nee, standaard **ja**) | Verwijdert de categorie en alle kanalen van de gang. Met `rollen_verwijderen:ja` gaan ook de drie rollen weg. Je krijgt eerst een bevestigingsvraag met knoppen; die vervalt na 60 seconden en alleen jij kunt erop klikken. **Dit kan niet ongedaan gemaakt worden.** |
| `/gangbeheer hernoemen` | `gang`*, `naam`, `emoji`, `afkorting`, `afkorting_weghalen` (ja/nee) | Wijzigt de naam, de emoji en/of de afkorting. De categorie, de drie rollen en de kanalen met de gangnaam erin worden meteen hernoemd. Met `afkorting_weghalen:ja` komen de kanaalnamen weer uit de volledige naam. |
| `/gangbeheer limiet` | `gang`*, `leden` (1-100), `bosses` (1-10), `underbosses` (0-10) | Past de limieten van die ene gang aan. Wat je niet invult, blijft ongewijzigd. |
| `/gangbeheer herstel` | `gang`* | Maakt ontbrekende rollen, de categorie en ontbrekende kanalen opnieuw aan, zet alle permissies terug zoals ze horen en zet de rollenlijst weer op volgorde. Je eerste hulp als er per ongeluk iets verwijderd is. |
| `/gangbeheer rolweergave` | (geen) | Zet bij **alle** gangrollen het vinkje *Rolleden los van online leden weergeven* goed, zodat elke gang een eigen kopje in de ledenlijst krijgt. Bedoeld als eenmalige migratie voor gangs die al bestonden; nieuwe gangs krijgen dit meteen. Een rol die al goed staat wordt overgeslagen, dus twee keer draaien kan geen kwaad. |

Bij elke `gang`-optie krijg je tijdens het typen suggesties (autocomplete): begin de naam
te typen en kies uit de lijst.

Alle antwoorden zijn ephemeral (alleen jij ziet ze), **behalve** `/gang lijst` en
`/gang info` - die zijn bewust zichtbaar voor het kanaal.

### /setup

Alleen bruikbaar met het serverrecht **Server beheren**. Alle antwoorden zijn ephemeral.

| Subcommando | Opties | Wat het doet |
|---|---|---|
| `/setup kanalen` | `aangenomen` (kanaal), `ontslagen` (kanaal), `logboek` (kanaal) | Koppelt het aannamekanaal, het ontslagkanaal en het staf-logboek. **Doe dit als eerste.** De bot controleert meteen of hij daar genoeg rechten heeft, **zet `#aangenomen` en `#ontslagen` op slot** (alleen leiding, staff, extrarollen en de bot mogen er typen) en geeft een eerder gekoppeld kanaal weer vrij. |
| `/setup extrarollen` | `rol`*, `actie` (`toevoegen` / `verwijderen`, standaard toevoegen) | Rollen die **alle** gangkanalen mogen zien en er typen, in het oortje mogen praten en in `#aangenomen` en `#ontslagen` mogen posten — bedoeld voor OWC en de wapendealers. Wordt meteen doorgevoerd op alle bestaande gangs, dus `/gangbeheer herstel` is niet nodig. Een gangrol of `@everyone` weigert de bot hier. |
| `/setup leidingkanaal` | `kanaal`*, `actie` (`toevoegen` / `verwijderen`, standaard toevoegen) | Wijst een kanaal aan waar alleen **boss en underboss van elke gang**, staff, de extrarollen en de bot bij kunnen — bijvoorbeeld een gedeelde bosschat. `@everyone` en gewone gangleden zien het niet staan. Nieuwe gangs worden er automatisch aan toegevoegd. `verwijderen` haalt de rechtenregels van de bot er weer af. |
| `/setup staffrol` | `rol`* | Bepaalt welke rol als staff geldt binnen het gangbeheer (naast het serverrecht *Server beheren*). |
| `/setup meldrol` | `rol` (optioneel) | Welke rol een **ping** krijgt in het logkanaal als de bot er niet uitkomt — bijvoorbeeld een lid dat de gangrol van twee gangs tegelijk heeft. Deze rol krijgt hier **geen rechten** van. Laat `rol` leeg om de ping weer uit te zetten; de melding zelf blijft dan gewoon komen. |
| `/setup bodemrol` | `rol` (optioneel) | Houdt alle gangrollen altijd **boven** deze rol in de rollenlijst, ook nieuwe. Wordt meteen toegepast op de bestaande gangrollen. Laat `rol` leeg om de ondergrens weer uit te zetten. `@everyone` en gangrollen worden geweigerd. |
| `/setup gedeelde-categorie` | `categorie`*, `actie`* (`toevoegen` / `verwijderen`), `sync_kinderen` (ja/nee, standaard nee) | Beheert de lijst categorieen waar alle gangs toegang toe krijgen. `sync_kinderen:ja` **overschrijft de permissies van de kanalen in die categorie** - gebruik met beleid. |
| `/setup limieten` | `leden` (1-100), `bosses` (1-10), `underbosses` (0-10) | Zet de standaardlimieten voor **nieuwe** gangs. Bestaande gangs veranderen niet. |
| `/setup dashboard` | `kanaal`* | Kiest het kanaal voor het live bezettingsoverzicht en post het bericht meteen. |
| `/setup toon` | (geen) | Toont de huidige configuratie, een checklist van wat nog ontbreekt en welke botrechten missen. |

---

## 9. Werken met #aangenomen en #ontslagen

Dit is waar de bot dagelijks voor gebruikt wordt. De boss of underboss van een gang
plaatst een bericht met een @-mention; de bot doet de rest.

> **Voorwaarde:** `/setup kanalen` moet gedraaid zijn (hoofdstuk 7). Anders reageert de bot
> nergens op en staan de twee kanalen ook nog voor iedereen open.

### Wie mag er typen in #aangenomen en #ontslagen?

Deze twee kanalen zijn **registers voor de gangs onderling**: iedereen die in een gang zit
mag ze lezen en teruglezen, maar er **iets in zetten** mag alleen wie er iets te melden
heeft. Wie in geen enkele gang zit, ziet de kanalen niet eens staan.

| Wie | Zien en lezen | Typen |
|---|---|---|
| `@everyone` (wie geen gangrol, staffrol of extrarol heeft) | **Nee** | **Nee** |
| Gewone gangleden (de gangrol) | Ja | **Nee** |
| Boss en underboss van een gang | Ja | **Ja** |
| Staff (`/setup staffrol`) | Ja | **Ja**, plus foute regels opruimen |
| Extrarollen (`/setup extrarollen`) | Ja | **Ja** |
| De bot zelf | Ja | Ja |

Serverbeheerders (het recht **Beheerder**) komen hier sowieso bij: dat recht negeert alle
kanaalrechten en dat kan Discord niet blokkeren.

**Waarom via de kanaalrechten en niet via de bot?** De bot kan een fout bericht alleen
*achteraf* weigeren. Het staat dan al in het register, iedereen heeft het gelezen, en gaat
er iets mis bij het opruimen (bot offline, Discord traag), dan blijft het staan. Met deze
rechten houdt **Discord** het bericht al tegen bij het verzenden: er komt dus nooit rommel
in het register.

Ook de threadrechten staan dicht. Anders kon je het kanaal simpelweg omzeilen door er een
thread in te openen en daarin te typen - dat is dezelfde ruimte, met een andere deur.

**Hoe zet je dit aan?** Draai `/setup kanalen` (opnieuw):

```
/setup kanalen aangenomen:#aangenomen ontslagen:#ontslagen
```

- **Draaide je de bot al vóór deze versie? Draai dit dan een keer opnieuw.** Je krijgt dan
  in het antwoord te zien dat de kanalen dichtgezet zijn, en welke rechten daarbij eventueel
  ontbraken. Dat is de enige plek waar je dat zwart op wit ziet.
- Maak je later een nieuwe gang aan, dan krijgen de verse boss- en underbossrol hun
  schrijfrecht meteen. Je hoeft dus niets opnieuw te draaien.
- De bot herstelt het slot ook bij elke start, voor het geval iemand de rechten met de hand
  heeft aangepast of het kanaal naar een andere categorie heeft gesleept. Dat meldt hij
  alleen in de terminal.
- Ziet de bot in zo'n kanaal een **vreemde rol** die er zelf schrijfrecht heeft (een
  moderatorrol bijvoorbeeld), dan **meldt** hij dat, maar haalt hij het niet weg. Dat zijn
  je eigen kanalen; de bot gooit daar niets in stuk. Wil je die rol er echt uit, doe dat
  dan zelf bij Kanaalinstellingen &rarr; Rechten.

### Wat er gebeurt na jouw bericht

1. De bot zet een reactie onder je bericht:

   | Reactie | Betekenis |
   |---|---|
   | ✅ | Alles gelukt |
   | ⚠️ | Deels gelukt (lees de samenvatting voor wie er niet doorheen kwam) |
   | ❌ | Niets gelukt |
   | ❓ | Geen bruikbare @-mention in je bericht gevonden |

2. De bot antwoordt met een samenvatting: per persoon een regel, plus de nieuwe bezetting.
   Ging alles (deels) goed, dan blijft dat bericht staan als bewijs. Ging er niets goed,
   dan ruimt de bot het na 60 seconden zelf op.
3. Elke geslaagde actie gaat naar het logboekkanaal, met een **Terugdraaien**-knop.

### Voorbeelden voor #aangenomen

**Een of meer mensen aannemen:**

```
@Jan @Piet
```

> Beiden worden lid van de gang waar jij boss of underboss van bent. Je kunt maximaal
> 20 personen in een bericht noemen.

> **Er is nog maar één soort lid.** Je hoeft dus geen sleutelwoord meer achter een naam te
> zetten: iedereen die je hier aanneemt krijgt de gangrol en telt mee voor de ledenlimiet.
> Wil je van iemand een underboss maken, doe dat daarna met `/gang promoveer`.

**Staff die voor een specifieke gang aanneemt - zet de gangrol of de gangnaam erbij:**

```
@Rayuza @Jan
```

```
Rayuza @Jan
```

> Die eerste `@Rayuza` is de **rol**mention van de gang, geen persoon. De bot filtert
> rolmentions weg bij het zoeken naar personen, dus die wordt nooit per ongeluk als lid
> aangenomen.

**Ben je boss van meerdere gangs?** Dan moet je altijd zelf de gang erbij zetten
(rolmention of naam). De bot vraagt er anders om en noemt je keuzes.

### Voorbeelden voor #ontslagen

**Iemand ontslaan:**

```
@Sara
```

**Ontslaan met een reden - twee schrijfwijzen, allebei goed:**

```
@Sara | reden: verraden
```

```
@Sara | zat al maanden inactief
```

**Het reden-formaat, precies:**

| Vorm | Voorbeeld | Wat wordt de reden |
|---|---|---|
| `reden: <tekst>` | `@Sara reden: verraden` | `verraden` |
| `\| <tekst>` (alles achter de eerste `\|`) | `@Sara \| verraden` | `verraden` |
| Beide door elkaar | `@Sara \| reden: verraden` | `verraden` |

- `reden:` heeft voorrang op de `|`.
- De reden mag maximaal 400 tekens zijn; langere tekst wordt afgekapt.
- **Alles achter `|` of `reden:` telt niet mee als persoon of als gangnaam.** Schrijf je
  dus `@Sara | overgelopen naar Rayuza`, dan wordt Sara ontslagen bij *jouw* gang, niet
  bij Rayuza.
- Een reden geven is optioneel, maar staat wel netjes in het logboek en in de historie.

**Meerdere mensen met dezelfde reden:**

```
@Sara @Kevin | reden: gangoorlog verloren
```

### Wie mag hier iets doen?

| Situatie | Resultaat |
|---|---|
| Je bent boss of underboss van precies een gang | Werkt meteen; je hoeft de gang niet te noemen |
| Je bent boss of underboss van meerdere gangs | Zet de gangrol of de gangnaam in je bericht |
| Je bent staff | Zet altijd de gangrol of de gangnaam in je bericht |
| Je bent geen van beide | Discord laat je bericht niet eens versturen; het kanaal staat voor jou op alleen-lezen |

### Veelgemaakte fouten in deze kanalen

- **Naam typen in plaats van mentionen.** `Jan` werkt niet, `@Jan` wel. Kies de persoon uit
  het lijstje dat Discord toont tijdens het typen.
- **De verkeerde @Rayuza kiezen.** Bedoel je de *gang*, kies dan de **rol** `@Rayuza` uit
  het lijstje, niet een gebruiker die toevallig zo heet.
- **Een bot mentionen.** Bots kunnen geen gangrollen krijgen.
- **Iemand aannemen die al in een andere gang zit.** De bot weigert dat en vertelt bij
  welke gang die persoon zit. Laat hem daar eerst ontslaan worden.

---

## 10. De limieten: 22 leden per gang

Een gang heeft **één soort lid** en dus **één** grens op het aantal personen.

| Limiet | Standaard | Wat wordt geteld |
|---|---|---|
| **Ledenlimiet** | **22** | Iedereen met de gangrol. **De boss en de underboss tellen hierin mee** - het zijn dus geen extra plekken. |

Ofwel: **22 personen per gang, boss en underboss inbegrepen.** Je past hem per gang aan met
`/gangbeheer limiet gang:Rayuza leden:<aantal>` (1 t/m 100).

### Hoeveel leiders mag een gang hebben?

Daarnaast gelden er twee grenzen op de leiding. Die staan los van de ledentelling: een
boss en een underboss zijn gewoon leden en tellen dus ook mee binnen de 22.

| Limiet | Standaard | Wat wordt geteld |
|---|---|---|
| **Bosslimiet** | **2** | Iedereen met de rol `<Gang> Boss`. |
| **Underbosslimiet** | **2** | Iedereen met de rol `<Gang> Underboss`. |

Probeer je er een derde bij te zetten, dan weigert de bot dat:

> Rayuza heeft al 2/2 underbosses. Degradeer er eerst één met `/gang degradeer`, of
> verhoog de limiet met `/gangbeheer limiet underbosses:<aantal>`.

Wordt een underboss gepromoveerd tot boss, dan maakt hij zijn underbossplek meteen vrij -
die telt dus niet dubbel.

### De ladder

> **De gang hoef je niet op te geven.** Niemand zit in twee gangs tegelijk, dus de bot leidt
> uit de gangrol van het gekozen lid af om welke gang het gaat. Heeft iemand met de hand
> tóch twee gangrollen gekregen, dan kiest de bot bewust niet zelf: je krijgt een melding
> dat er eerst een rol weg moet, en de **meldrol** (`/setup meldrol`) krijgt daar een ping
> over in het logkanaal.
>
> Een reden opgeven kan hier niet meer; die stond toch al in het logboek bij wie het deed en
> wanneer.

Iedereen in een gang staat op een van **drie** treden. `/gang promoveer` zet iemand een stap
omhoog, `/gang degradeer` een stap omlaag. Je hoeft dus niet te kiezen wélke rol iemand
krijgt — de bot kijkt zelf waar diegene staat.

```
lid  →  underboss  →  boss
```

Een paar dingen die daaruit volgen:

- **Een lid promoveren maakt hem underboss**, en nog een keer promoveren maakt hem boss
  (die laatste stap mag alleen staff zetten).
- Een **underboss die boss wordt, verliest zijn underbossrol** — die plek komt dus vrij.
- **Lager dan lid bestaat niet.** Degradeer je een gewoon lid, dan zegt de bot dat de ladder
  daar ophoudt en verwijst hij naar `/gang ontslaan` of `#ontslagen`. Er gebeurt verder
  niets, dus je kunt niemand per ongeluk uit de gang degraderen.
- Elke trede toetst zijn eigen limiet: een derde underboss wordt geweigerd zolang de
  underbosslimiet 2 is.

### Wie mag promoveren en degraderen?

| Actie | Boss van de gang | Staff |
|---|---|---|
| Lid &rarr; underboss | Ja | Ja |
| Underboss &rarr; lid | Ja | Ja |
| Underboss &rarr; boss | **Nee** | Ja |
| Iets veranderen aan een zittende boss | **Nee** | Ja |

De gedachte erachter: een boss regelt zijn eigen rechterhand zonder dat er een staflid
aan te pas hoeft te komen, maar het **bossschap zelf blijft bij jullie**. Een boss kan
zichzelf dus niet vervangen, zijn mede-boss niet wegwerken en niemand promoveren tot
zijn gelijke. Een underboss mag helemaal niemand promoveren.

Alles komt hoe dan ook in het staf-logboek te staan, ook als de boss het zelf doet.

Een volle gang ziet er zo uit:

```
 1  boss           |
 2  underbosses    |  samen 22  -> ledenlimiet bereikt
19  gewone leden   |
-----------------------------------------------
22  personen met de gangrol
```

Zit een gang vol, dan krijg je een melding als:

> Rayuza zit vol (22/22 leden). Ontsla eerst iemand in #ontslagen.

Is de uitvoerder staff, dan staat er meteen bij hoe je de limiet verhoogt.

En in het logboek verschijnt een waarschuwing zodra een gang tegen een grens aan zit.

### Hoe staff de limieten aanpast

**Voor een gang** (dit is wat je meestal wilt):

```
/gangbeheer limiet gang:Rayuza leden:25
```

Wat je niet invult, blijft ongewijzigd. Wil je alleen de leiding verruimen:

```
/gangbeheer limiet gang:Rayuza underbosses:3
```

**Voor alle nieuwe gangs** (de standaardwaarden van de server):

```
/setup limieten leden:22
```

Dit verandert **niets** aan bestaande gangs - die pas je per stuk aan met `/gangbeheer limiet`.

**Toegestane waarden:** leden 1-100, bosses 1-10, underbosses 0-10.

De actuele bezetting zie je met `/gang info`, `/gang lijst` of op het dashboard, in de vorm
`19/22 leden`.

---

## 11. Wat maakt /gangbeheer aanmaken precies aan?

Bij `/gangbeheer aanmaken naam:Rayuza emoji:⚔️` zet de bot dit neer.

### 1 categorie

`⚔️ | Rayuza` - de emoji, een spatie, een liggend streepje en de naam.

### 6 kanalen (in deze volgorde)

| Kanaal | Type | Waarvoor |
|---|---|---|
| `📢・rayuza-mededeling` | Tekst | Mededelingen van de leiding; leden lezen alleen mee |
| `💀・rayuza-boss` | Tekst | Alleen boss en underboss zien dit kanaal |
| `💭・rayuza-chat` | Tekst | De gewone gangchat |
| `📷・media` | Tekst | Foto's en video's |
| `👤・dark-chat` | Tekst | Gevoelige zaken; **alleen boss en underboss zien dit kanaal** |
| `📞・rayuza-oortje` | Spraak | Het spraakkanaal van de gang |

De emoji staat vast per kanaalsoort en wordt van de naam gescheiden door het teken `・`.

### Een afkorting voor lange gangnamen

Bij een lange naam worden die kanaalnamen onwerkbaar: *Grove Street Family* levert
`💭・grove-street-family-chat` op. Geef daarom een **afkorting** mee:

```
/gangbeheer aanmaken naam:Grove Street Family emoji:🟢 afkorting:gsf
```

| | Zonder afkorting | Met `afkorting:gsf` |
|---|---|---|
| Categorie | `🟢 \| Grove Street Family` | `🟢 \| Grove Street Family` |
| Rollen | `Grove Street Family`, `... Boss`, `... Underboss` | ongewijzigd |
| Kanalen | `💭・grove-street-family-chat` | `💭・gsf-chat` |

De afkorting raakt dus **alleen de kanaalnamen**. De categorie en de drie rollen houden de
volledige naam; daar is de lengte geen probleem.

De optie is niet verplicht - laat je hem weg, dan komen de kanaalnamen gewoon uit de
volledige naam, precies zoals daarvoor.

**Later toevoegen of wijzigen** kan ook; de kanalen worden dan meteen hernoemd:

```
/gangbeheer hernoemen gang:Grove Street Family afkorting:gsf
/gangbeheer hernoemen gang:Grove Street Family afkorting_weghalen:ja
```

Twee dingen om te weten:

- Een afkorting moet **2 tot 20 tekens** zijn en minstens één letter of cijfer bevatten.
- Twee gangs kunnen niet dezelfde kanaalnaam krijgen. Kiest een tweede gang een afkorting
  die al bezet is, dan weigert de bot dat met een melding in plaats van er stilletjes een
  streepje achter te plakken.

In `/gang info` staat onder de bezetting welke kanaalnaam een gang gebruikt en of dat een
afkorting is - handig als je je afvraagt waarom een kanaal `gsf-chat` heet.
De gangnaam in de kanaalnamen is de "slug": kleine letters, spaties worden streepjes
(`Los Zetas` wordt `los-zetas`). De kanalen `📷・media` en `👤・dark-chat` heten in elke
gang hetzelfde; ze staan alleen in een andere categorie.

### 3 rollen

| Rol | Naam | Wie krijgt hem |
|---|---|---|
| Gangrol | `Rayuza` | **Iedereen** in de gang, dus ook de boss en de underboss |
| Bossrol | `Rayuza Boss` | De boss (heeft daarnaast ook de gangrol) |
| Underbossrol | `Rayuza Underboss` | De underboss (heeft daarnaast ook de gangrol) |

De rollen zijn **mentionable** en hebben **zelf geen serverrechten** - alle toegang wordt
per kanaal geregeld.

De **gangrol** wordt apart weergegeven in de ledenlijst: elke gang krijgt daar een eigen
kopje met al zijn leden eronder. De boss- en underbossrol niet, want Discord zet iemand
maar onder één kopje - dat van zijn hoogste apart weergegeven rol. Zou je ze alle drie
apart zetten, dan verdwijnt de boss juist uit het kopje van zijn eigen gang.

> **Liever toch drie kopjes per gang?** Zet `boss` en `underboss` in `ROLE_HOIST`
> ([src/lib/constants.js](src/lib/constants.js)) op `true` en draai daarna
> `/gangbeheer rolweergave`.

> **Gangs van vóór deze versie** staan nog niet goed: draai eenmalig
> `/gangbeheer rolweergave`. Dat loopt alle gangs langs en slaat over wat al klopt.

De bot zet de drie rollen meteen als **één blokje** in de rollenlijst, met de hoogste rang
bovenaan:

```
Rayuza Boss
Rayuza Underboss
Rayuza
```

Nieuwe gangs komen daar als volgend blokje onder te staan, in aanmaakvolgorde. Zie
[hoofdstuk 6](#de-bot-zet-de-gangrollen-zelf-op-volgorde).

> **Onthoud:** een boss heeft **twee** rollen (`Rayuza` + `Rayuza Boss`). Haal je er met de
> hand een weg, dan klopt de telling niet meer. Gebruik `#ontslagen` of `/gang ontslaan`;
> die halen alles in een keer weg.

### De permissiematrix

Zo ziet de toegang eruit. Alle kanalen erven de instellingen van de categorie; alleen waar
het hieronder afwijkt, is dat expliciet ingesteld.

| Kanaal | @everyone | Lid (gangrol) | Underboss / Boss | Staff, OWC, wapendealer |
|---|---|---|---|---|
| **Categorie `⚔️ \| Rayuza`** | Geen toegang | Lezen, schrijven, bestanden, links, reacties | Lid + berichten beheren, muten, slepen (boss ook doof zetten en voorrang) | Alles zien en schrijven |
| `📢・rayuza-mededeling` | Geen toegang | **Alleen lezen** | Lezen + **posten** + beheren | Lezen + **posten** |
| `💀・rayuza-boss` | Geen toegang | **Geen toegang** | Lezen en schrijven | Lezen en schrijven |
| `💭・rayuza-chat` | Geen toegang | Lezen en schrijven | Lezen, schrijven, beheren | Lezen en schrijven |
| `📷・media` | Geen toegang | Lezen, schrijven, bestanden | Lezen, schrijven, beheren | Lezen en schrijven |
| `👤・dark-chat` | Geen toegang | **Geen toegang** | Lezen en schrijven | Lezen en schrijven |
| `📞・rayuza-oortje` (spraak) | Geen toegang | Deelnemen en **meeluisteren**, niet praten | Deelnemen en meeluisteren, **niet praten**, wel muten en slepen | Deelnemen en meeluisteren, **niet praten** |

En buiten de gangcategorie, in de twee registers van de server:

| Kanaal | @everyone | Lid (gangrol) | Underboss / Boss | Staff, OWC, wapendealer |
|---|---|---|---|---|
| `#aangenomen` en `#ontslagen` | Lezen, **niet typen**, geen threads | Lezen, **niet typen** | Lezen en **typen** | Lezen en **typen** (staff ook opruimen) |

**Toelichting:**

- **💀・boss en 👤・dark-chat zijn alleen voor de leiding.** Gewone leden zien deze twee
  kanalen niet eens staan.
- **In het oortje praat niemand.** Het is een luisterkanaal: je zit erbij, het praten
  gebeurt in-game. Iedereen kan binnenlopen en meeluisteren, maar geen enkele microfoon
  doet het - ook die van de boss niet. De bot zet `Spreken` en `Video` daar dicht voor
  `@everyone`, voor de gangrol en voor de extrarollen; dat moet apart per rol, want in
  Discord wint een toestemming op de ene rol van een weigering op een andere.
  Eén uitzondering die geen enkel kanaalrecht tegenhoudt: wie het serverrecht **Beheerder**
  heeft, kan altijd praten. Dat is Discord, niet de bot.
- **Staff, OWC en wapendealers zien en mogen alles** in elke gang, ook het bosskanaal en
  dark-chat. Praten in het oortje kunnen ook zij niet. De stafrol stel je in met
  `/setup staffrol`; OWC en de wapendealers voeg je toe met `/setup extrarollen`.
- Waarom die rollen ook binnenkomen in kanalen die voor leden dichtstaan: Discord haalt
  eerst alle weigeringen weg en zet daarna alle toestemmingen erbij. Een toestemming op
  de ene rol wint dus van een weigering op een andere rol. Precies daarom staat de
  weigering voor dark-chat op de **gangrol zelf**: die heeft ieder lid, en boss en underboss
  krijgen het kijkrecht er via hun eigen rol weer bovenop.
- **De bot zelf** krijgt op de categorie de rechten om kanalen en rollen te beheren en om
  te posten, en in `#aangenomen` en `#ontslagen` een eigen uitzondering. Haal die
  instellingen niet weg: zonder die uitzondering treft de weigering voor `@everyone` ook de
  bot en kan hij daar niet meer antwoorden.
- Wijzig je later met de hand permissies en gaat er iets mis? `/gangbeheer herstel gang:Rayuza`
  zet de gangkanalen terug zoals hierboven; `/setup kanalen` doet dat voor de registers.

### Gedeelde categorieen

Heb je met `/setup gedeelde-categorie` categorieen aangemeld, dan krijgt de gangrol daar
bij het aanmaken automatisch toegang toe: kijken, geschiedenis lezen, berichten sturen,
reacties, bestanden, links, en deelnemen en praten in spraak.

---

## 12. Logboek, terugdraaien en dashboard

### Het logboek

Stel het in met `/setup kanalen logboek:#gang-logboek`. In dat kanaal komt elke actie te
staan: wie werd aangenomen of ontslagen, door wie, bij welke gang, met welke reden en hoe
vol de gang daarna is. Ook deze gebeurtenissen worden gemeld:

- **Iemand verlaat de server** terwijl hij nog in een gang zat, inclusief de melding dat er
  weer een plek vrij is.
- **Handmatige rolwijzigingen**: geeft een staflid iemand met de hand de rol `Rayuza`, dus
  buiten de bot om, dan registreert de bot dat en meldt wie het deed. Hiervoor is het recht
  **Auditlogboek bekijken** nodig.
- **Waarschuwing zodra een gang vol zit.**

Maak dit kanaal alleen zichtbaar voor staff.

### Terugdraaien

Onder elk logbericht staat een knop **Terugdraaien**. Alleen staff kan erop klikken.

- Een **aanname** terugdraaien: de gangrol wordt weer weggehaald.
- Een **ontslag** terugdraaien: de gangrol komt terug. **Let op:** een boss- of
  underbossrol komt *niet* automatisch terug - geef die opnieuw met `/gang promoveer`.
- Zat de gang inmiddels vol, dan meldt de bot dat de gang boven de limiet uitkomt.
- Oude regels van vóór deze versie (aannames als meeloper) blijven gewoon leesbaar in het
  logboek en in `/gang historie`, en zijn ook nog terug te draaien.
- Een actie kan maar **een keer** teruggedraaid worden. Daarna wordt de knop grijs en het
  bericht gemarkeerd met wie het terugdraaide.

### Het dashboard

`/setup dashboard kanaal:#gang-overzicht` post een overzicht van alle gangs met hun
bezetting. De bot werkt dat bericht elke **5 minuten** bij, en ook direct na elke aanname
of elk ontslag. Wordt het bericht verwijderd, dan post de bot vanzelf een nieuw bericht.

---

## 13. Back-up en herstel

### Waar staat de data?

Alles wat de bot onthoudt staat in **een bestand**:

```
data/owc.json
```

Heb je `DATA_DIR` in `.env` gezet (aanbevolen als het project in OneDrive staat), dan
staat het bestand daar in plaats van in `data/`. Bij het opstarten meldt de bot altijd
welke map hij gebruikt:

```
[10:14:42] [INFO ] Datamap: C:UsersjouwnaamOWC-gangbot-data
```

Daarin staan: de serverinstellingen (welk kanaal welk is, de stafrol, de limieten), alle
gangs met hun rol- en kanaal-ID's, en de actiegeschiedenis (de laatste 5000 acties).

De kanalen en de rollen zelf staan natuurlijk in Discord; `owc.json` is de verbinding
daartussen.

### Back-up maken

Kopieer `data/owc.json` regelmatig naar een veilige plek. Dat mag terwijl de bot draait.

```
copy data\owc.json data\owc-backup-2026-09-10.json      (Windows)
cp data/owc.json data/owc-backup-2026-09-10.json        (Linux / macOS)
```

Maak in elk geval een back-up **voordat** je de bot verplaatst, bijwerkt of opnieuw
installeert.

### Terugzetten

1. Stop de bot (`Ctrl + C`).
2. Zet je back-up terug over `data/owc.json` heen.
3. Start de bot opnieuw (`npm start`).

De bot schrijft altijd atomisch: eerst naar `owc.json.tmp`, daarna wordt dat er in een keer
overheen gezet. Zo raakt het bestand niet halverwege beschadigd bij een stroomstoring. Is
het bestand toch onleesbaar, dan hernoemt de bot het naar `owc.json.corrupt-<tijdstempel>`
en begint hij met een leeg bestand. Je oude gegevens staan dan dus nog in dat
`.corrupt-`bestand.

> **Niet doen:** `owc.json` met de hand aanpassen terwijl de bot draait. De bot houdt de
> inhoud in het geheugen en overschrijft je wijziging bij de eerstvolgende actie.

### /gangbeheer herstel - reparatie in Discord

Is er in Discord iets weggegooid (een kanaal, de categorie of een rol), gebruik dan:

```
/gangbeheer herstel gang:Rayuza
```

De bot:

- maakt ontbrekende **rollen** opnieuw aan;
- maakt de **categorie** opnieuw aan als die verdwenen is;
- maakt ontbrekende **kanalen** opnieuw aan en zet losgeraakte kanalen terug in de
  categorie;
- zet **alle permissies** weer zoals ze horen;
- zet de **rollenlijst** weer op volgorde: per gang een blokje met Boss, Underboss en de
  gangrol onder elkaar;
- ruimt een achtergebleven **`<Gang> Meeloper`-rol** uit de oude opzet op (zie
  [hoofdstuk 15](#15-draaide-je-de-bot-al-dit-verandert-er));
- herstelt de toegang tot de **gedeelde categorieen**.

Je krijgt een lijstje te zien van wat er precies hersteld is. Was alles al in orde, dan
zegt de bot dat ook.

> Let op: een **nieuw aangemaakte rol is leeg**. Was de rol `Rayuza` verwijderd, dan hebben
> de leden hem daarna niet meer en moet je ze opnieuw toevoegen (bijvoorbeeld via
> `#aangenomen`). De kanalen en de permissies zijn wel meteen weer goed.

---

## 14. Problemen oplossen

| Symptoom | Oorzaak | Oplossing |
|---|---|---|
| **De bot staat online, maar reageert nergens op als ik `@Jan` in #aangenomen typ. Geen reactie, geen foutmelding.** | Of `/setup kanalen` is nooit gedraaid (de bot weet niet dat dit het aannamekanaal is), of de **Message Content Intent** staat uit (de bot ziet de inhoud van je bericht niet). | Draai `/setup toon` en kijk of het aangenomen-kanaal er staat; zo niet: `/setup kanalen`. Staat dat goed, zet dan in de Developer Portal (**Bot** &rarr; *Privileged Gateway Intents*) de **Message Content Intent** aan en **herstart de bot**. |
| **"Ik kan de rol Rayuza niet toekennen" of "Missing Permissions" bij elke aanname.** | De rol van de bot staat **onder** de gangrollen. Discord staat dan niet toe dat de bot die rollen uitdeelt. | Serverinstellingen &rarr; **Rollen** &rarr; sleep de botrol **boven** alle gangrollen (hoofdstuk 6) &rarr; Opslaan. |
| **De bot start niet en de terminal zegt `Used disallowed intents`.** | De **Server Members Intent** en/of de **Message Content Intent** staat uit in de Developer Portal. | Zet beide schuifjes aan (Developer Portal &rarr; **Bot** &rarr; *Privileged Gateway Intents*), klik **Save Changes** en start de bot opnieuw. |
| **Alle gangs tonen `0/22 leden`, terwijl er wel mensen in zitten.** | De **Server Members Intent** staat uit, dus de bot kan de ledenlijst niet ophalen. In de opstartlog staat dan: *"Kon de leden van ... niet ophalen"*. | Zet de Server Members Intent aan en start de bot opnieuw. De telling klopt daarna binnen enkele seconden. |
| **`/gang` en `/setup` staan niet in het commandolijstje van Discord.** | De commando's zijn nooit geregistreerd, of ze zijn globaal geregistreerd (dat kan tot een uur duren). | Voer `npm run deploy` uit. Vul `GUILD_ID` in je `.env` in voor directe registratie op jouw server. Werkt het nog niet: ververs Discord met Ctrl+R en controleer dat de bot is uitgenodigd met de scope `applications.commands`. |
| **"Alleen de boss of underboss van een gang mag hier aannemen", terwijl die persoon wel de boss is.** | Die persoon heeft de rol `Rayuza Boss` niet, maar bijvoorbeeld alleen `Rayuza`. | Promoveer die persoon met `/gang promoveer lid:@Jan` tot hij boss is (staff mag de laatste stap zetten). Dat zet meteen ook de gangrol goed. |
| **"Rayuza zit vol (22/22 leden)" terwijl je er visueel minder ziet.** | Boss en underboss tellen mee binnen de 22, en de bot telt iedereen met de gangrol - ook mensen die je vergeten was. | Bekijk `/gang info gang:Rayuza` voor de exacte lijst. Ontsla iemand in `#ontslagen`, of verhoog de grens met `/gangbeheer limiet gang:Rayuza leden:25`. |
| **Iemand aannemen lukt niet: "zit al bij Los Zetas".** | Een persoon kan maar bij een gang tegelijk horen; de bot weigert dubbele gangrollen. | Laat de leiding van Los Zetas die persoon eerst ontslaan (`#ontslagen` of `/gang ontslaan`) en neem hem daarna aan. Staff kan het ook zelf doen. |
| **De bot zet een ✅, maar de samenvatting is verdwenen.** | Ging er niets goed, dan ruimt de bot de samenvatting na 60 seconden op. Hint- en foutmeldingen verdwijnen al na 15 tot 30 seconden. | Bij (deels) succes blijft de samenvatting staan. Wil je het terugzien: `/gang historie gang:Rayuza`, of kijk in het logboekkanaal. |
| **Er komt niets in het logboekkanaal.** | Het logkanaal is niet ingesteld, of de bot mag er niet posten. De bot faalt hier bewust stil, zodat de aanname zelf wel doorgaat. | `/setup kanalen logboek:#gang-logboek` en geef de bot in dat kanaal *Kanaal bekijken*, *Berichten versturen* en *Links insluiten*. Controleer met `/setup toon`. |
| **Handmatige rolwijzigingen worden niet gemeld ("wie heeft Jan de rol Rayuza gegeven?").** | De bot mist het recht **Auditlogboek bekijken** (View Audit Log). | Serverinstellingen &rarr; Rollen &rarr; botrol &rarr; zet *Auditlogboek bekijken* aan. |
| **Het dashboardbericht wordt niet bijgewerkt.** | Het bericht is verwijderd, of de bot mag in dat kanaal niet meer posten of de geschiedenis niet lezen. | De bot post binnen 5 minuten vanzelf een nieuw bericht. Gebeurt dat niet: controleer de rechten en draai `/setup dashboard kanaal:#gang-overzicht` opnieuw. |
| **`/gangbeheer aanmaken` faalt en er staat niets half aangemaakt.** | Dat is expres: mislukt er iets halverwege, dan draait de bot alles terug. Meestal ontbreekt *Kanalen beheren* of *Rollen beheren*, of zit de server aan de limiet van 500 kanalen of 250 rollen. | Lees de foutmelding: die noemt de oorzaak. Geef de botrol de ontbrekende rechten, of ruim eerst oude kanalen en rollen op. |
| **Een kanaal of een rol van een gang is per ongeluk verwijderd.** | Iemand heeft het in Discord weggegooid. | `/gangbeheer herstel gang:Rayuza`. Let op: een opnieuw aangemaakte rol is leeg, dus de leden moeten opnieuw toegevoegd worden. |
| **De bot reageert met ❓ en een hint.** | In je bericht stond geen bruikbare @-mention, bijvoorbeeld alleen de naam getypt of alleen een rolmention. | Mention de persoon echt: typ `@` en kies de gebruiker uit het lijstje. Zie de voorbeelden in hoofdstuk 9. |
| **"Er zijn nog geen gangs aangemaakt", of de suggesties bij de optie `gang` blijven leeg.** | Er is nog geen gang aangemaakt, of `data/owc.json` is leeg of vervangen. | Maak een gang met `/gangbeheer aanmaken`. Ging er data verloren, zet dan je back-up terug (hoofdstuk 13). |
| **Een boss klaagt: "ik kan niks meer typen in #aangenomen".** | Die persoon heeft de rol `Rayuza Boss` niet (alleen `Rayuza`), of `/setup kanalen` is nooit gedraaid nadat die gang is aangemaakt. | Controleer met `/gang info gang:Rayuza` wie er boss is; promoveer die persoon anders met `/gang promoveer`. Draai daarna `/setup kanalen aangenomen:#aangenomen ontslagen:#ontslagen` opnieuw. |
| **Iedereen kan nog gewoon in #aangenomen typen.** | Je draaide de bot al vóór deze versie en hebt `/setup kanalen` sindsdien niet opnieuw gedraaid, óf de bot mist het recht *Rollen beheren* of *Kanaal bekijken* in dat kanaal. | Draai `/setup kanalen aangenomen:#aangenomen ontslagen:#ontslagen`. Blijft het open, geef de botrol dan in Kanaalinstellingen &rarr; Rechten *Kanaal bekijken* en *Rollen beheren* en probeer het opnieuw. |
| **Er wordt via een thread in #aangenomen getypt.** | De bot mist *Openbare threads maken* en/of *Privéthreads maken* op serverniveau, dus hij kon die rechten daar ook niet weigeren. | Geef de botrol die twee rechten (Serverinstellingen &rarr; Rollen &rarr; botrol) en draai `/setup kanalen` opnieuw. Zie [hoofdstuk 5](#5-de-bot-uitnodigen-op-je-server). |
| **"De rol van de bot staat te laag in de rollenlijst" na `/gangbeheer aanmaken`.** | De bot wilde de gangrollen als blokje neerzetten, maar er is boven hem geen plek voor. Hij verplaatst dan bewust niets. | Sleep de botrol in Serverinstellingen &rarr; **Rollen** boven alle gangrollen en draai `/gangbeheer herstel gang:Rayuza`. De gang zelf is gewoon aangemaakt; alleen de volgorde stond nog niet goed. |
| **De bot gaat offline zodra ik de terminal sluit.** | De bot draait als gewoon programma in dat terminalvenster. | Laat het venster openstaan, of draai de bot als achtergronddienst (bijvoorbeeld met `pm2` of als Windows-service). |

### Meer informatie bij een probleem

Zet in `.env` de regel op `DEBUG=1` en start de bot opnieuw. Je krijgt dan extra logregels
in de terminal die precies laten zien wat de bot doet. Zet hem daarna weer op `DEBUG=0`.

Handig om als eerste te draaien bij elk probleem:

```
/setup toon
```

Dat toont in een oogopslag de configuratie, de checklist en de ontbrekende botrechten.

---

## 15. Draaide je de bot al? Dit verandert er

Werkte je al met een oudere versie, met meelopers erin? Dan zijn dit de drie dingen die je
moet weten. **Je hoeft niets in `data/owc.json` aan te passen.**

### 1. Meelopers bestaan niet meer

Een gang heeft nog maar één soort lid. Er is geen meeloperrol meer, geen aparte teller en
geen sleutelwoord `meeloper` in `#aangenomen`.

- **Wie de rol `<Gang> Meeloper` had, houdt zijn gangrol** en is dus gewoon lid. Niemand
  raakt zijn plek in de gang kwijt.
- **De oude rol zelf ruim je op met `/gangbeheer herstel gang:<naam>`.** De bot verwijdert de
  achtergebleven `<Gang> Meeloper`-rol en zegt in het resultaat dat hij dat gedaan heeft.
  Lukt het verwijderen niet (bijvoorbeeld omdat de botrol te laag staat), dan gaat de rest
  van het herstel gewoon door en kun je het later opnieuw proberen. Verwijder je de hele
  gang, dan gaat die rol vanzelf mee.
- **Oude logregels blijven leesbaar.** Aannames van het type "meeloper" staan nog gewoon in
  het logboek en in `/gang historie`, en zijn ook nog terug te draaien. Er komen er alleen
  geen nieuwe meer bij.

### 2. De ledenlimiet is automatisch omgerekend

De drie oude limieten (leden, meelopers, totaal) zijn samengevoegd tot één ledenlimiet. Dat
gebeurt vanzelf bij het eerste opstarten, met deze regel:

```
nieuwe ledenlimiet = het kleinste van:  oude totaallimiet
                                        oude ledenlimiet + oude meeloperlimiet
```

Dat is **precies het aantal personen dat er vóór deze wijziging in mocht** - de bezetting
van je gangs verandert dus niet, en niemand valt ineens buiten de boot.

| Oude waarden | Nieuwe ledenlimiet |
|---|---|
| 15 leden + 2 meelopers, totaal 22 | **17** |
| 20 leden + 2 meelopers, totaal 22 | **22** |
| 20 leden + 2 meelopers, totaal 21 | **21** |

De bot meldt bij het opstarten per gang wat de nieuwe waarde is geworden. Klopt hij niet
met wat je bedoelde, zet hem dan recht met `/gangbeheer limiet gang:<naam> leden:<aantal>`. De
serverstandaard voor **nieuwe** gangs is op dezelfde manier omgerekend en pas je aan met
`/setup limieten leden:<aantal>`.

### 3. Draai `/setup kanalen` opnieuw

`#aangenomen` en `#ontslagen` zijn sinds deze versie **dichtgezet**: iedereen leest mee,
maar alleen de gangleiding, staff, de extrarollen en de bot kunnen er nog iets in zetten.
Draai daarvoor dit commando opnieuw:

```
/setup kanalen aangenomen:#aangenomen ontslagen:#ontslagen
```

Je krijgt dan meteen terug welke kanalen dichtgezet zijn en wat er eventueel niet lukte.
Dat is dus de manier om het te controleren. De bot zet het slot daarnaast ook bij elke
start opnieuw neer, maar dat zie je alleen in de terminal - en alleen als de kanalen al
gekoppeld zijn.

### Kort samengevat

```
1.  npm start                     -> de limieten worden vanzelf omgerekend
2.  /setup kanalen ...            -> #aangenomen en #ontslagen op slot
3.  /gangbeheer herstel gang:<naam>     -> per gang: meeloperrol weg, rolvolgorde goed
4.  /setup toon                   -> controleer of alles op groen staat
```
