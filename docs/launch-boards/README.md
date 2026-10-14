# Launch boards — 20 October 2026

Five boards for launch. Each CSV is ready for **Admin → Boards → Seed entries** (`Name, Subtitle, ImageUrl`).
Every board closes on a Sunday at **9pm WAT**, so results go out each Monday morning.

| Board | Category | Opens | Closes (9pm WAT) | Entry limit | CSV |
|---|---|---|---|---|---|
| Song of the Year 2026 (hero) | Music | Tue 20 Oct | Sun 13 Dec | 20 | `song-of-the-year-2026.csv` |
| Funniest Skit Maker | People | Tue 20 Oct | Sun 8 Nov | 20 | `funniest-skit-maker.csv` |
| Best Jollof in Lagos | Places | Tue 20 Oct | Sun 1 Nov | 20 | `best-jollof-in-lagos.csv` |
| Best University Campus Life | Culture | Tue 20 Oct | Sun 15 Nov | 20 | `best-university-campus-life.csv` |
| Nollywood Film of 2026 | Film | Tue 27 Oct | Sun 22 Nov | 20 | `nollywood-film-of-2026.csv` |

Set the entry limit to **20**, not the default 10. Each list seeds 11–12 names, which leaves room for nominations.

## Suggested board descriptions

- **Song of the Year 2026**: The one song that owned 2026. Released in 2026 to be eligible.
- **Funniest Skit Maker**: Who actually makes Nigeria laugh the most?
- **Best Jollof in Lagos**: Party rice, bukka rice, restaurant rice. One winner.
- **Best University Campus Life**: Which campus has the best student life? Alumni vote too.
- **Nollywood Film of 2026**: The best Nollywood film released in 2026.

## Check before seeding

- **Song of the Year**: built from TurnTable #1s up to mid-July 2026, plus songs Music In Africa highlighted early in the year. It is **missing anything that hit from August to October**, so add 2–3 current songs. Confirm *Body (danz)* and *Paparazzi* were released in 2026. They topped the chart in January, so they may be late-2025 releases. Asake appears on three entries, which will split his fans' votes. Consider keeping only *Jogodo*.
- **Best Jollof in Lagos**: the sources date from 2023. Check each spot is still open before launch.
- **Nollywood**: these are the top 10 cinema earners from January to July 2026, plus *Lady* from Sundance. Add any big releases from the second half of the year.
- **Skit makers**: from an April 2026 top-10 list, plus Kiekie and Layi Wasabi.

## Hero board

The homepage hero is the open board with the most verified votes. On a tie, as on launch day, it is the board that closes last, which is Song of the Year. To pin a board regardless of votes, set `VITE_HERO_BOARD_SLUG=song-of-the-year-2026` at build time.

Keep Nollywood in **draft** until 27 Oct, or set its "opens" time. The homepage shows "Opens Tue 27 Oct" for a live board with a future opening time.
