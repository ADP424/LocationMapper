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

The schema lives in exactly one place — `backend/src/schema.ts` — and is applied
(idempotently) when the backend starts. If the database is brand new, the backend
also seeds a small demo map. There is no migration system: recreating the `pgdata`
volume recreates the database from that one file.

### Local development

```bash
docker compose up db
cd backend  && npm install && DATABASE_URL=postgres://mapgraph:mapgraph@localhost:2345/mapgraph npm run dev
cd frontend && npm install && npm run dev     # http://localhost:5173, /api proxied
```

---

## Concepts

**Location** — a place. Has a name, notes, a shape, a **size** (a positive scalar on
the box: `2` is twice as wide and tall as a normal room, `0.5` half — the box, its
name, and its border all scale together, so the disparity with its neighbours holds
at every zoom level), box/text colours, a free-form *layer* string, optional integer
**coordinates** `(X, Y, Z)`, a *visited* flag, saved canvas position, any number of
**labels**, and at most one **grouping**.

**Connection** — a way between two locations. Arrowheads are set independently per
end: `A → B`, `A ← B`, `A ⇄ B`, or **no arrowheads at all**, which means *undirected*
— drawn plain, and walkable both ways by the trip planner. Also carries a name,
notes, line colour/text colour, line style (`Default` lets the app choose),
(new connections start as `Default`),
a logarithmically-drawn **weight**, plus two special modes:

* **Ephemeral** — instead of one long line, draws two detached stubs (`⇄ To X` /
  `From Y ⇄`) that sit at a saved offset *relative to* their room and travel with it.
  Good for elevators, floor changes, or keeping a dense map legible.
* **Locked** — gated until every listed prerequisite location has been visited.
  Locked with no prerequisites means sealed for good.

**Grouping** — a translucent rounded box behind a set of locations, with its own name,
body colour and (independently settable) title colour. Groupings nest arbitrarily
deep; cycles are rejected by the API and enforced by a database trigger.
Overlapping groupings are **stacked**: on a coordinate layout they are ordered along
the axis that plane does not show (X/Y → by Z, lowest underneath), and on every other
layout by the area each box covers once positioning finishes, largest underneath. A
sub-grouping always draws over its parent. The higher a box sits the more solid it is
drawn, and the sidebar spells the order out as `Layer 3/5 (Z 2)`.

**Draw order** follows the same rule one level down: rooms are stacked by their
off-plane coordinate on a coordinate layout, and biggest-box-first everywhere else, so
a large room never buries a small one it overlaps. Rooms are opaque, so the occlusion
*is* the cue — no ramp. Every room draws over every grouping box, and an ephemeral
stub shares its anchor room's layer.

**Label** — a reusable category that *stamps* opt-in defaults onto whatever it is
applied to. Location labels can set shape, box colour, text colour, layer and
size, grouping; connection labels can set line/text colour, direction, line style, weight,
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
| Inspect / edit | Click anything. Edits apply on **Apply** or when you click outside the panel. Controls that act immediately (labels, grouping, visited) never discard what you have typed — only **Revert** does |
| Resize a room | Inspector → **Size** (or **Change Size** when several are selected) |
| Multi-select | **Right-drag** empty space to marquee rooms (groupings are never caught); drag any one to move them all; the inspector mass-edits shape, grouping, colours and visited |
| Groupings | Right-click a room → **+ Create Grouping**; right-click a grouping → create a room inside *or* outside it, move it into another grouping, ungroup, delete |
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

They are also **size aware**: every engine is handed each room's real box — size
scalar included — and the spacing terms grow with the largest rooms (fCoSE's ideal
edge length grows with its own two endpoints, the coordinate grid's cell unit with
the boxes that eat into the line a name sits on), so over-sized rooms never crowd
their neighbours or their connection names. Maps that leave every size at `1` lay
out exactly as before.

Groupings are laid out **recursively**: each grouping (and sub-grouping) is solved as
its own quotient graph innermost-first, then placed by its parent as a single sized
node, so nothing outside a box can land inside it at any depth, while connections
still run room-to-room.

**Coordinate Grid** layouts snap rooms onto a square lattice from their coordinates —
first axis horizontal, second vertical, larger values upward. Rooms sharing a
coordinate cluster inside their cell; rooms with no coordinate for that plane are
placed by connectivity. Coordinate layouts honour your coordinates exactly and
therefore do *not* enforce grouping containment.
The third axis is not discarded: it becomes the grouping **stacking order**, so an
X/Y plane layers its groupings by Z.

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
  distance. A location's size scalar is baked into its *base* box and multiplied into
  the text-side properties alongside the zoom factor, so the two never interfere.
  Every layout is solved against base geometry — automatic layouts temporarily pin
  the compensation to 1 — so the arrangement is zoom-invariant and re-layouts never
  drift larger.
* Drag positions and ephemeral stub offsets are debounced and written in one
  `UPDATE … FROM unnest(...)`; pending writes are flushed before switching maps.
* **Wheel zooming is ours, not Cytoscape's.** The library only accepts a
  sensitivity at construction; setting it afterwards means writing to a private
  renderer field that is re-seeded from that option and cannot be read back, so
  the setting silently reverted to the library default depending on startup
  ordering — zooming would occasionally be much faster than configured. The wheel
  is intercepted in the capture phase above the canvas (so Cytoscape's handler
  never runs), `deltaMode` is normalised so mice, trackpads and Firefox agree, and
  a single huge delta is clamped. Touch gestures are untouched: pinch zoom works.
* Automatic layouts pin the zoom compensation to 1 while they solve. The lock is
  held by token — a cancelled layout cannot release its successor's — and has a
  watchdog, because a frozen compensation is indistinguishable from the wheel
  becoming four times more sensitive.
* Route planning runs off the main thread and yields to the event loop so it can be
  cancelled mid-search.

## Known gaps / decisions

* A location's **grouping** picker and the **visited** checkbox apply immediately
  rather than through Apply/Revert, because both trigger a re-layout that cannot be
  meaningfully undone by reverting a text field. A grouping's own *parent* picker and
  a label's default-grouping picker do go through the draft. Rows that come back from
  an immediate action are *merged* into the open draft — fields you have touched are
  kept, everything else follows the server — so applying a label never discards
  unsaved edits. If you edited a field **and** then applied a label that sets it, your
  value wins and is written on click-out; press **Revert** to take the label's instead.
* A label's *Re-Apply Styling To All…* button commits the open draft first, so it
  always stamps the defaults you can see rather than the ones last saved.
* Import performs one insert per row inside a single transaction (one pooled
  connection). Array sizes are capped; batching into multi-row inserts would be the
  next optimisation for very large files.
* There is no authentication or authorization on any endpoint, and CORS reflects any
  origin by default (`CORS_ORIGIN` env var). This is an accepted trade-off for a
  local-only tool; if this API is ever exposed beyond localhost, both need addressing.
* There is no test suite in this repository. Validate changes with `npm run
  typecheck` (and `npm run build`) in each package.
* The schema has no migration path, by design. Adding a column means recreating the
  database: export your maps, `docker compose down -v`, `docker compose up --build`,
  then import (import fills in anything an older export is missing, e.g. `size: 1`).
* Zoom-independent sizing inflates boxes in *model* space as you zoom out, while
  layouts are solved against base geometry, so at extreme zoom-out the compensated
  boxes can visually crowd an otherwise overlap-free arrangement. Lower the
  compensation strength in Settings if that bothers you.
