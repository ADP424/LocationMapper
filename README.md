# MapGraph

A web application for mapping **locations** and the **connections** between them — a
building's rooms, a city's districts, the ordered steps of a trip, or anything else
where "places" and "ways between places" are the useful abstraction. Everything is
persisted in PostgreSQL; the backend is a thin, validated persistence layer and all
graph logic lives in the browser.

| Layer | Choice |
|---|---|
| Graph rendering | **Cytoscape.js** (canvas) + `cytoscape-fcose` + `cytoscape-elk` |
| Frontend | **React 18 + Vite + TypeScript + Zustand**, one Web Worker for route planning |
| Backend | **Express 4 + TypeScript + `pg` + Zod** |
| Database | **PostgreSQL 16** |
| Orchestration | **Docker Compose** (db + backend + nginx-served frontend proxying `/api`) |

## Run it

```bash
cp .env.example .env
docker compose up --build
```

* UI — http://localhost:8080
* API — http://localhost:4000/api/health
* Postgres — localhost:2345 (`mapgraph`/`mapgraph`)

A demo map is seeded on first boot. Schema migrations run automatically on backend
start and are idempotent, so upgrading is just `docker compose up --build`.

### Local development

```bash
docker compose up db
cd backend  && npm install && DATABASE_URL=postgres://mapgraph:mapgraph@localhost:2345/mapgraph npm run dev
cd frontend && npm install && npm run dev     # http://localhost:5173, /api proxied
```

---

## Concepts

**Location** — a place. Has a name, notes, a shape, box/text colours, a free-form
*layer* string, optional integer **coordinates** `(X, Y, Z)`, a *visited* flag, saved
canvas position, any number of **labels**, and at most one **grouping**.

**Connection** — a way between two locations. Arrowheads are set independently per
end: `A → B`, `A ← B`, `A ⇄ B`, or **no arrowheads at all**, which means *undirected*
— drawn plain, and walkable both ways by the trip planner. Also carries a name,
notes, line colour/text colour, line style (`Default` lets the app choose),
a logarithmically-drawn **weight**, plus two special modes:

* **Ephemeral** — instead of one long line, draws two detached stubs (`⇄ To X` /
  `From Y ⇄`) that sit at a saved offset *relative to* their room and travel with it.
  Good for elevators, floor changes, or keeping a dense map legible.
* **Locked** — gated until every listed prerequisite location has been visited.
  Locked with no prerequisites means sealed for good.

**Grouping** — a translucent rounded box behind a set of locations, with its own name,
body colour and (independently settable) title colour. Groupings nest arbitrarily
deep; cycles are rejected by the API and enforced by a database trigger.

**Label** — a reusable category that *stamps* opt-in defaults onto whatever it is
applied to. Location labels can set shape, box colour, text colour, layer and
grouping; connection labels can set line/text colour, direction, line style, weight,
ephemeral state and the whole lock condition. Applying a label writes those defaults
immediately, so the **last label applied wins**, and every chip keeps an **Apply**
button to re-stamp on demand. Blank/"No Override" fields are never applied.

---

## Using it

| Action | How |
|---|---|
| New location | **+ Location** then click the canvas, or right-click → **+ Create Room** |
| New connection | **+ Connection** (source then target), or right-click a room → **+ Create Connection** and drag |
| Re-attach an end | Select a connection, drag either amber handle onto another room |
| Inspect / edit | Click anything. Edits apply on **Apply** or when you click outside the panel |
| Multi-select | **Right-drag** empty space to marquee rooms (groupings are never caught); drag any one to move them all; the inspector mass-edits shape, grouping, colours and visited |
| Groupings | Right-click a room → **+ Create Grouping**; right-click a grouping → create a room inside, move it into another grouping, ungroup, delete |
| Labels | Sidebar → **Labels**; add chips from a location's or connection's inspector |
| Mark visited | Double-click a room, or the inspector checkbox. **Reset All Visited** in the Trip Planner clears them all |
| Search | Sidebar search with Notes / Locations / Connections toggles and a **Filter By Label** |
| Layouts | Toolbar: ELK Layered, ELK Tree, fCoSE, Breadth-First, Concentric, Grid, Saved Positions — plus **Coordinate Grid** (X/Y, X/Z, Y/Z) |
| Trip planning | Sidebar → **Trip Planner** |
| Settings | Cogwheel: scroll sensitivity, zoom-independent sizing, tiny-label culling, planner time limit |
| Delete | Select, then `Del`. `Esc` closes the top-most overlay (menu → modal → selection) |
| Import/Export | Toolbar — full JSON round-trip including groupings, labels and coordinates |

