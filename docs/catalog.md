# Discover catalog: audit, architecture and operations

## Phase 1 audit (2026-11-09)

### What existed

- **No database.** BookNd is local-first: the library lives in the browser (IndexedDB via Dexie). The Vercel
  project (`booknd`, team HaveAnApp) had no environment variables and no storage attached.
- **Discover proxied two live feeds per request** (`app/api/catalog/route.ts`):
  - Project Gutenberg through Gutendex (falling back to Gutenberg's OPDS search, plus one `/ebooks/<id>.opds`
    request per result to filter out audiobooks), 32 books a page, English only.
  - Standard Ebooks through `https://standardebooks.org/feeds/atom/new-releases`.
- **Search, filters and "sorting" ran per source and per page.** Results were whatever the upstream page
  returned; there were no totals, no cross-source search, no deduplication and no ratings.
- **EPUB files are fetched on demand** through `/api/download` (allow-listed, streamed, never stored server-side).
  The reader, library and import flow are untouched by this work.

### Why only 15 Standard Ebooks titles appeared

The new-releases Atom feed contains only the **15 most recent releases**. Standard Ebooks' complete OPDS, Atom
and RSS catalog feeds are reserved for Patrons Circle members (HTTP authentication). That restriction is
respected: BookNd does not use or imitate those feeds and does not scrape the website's listing pages.

Instead BookNd reads Standard Ebooks' **own public source repositories** at `github.com/standardebooks`. Every
released ebook has a CC0-dedicated repository whose homepage is the ebook's page and whose
`src/epub/content.opf` holds its full metadata (title, authors, translators, genres, LCSH subjects, description,
language, release date and the Project Gutenberg transcription it was produced from). The organisation lists
about 1,550 repositories, of which the non-archived ones with an ebook homepage are released books (tool
repositories such as `tools` or `web` have none). Repositories are re-read only when they change (`pushed_at`).

### Feasible coverage and sources

| Source | Bulk access used | Licence / permission | Notes |
|---|---|---|---|
| Project Gutenberg | `gutenberg.org/cache/epub/feeds/rdf-files.tar.bz2` (official offline catalog, one RDF per ebook, ~100 MB) | Gutenberg asks robots to use these feeds instead of crawling | Streamed through `bzip2` and parsed in one pass; skipped when `Last-Modified` is unchanged. Gives downloads (last 30 days), subjects, bookshelves, languages, summaries, formats. |
| Standard Ebooks | GitHub REST listing of `standardebooks` (≈16 requests) + one raw `content.opf` per new/changed repo | CC0 sources, public | Full OPDS feeds need membership; not used. |
| Open Library ratings | `search.json?q=id_project_gutenberg:(…)` – 100 ebooks per request, ≤1 request/second, identified User-Agent | Open Library data is openly licensed; API is public | Ratings are **work-level** averages. A strict title/author search is the fallback for the most-read unmatched books. |

**Readable** means: DCMI type Text (audiobooks and other media are excluded), an EPUB format listed in the
record, and "Public domain in the USA" rights (titles marked copyrighted are excluded, as before). Exclusion
counts are reported per run.

### Other rating providers investigated

| Provider | Status |
|---|---|
| Goodreads | Public API retired (Dec 2020); scraping is against its terms. **Not used.** |
| Amazon | Reviews/ratings not licensed for third-party display. **Not used.** |
| Google Books API | Has `averageRating`/`ratingsCount`, but needs an API key (1,000 requests/day default), ratings are per *volume* (edition) not work, and caching terms restrict long-term storage. Possible later with a key and an edition→work rule; not added now. |
| LibraryThing | Bulk APIs largely discontinued; terms require permission for ratings data. Not used. |
| Hardcover | GraphQL API requires a personal token and is beta; terms on redistribution unclear. Not used now. |
| Wikidata | No reader ratings. |

### Blockers and decisions

- **Creating a new Postgres database (Neon) was not authorised in this session** – it is a new shared resource.
  The design therefore needs **no new service and no secrets**: the catalog is built by a scheduled GitHub Action
  and published as release assets of this (public) repository; each BookNd server instance loads the compressed
  snapshot into memory and answers search from it. Cost: GitHub Actions minutes on a public repository and
  ordinary Vercel function memory – no new bills. A Postgres store can be added later behind the same `/api/search`
  contract if the owner wants it.
