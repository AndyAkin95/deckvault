# DeckVault

DeckVault is a local-first trading-card collection scanner and inventory app. Pokémon is the first supported game, with the codebase structured so additional card games can be added later.

## Current v0.1 features
- Phone-friendly installable PWA
- Phone camera preview + still capture
- Pokémon card lookup through TCGdex
- Card metadata, sets, rarity, variants, and images
- TCGplayer/Cardmarket price fields when available from the provider
- Local IndexedDB collection storage
- Quantity, condition, language, and variant tracking
- Collection value dashboard
- JSON backup + restore
- General CSV export
- Collectr-oriented transfer CSV
- Offline static shell through a service worker

## Current limitation
Automatic camera-to-card recognition is not implemented yet. The next scanner milestone is OCR/image matching and rapid automatic capture.

## Data privacy
Your collection stays in local browser storage unless you export it. Repository code and collection data are separate.

## Current Pokémon provider
TCGdex v2 REST API: https://api.tcgdex.net/v2/en

## Roadmap
1. Automatic card-boundary detection
2. OCR for card name and collector number
3. Image verification against candidate cards
4. Rapid scan mode with sound/haptic confirmation
5. Better foil/variant handling
6. More card-game providers
7. Stronger import/export adapters, including Collectr