### Layouts

Automatic layouts are **edge-label aware**: connection names are measured with canvas
text metrics and fed into the engines (per-edge ideal lengths for fCoSE, inter-layer
spacing for ELK, spacing factors elsewhere) so names never get crushed.

Groupings are laid out **recursively**: each grouping (and sub-grouping) is solved as
its own quotient graph innermost-first, then placed by its parent as a single sized
node, so nothing outside a box can land inside it at any depth, while connections
still run room-to-room.

**Coordinate Grid** layouts snap rooms onto a square lattice from their coordinates —
first axis horizontal, second vertical, larger values upward. Rooms sharing a
coordinate cluster inside their cell; rooms with no coordinate for that plane are
placed by connectivity. Coordinate layouts honour your coordinates exactly and
therefore do *not* enforce grouping containment.

### Trip planner

Enter two or more stops; the planner finds a walk visiting them **in order**,
optimising for **fewest stops** (breadth-first), **lowest total weight** (Dijkstra) or
**least coordinate change** (Dijkstra over any mixture of X/Y/Z). Undirected
connections (no arrowheads) are walkable both ways; a connection with any arrowhead
set can only be walked in the direction(s) the arrows allow.

Locked doors are opportunities, not walls: the search state is
`(room, prerequisites collected, next stop due)`, so a **detour** to a prerequisite
room is found automatically — including when it's the only way through, and including
when the key is picked up on an earlier leg. Key pickups are reported explicitly
(🔑 *Opens: …*) alongside the gated step (🔓 *Gate needs: …*).

It runs in a **Web Worker** with live progress and a **Cancel** that returns the best
route found so far, and it always reports which of three things happened:

* **Optimal route found** — the search completed exhaustively.
* **Route found, not proven optimal** — stopped by the time limit, the state ceiling, or you.
* **Trip is impossible** — proven, either by an optimistic reachability closure or by
  exhausting the state space.

Plans are **saved**: editing the map or changing options marks the plan *out of date*
rather than discarding it. **Auto-Recompute** is on by default and switches itself off
if a search exceeds 500 ms.

Before searching, three sound **relevance prunes** shrink the problem: prerequisites
that can never be collected (and the doors needing them), doors that cannot lie on any
walk between consecutive stops, and doors whose prerequisites are already visited.
Key sets are interned bitsets with **dominance pruning** (more keys for no more cost
always wins), so there is no limit on the number of prerequisites. A hard ceiling of
4 M search states is always active and is only ever surfaced if hit; the wall-clock
limit is optional (whole seconds, default 10).

---

## API

All routes are under `/api`. Validation is Zod; Postgres constraint and trigger
violations are mapped to `400`/`409`/`503` with a safe message, never a raw `500`.

### Maps

```
GET    /health
GET    /maps
POST   /maps                          { name, description? }
GET    /maps/:mapId                   -> { map, groups, locationLabels, connectionLabels, locations, connections }
PATCH  /maps/:mapId
DELETE /maps/:mapId
GET    /maps/:mapId/export
POST   /maps/import                   -> graph + { warnings[] }
PUT    /maps/:mapId/positions         { positions[], portalOffsets[] }
POST   /maps/:mapId/reset-visited
```