- This development sandbox cannot reach gutenberg.org, standardebooks.org or openlibrary.org; those are exercised
  in GitHub Actions (the `Catalog` workflow) and against production.

## Architecture

```
GitHub Actions: .github/workflows/catalog.yml (daily 06:17 UTC, manual, and a dry run on PRs)
  scripts/catalog/build.mjs
    ├─ Gutenberg rdf-files.tar.bz2 ──► readable editions
    ├─ standardebooks/* content.opf ──► Standard Ebooks editions
    ├─ group editions into works (scripts/catalog/lib.mjs groupEditions)
    ├─ Open Library ratings (id batches, strict search fallback) ─► work ratings + weighted score
    └─ release "catalog-latest": catalog.json.gz, state.json.gz (for the next incremental run), meta.json
Vercel: lib/catalog-index.ts loads catalog.json.gz into memory (checks meta.json every 10 min)
  /api/search          full-catalog search, filters, facets, sorting, pagination
  /api/catalog/status  counts and the last build's report (observability)
  /api/download        unchanged: EPUBs are fetched only when a reader adds a book
  /api/catalog         legacy live feeds, used by Discover only if the index is unavailable
```

### Deduplication (works and editions)

Editions are joined with a union-find:

1. a Standard Ebooks edition joins the Gutenberg transcription(s) its `content.opf` cites as `dc:source` – only when
   the titles match, because collections (Plato's *Dialogues*, *Short Fiction*) cite many separate books;
2. editions with the same normalised title (case, accents, punctuation, a leading article and an "…; or, …"
   alternative title ignored; volume numbers kept), the same first author and the same language are one work;
   anonymous works with short generic titles ("Poems", "Letters") are never grouped by title;
3. editions that Open Library files under the same work by Project Gutenberg id (confidence ≥ 0.9, same
   language, matching titles – Open Library sometimes lumps separate texts into one work) are one work.

The preferred edition is Standard Ebooks when there is one, then the most-downloaded transcription. Discover
shows one card per work; the details sheet lists every edition with its own Add button.

### Ratings

Open Library is the only provider; only its real averages (1–5) and counts are stored and shown. Per edition the
state records the Open Library work key, average, count, match confidence, method and when it was checked.

**Identity first, activity second.** A candidate work must first pass identity checks; reader activity
(`ratings_count × 10 + readinglog_count`) only ranks works that already passed, and never admits one that didn't.

- **Authors** agree when any edition author's surname matches any of the work's author names *or alternative
  names* (Open Library lists other scripts and spellings: "Лев Толстой" also as "Leo Tolstoy"). Transliterations
  match on the surname's consonant skeleton (Dostoevsky / Dostoyevsky / Dostoievski); surnames shorter than three
  consonants must match exactly.
- **gutenberg-id** (Open Library editions carry Project Gutenberg numbers; 100 numbers per request): the work's
  title must equal the edition's main title (0.98 with agreeing author, 0.9 without author data), or name the
  same work (one extends the other, or ≥ 50 % word overlap; 0.9 / 0.8). A title with no Latin letters — the
  original-language title, e.g. "Преступление и наказание" — is accepted only when the author agrees (0.85).
  An author mismatch is always rejected.
- **title-author** (0.75): searched with a cleaned main title (no subtitle, translator note, `[…]` or MARC marker)
  and the author's surname. The work's main title must be the *same* as the edition's (so "Pride and Prejudice
  and Zombies" never matches "Pride and Prejudice"); volumes ("[3/5]", "Part 2") are different books, and a single
  volume ("— Volume 07", "Vol. 2 of 3") is never rated through a search. For a translated edition, a work that names
  someone other than the author and the edition's own translator (Open Library files some translations as works of
  their own, e.g. *The Odyssey* by Homer and Emily R. Wilson) describes another translation and is not used.
- **Choosing among duplicate records** (all of which passed the identity checks): records with ≥ 5 ratings come
  first, then the most reader activity. A record with 1–4 ratings is accepted only when no other active record
  exists, and never for a *translated* edition found by search – a small English-titled record is how a wrong
  1-rating *Count of Monte Cristo* got in while the real work is filed as *Le Comte de Monte-Cristo*. Empty stub
  works (no ratings, no reading-log entries) never block a match.
- **A work's rating** is the best-supported *rated* match among its editions (highest confidence, then count);
  an unrated match never hides a rated one. No match with ratings → **Unrated**; nothing is estimated or blended.
