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

Per edition the state records Open Library work key, average, count, match confidence, method and fetch time.
A work's rating is its best-supported match (highest confidence, then most ratings).

- **gutenberg-id**: Open Library editions carry Project Gutenberg ids. The returned work is accepted only if its
  main title matches (exact → 0.98 with agreeing author / 0.9 without author data; ≥ 50 % word overlap → 0.9 /
  0.8) and it is rejected outright if the authors disagree.
- **title-author** (fallback, 0.75; also tried when the id match found an Open Library work with no ratings, which is
  often a duplicate work record): exact main title and the same author surname, and only if one work clearly
  dominates (≥ 3× the editions of the next); generic one-word titles and author-less records are never searched.
- Works without a match, or matched to a work with zero ratings, are **Unrated** – nothing is estimated.
- **Weighted score** (Top rated sort): `(n·c·R + 25·m) / (n·c + 25)` where R is the average, n the count, c the
  match confidence and m the catalog-wide mean. Few ratings or a weaker match stay near the mean; unrated works sort last.

Refresh: id lookups are repeated every 14 days per edition (oldest first, 900 batches max per run); the search
fallback retries a book after 60 days; at most 1,500 searches per run.

### Operations

- **Schedule**: daily. Gutenberg is skipped when its catalog file is unchanged; Standard Ebooks repositories are
  re-read only when pushed; ratings are refreshed incrementally.
- **Retry and rate limits**: every request retries network errors, 429 and 5xx with exponential backoff and
  honours `Retry-After`; Open Library is paced to ≤ 1 request/second, GitHub raw files to ~7/second over 4 workers.
- **Safety**: if a source fails, the previous run's data for that source is kept. If the readable Gutenberg count
  drops by more than 10 % the run fails without publishing. `meta.json` is uploaded last, so servers only reload
  after the new catalog is in place.
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