### Groupings

```
POST   /maps/:mapId/groups            { name?, color?, textColor?, notes?, parentId?, locationIds? }
GET    /groups/:id
PATCH  /groups/:id                    (parentId is cycle-checked)
DELETE /groups/:id                    (contents move up a level)
POST   /groups/:id/ungroup
```

### Labels

```
POST   /maps/:mapId/location-labels
PATCH  /location-labels/:id
DELETE /location-labels/:id
POST   /location-labels/:id/apply                -> { locations[] }
POST   /locations/:id/labels                     { labelId, applyStyling? }
POST   /locations/:id/labels/:labelId/apply
DELETE /locations/:id/labels/:labelId

POST   /maps/:mapId/connection-labels
PATCH  /connection-labels/:id
DELETE /connection-labels/:id
POST   /connection-labels/:id/apply              -> { connections[] }
POST   /connections/:id/labels                   { labelId, applyStyling? }
POST   /connections/:id/labels/:labelId/apply
DELETE /connections/:id/labels/:labelId
```

### Locations & connections

```
POST   /maps/:mapId/locations
GET    /locations/:id
PATCH  /locations/:id                 (groupId / coordX|Y|Z accept explicit null to clear)
DELETE /locations/:id

POST   /maps/:mapId/connections
GET    /connections/:id
PATCH  /connections/:id
DELETE /connections/:id
```

---

## Data model

```
maps ─┬─ groups ──────────── parent_id -> groups (nestable, cycle-checked)
      ├─ location_labels ─── default_group_id -> groups
      ├─ connection_labels ─ connection_label_requirements -> locations
      ├─ locations ────────┬ group_id -> groups
      │                    └ location_label_assignments -> location_labels
      └─ connections ──────┬ source_id / target_id -> locations
                           ├ connection_requirements -> locations
                           └ connection_label_assignments -> connection_labels
```

Cross-map references are impossible by construction: database triggers verify
`map_id` consistency for connection endpoints, location groupings, grouping parents,
and both requirement tables. `connections.weight` and `connection_labels.default_weight`
are `CHECK`-constrained positive.

## Performance notes

* Canvas rendering with incremental element reconciliation — editing one node never
  rebuilds the scene graph, and edges whose endpoints changed are re-created because
  Cytoscape cannot re-point an existing edge.
* **Zoom-independent sizing**: every size-like property has a pre-multiplied `…View`
  twin recomputed on zoom (`zoom^-strength`), so boxes and names stay readable at any
  distance. Layouts read the *base* sizes so the arrangement is zoom-invariant.
* Drag positions and ephemeral stub offsets are debounced and written in one
  `UPDATE … FROM unnest(...)`; pending writes are flushed before switching maps.
* Route planning runs off the main thread and yields to the event loop so it can be
  cancelled mid-search.

## Known gaps / decisions

* `locations.pinned` is persisted and styles a gold border, but nothing in the UI
  toggles it and no layout honours it. Either wire it to fCoSE's
  `fixedNodeConstraint` (and add a toggle) or drop the column — currently it is inert.
* A location's **grouping** picker and the **visited** checkbox apply immediately
  rather than through Apply/Revert, because both trigger a re-layout that cannot be
  meaningfully undone by reverting a text field. A grouping's own *parent* picker and
  a label's default-grouping picker do go through the draft.
* Import performs one insert per row inside a single transaction (one pooled
  connection). Array sizes are capped; batching into multi-row inserts would be the
  next optimisation for very large files.
* There is no authentication or authorization on any endpoint, and CORS reflects any
  origin by default (`CORS_ORIGIN` env var). This is an accepted trade-off for a
  local-only tool; if this API is ever exposed beyond localhost, both need addressing.
* There is no test suite in this repository. Validate changes with `npm run
  typecheck` (and `npm run build`) in each package.