- **Weighted score** (Top rated sort): `(n·c·R + 25·m) / (n·c + 25)` where R is the average, n the count, c the
  match confidence and m the catalog-wide mean. Few ratings or a weaker match stay near the mean; unrated works sort last.

Refresh: id lookups repeat every 14 days per edition (oldest first, ≤ 900 batches per run). Each run then searches
(≤ 4,500 per run, ≤ 1 request/second): existing search matches re-checked under the current rules first, then the
Standard Ebooks titles that have no Gutenberg edition (no number to look up), then the most-read unrated books; a
book is searched again after 60 days. `MATCHER_VERSION` in `scripts/catalog/lib.mjs` forces every stored match to be
re-checked when the rules change; `meta.json` lists each rating that changed (`ratingsChanges`).

Known limits: some canonical Open Library works are titled only in the original language in a Latin script
(*Le Comte de Monte-Cristo*, *Don Quijote*) and are not linked to the Gutenberg number; without a translation
source they cannot be identified safely and those books stay Unrated rather than borrowing a duplicate's rating.

### Operations

- **Schedule**: daily. Gutenberg is skipped when its catalog file is unchanged; Standard Ebooks repositories are
  re-read only when pushed; ratings are refreshed incrementally.
- **Retry and rate limits**: every request retries network errors, 429 and 5xx with exponential backoff and
  honours `Retry-After`; Open Library is paced to ≤ 1 request/second, GitHub raw files to ~7/second over 4 workers.
- **Safety**: if a source fails, the previous run's data for that source is kept. If the readable Gutenberg count
  drops by more than 10 % the run fails without publishing. `meta.json` is uploaded last, so servers only reload
  after the new catalog is in place.
- **Catalog loading (server)**: each instance keeps the catalog in memory and checks `meta.json` every 10 minutes.
  Release downloads are retried (3 attempts, backoff, 8 s / 40 s timeouts; 5xx, 429, 404 and timeouts count as
  transient). A failed refresh keeps the last good catalog and retries after a minute; a cold instance loads the
  catalog directly if `meta.json` is unreachable. Discover falls back to the per-source view only if no full-catalog
  results have reached the page yet; afterwards an outage shows a retryable error instead.
- **Observability**: the workflow's run summary (counts, requests, rate-limit hits, warnings), the `meta.json`
  artifact kept for 30 days, and `GET /api/catalog/status` on the live site.
- **Run manually**: Actions → Catalog → Run workflow (inputs: ratings budget, search budget, skip ratings).

## Phase 4 verification (production, 2026-11-09)

Build `42553242657` (catalog generated 2026-11-09T02:52Z), checked on https://booknd-lake.vercel.app with
`scripts/catalog/verify.mjs` and `tests/e2e-discover.mjs` (iPhone 13):

| | Count | How it was verified |
|---|---|---|
| Gutenberg RDF records read | 79,768 | build report |
| Readable Gutenberg ebooks indexed (Text + EPUB + US public domain) | 77,692 | excluded: 1,642 without EPUB, 420 copyrighted, 14 not text |
| Standard Ebooks released ebooks indexed | 1,542 of 1,542 released repositories | 0 parse failures |
| Editions indexed | 79,234 | `/api/catalog/status` = build report |
| Works after grouping (searchable) | 77,326 (61,164 in English) | `/api/search?lang=all` total = loaded works |
| Works with an Open Library rating | 1,049 (935 in English) | rated + unrated = total, overall and per language |
| Unrated works (discoverable, `Unrated` filter) | 76,277 | e2e: filter shows only unrated books |
| Download allow-list | 1,542 / 1,542 Standard Ebooks URLs; all Gutenberg URLs share one pattern | every SE URL checked against the allow-list |
| EPUBs actually downloaded through `/api/download` | 25/25 Gutenberg, 24/25 Standard Ebooks (the miss led to the multi-author allow-list fix) | random sample, ZIP + `mimetype` checked |
| End to end | Pride and Prejudice (Standard Ebooks edition) added from Discover and opened in the reader on an iPhone 13 profile | e2e |

Not every one of the 79,234 EPUBs has been downloaded; readability rests on catalog metadata (an EPUB format is
listed), the allow-list check above and the random sample. Open Library ratings are sparse for public-domain
titles: of ~9,400 editions matched to an Open Library work, most of those works have no ratings at all, so they
stay Unrated; matches that were ambiguous (972 in the last run) are left unrated rather than guessed.
