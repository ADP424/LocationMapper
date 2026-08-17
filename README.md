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
cd frontend && npm install && npm run dev     # http://localhost:8080, /api proxied
```

---

## Concepts

**Location** — a place. Has a name, notes, a shape, a **size** (a positive scalar on
the box: `2` is twice as wide and tall as a normal room, `0.5` half — the box, its
name, and its border all scale together, so the disparity with its neighbours holds
at every zoom level), box/text colours, a free-form *layer* string, optional integer
**coordinates** `(X, Y, Z)`, a *visited* flag, saved canvas position, any number of
**labels**, and any number of **groupings**. When a room belongs to several, the
oldest membership is its layout **anchor** — the one grouping whose arrangement
actually contains it; the rest simply reach out to it with corridors or a stretched
box, and dragging the grouping's own box carries every member, not just the anchored
ones.

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

**Grouping** — a translucent rounded box (or, as a display style, a form-fitted
outline or a snake loop threaded through the members) behind a set of locations, with
its own name, body colour and (independently settable) title colour. A grouping can
also carry **default styling** — shape, size, box/text colour — which is stamped onto
a room the moment it **joins** the grouping, whether by creation inside it or by
being added to it later; the inspector's **Apply** chip re-stamps on demand.
Groupings are created from the sidebar, from a room's right-click menu, or from a
multi-selection, and are not drawn until at least one room is in them. Groupings nest
arbitrarily deep (a separate concept from membership — a room can belong to any
number of groupings regardless of nesting); cycles are rejected by the API and
enforced by a database trigger.
Overlapping groupings are **stacked**: on a coordinate layout they are ordered along
the axis that plane does not show (X/Y → by Z, lowest underneath), and on every other
layout by the area each box covers once positioning finishes, largest underneath. A
sub-grouping always draws over its parent. The higher a box sits the more solid it is
drawn, and the sidebar spells the order out as `Layer 3/5 (Z 2)`. Clicking a point
covered by several bodies always resolves to the topmost one — the same order the
map already draws them in.
Dragging a grouping's own box moves **every** member, not just the rooms it anchors —
accepting that this can tear a member out of whichever other grouping it also
belongs to, whose body simply reflows around the gap.
Because a grouping box covers a lot of canvas, what a drag inside one does is a
setting — and the same choice is available for rooms: **Always Draggable** (grabs, so
you cannot pan over it), **Never Draggable** (always pans), or **Draggable When
Selected** (both at once: drag to pan, click the thing to pick it up, drag it, then
click away or press `Esc`). Groupings and rooms both default to *When Selected*.
Under the hood this flips Cytoscape's per-element `grabbable`/`pannable` pair; clicking
to select, marquee multi-select and multi-drag all keep working in every mode.
Anything currently panned through is also exempted from Cytoscape's default `:active`
halo, so a press that only pans produces no visual change at all.

**Draw order** follows the same rule one level down: rooms are stacked by their
off-plane coordinate on a coordinate layout, and biggest-box-first everywhere else, so
a large room never buries a small one it overlaps. Rooms are opaque, so the occlusion
*is* the cue — no ramp. Every room draws over every grouping box, and an ephemeral
stub shares its anchor room's layer.

**Label** — a reusable category that *stamps* opt-in defaults onto whatever it is
applied to. Location labels can set shape, box colour, text colour and size;
connection labels can set line/text colour, direction, line style, weight, ephemeral
state and the whole lock condition. Applying a label writes those defaults
immediately, so the **last label applied wins**, and every chip keeps an **Apply**
button to re-stamp on demand. Blank/"No Override" fields are never applied.

### Two systems, one rule

Labels and groupings both stamp room styling, so each carries a flag saying whether it
may overwrite the other — and the rule is per **property**, not per room:

> a stamp never writes a property the other system already claims,
> unless its own override flag says it may.

A grouping that sets shape and colour still sets the shape of a room whose label only
claims the colour. Label-over-label is unaffected: the last label applied always wins.

---

## Using it

| Action | How |
|---|---|
| New location | **+ Location** then click the canvas, or right-click → **+ Create Room** |
| New connection | **+ Connection** (source then target), or right-click a room → **+ Create Connection** and drag |
| Re-attach an end | Select a connection, drag either amber handle onto another room |
| Inspect / edit | Click anything. Edits apply on **Apply** or when you click outside the panel. Controls that act immediately (labels, grouping, visited) never discard what you have typed — only **Revert** does |
| Resize a room | Inspector → **Size** (or **Change Size** when several are selected) |
| Multi-select | **Right-drag** empty space *or a grouping box* to marquee rooms; drag any one to move them all; the inspector mass-edits shape, groupings, colours and visited |
| Groupings | Sidebar → **Groupings**, or right-click a room → **+ Create Grouping** / **Add To Grouping** / **Remove From Grouping**; right-click a grouping → create a room inside *or* outside it, move it into another grouping, deselect, ungroup, delete |
| Labels | Sidebar → **Labels**; add chips from a location's or connection's inspector |
| Mark visited | Double-click a room, or the inspector checkbox. **Reset All Visited** in the Trip Planner clears them all |
| Search | Sidebar search with Notes / Locations / Connections toggles and a **Filter By Label** |
| Layouts | Toolbar: ELK Layered, ELK Tree, fCoSE, Breadth-First, Concentric, Grid, Saved Positions — plus **Coordinate Grid** (X/Y, X/Z, Y/Z) |
| Trip planning | Sidebar → **Trip Planner** |
| Settings | Cogwheel: scroll sensitivity, base size, zoom-independent sizing, the zoomed-out skeleton (line thickness, whether it draws lines at all, and whether you may zoom out into it), ephemeral style, drag-vs-pan for groupings and locations, planner time limit. Each has a `?` for the detail |
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
POST   /maps/:mapId/groups            { name?, color?, textColor?, notes?, parentId?, locationIds?, default*, overrideLabels? }
GET    /groups/:id
PATCH  /groups/:id                    (parentId is cycle-checked)
DELETE /groups/:id                    (contents move up a level)
POST   /groups/:id/ungroup
POST   /groups/:id/apply              -> { locations[] }   (direct members only)
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
PATCH  /locations/:id                       (coordX|Y|Z accept explicit null to clear)
DELETE /locations/:id
POST   /locations/:id/groups                { groupId, applyStyling? }  (join a grouping)
DELETE /locations/:id/groups/:groupId                                   (leave a grouping)
POST   /locations/:id/groups/:groupId/apply -> location  (re-stamp that grouping's defaults)

POST   /maps/:mapId/connections
GET    /connections/:id
PATCH  /connections/:id
DELETE /connections/:id
```

---

## Data model

```
maps ─┬─ groups ──────────── parent_id -> groups (nestable, cycle-checked)
      ├─ connection_labels ─ connection_label_requirements -> locations
      ├─ locations ────────┬ location_group_assignments -> groups (many-to-many;
      │                    │   oldest assignment per room is the layout anchor)
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
  Cytoscape cannot re-point an existing edge. The reconcile also **skips writes that
  change nothing**: a `data()` or `classes()` call restyles the element whether or not
  the value moved, so editing one room used to restyle the entire graph. Only the
  classes `buildElements` owns are diffed, which leaves the runtime ones (highlight,
  route, `pan-through`, `zLayer`) in place and makes the stacking, drag-mode and
  highlight passes free when nothing changed.
* Zoom compensation is the most expensive thing the app can do — one factor change
  restyles every element and discards Cytoscape's texture cache — so: it is **off by
  default**, the viewport handler returns immediately when it is off, a 3 % deadband
  ignores tiny factor moves, each element is written in a **single** `data()` call, the
  pass is rate-limited from 16 ms to 250 ms by element count, and past **8 000
  elements** it switches itself off and says so in the status bar.
* **One global, shape-aware render ratio.** Cytoscape caches elements and labels in
  1024 px texture atlases and re-renders anything larger *every frame*; Chrome stops
  caching glyph rasters around 256 px. So `R = min(1, 900 / (maxNodeBox × f × zoom))`
  is applied to every size-like property of every element: the largest drawn box —
  shape metrics, per-room scalar and Base Size all folded into `data.w/h` — drives it,
  so a star hits the ceiling before a rectangle with the same label, and a size-5 room
  that hits it leaves size-1 rooms at exactly a fifth of it. A node's label is strictly
  inside its box (`w = textW·wFactor + padX`), so bounding the box bounds its texture;
  connection and grouping names wrap in nothing and get a second ratio. `R` is quantised
  to ~2 % steps rounding down, and when `R = 1` the view data has no zoom dependence at
  all — so the normal regime stays free, and the clamped regime is self-limiting
  (`R < 1` means the biggest node fills the screen, so almost nothing is visible).
* **The zoom floor and Fit solve the compensated extent properly.** Under compensation
  the drawn content does not shrink linearly with the zoom — at strength 1 the boxes
  never shrink at all — so `viewport / box` is simply wrong. `rendered(z) = aW·z +
  bW·z^(1−s)` is strictly increasing, so the fit is found by geometric bisection over a
  conservative affine model of the extent, built from the exact drawn bounds at the two
  extreme factors (the upper bounds are convex in `f`, the lower concave, so the chord
  encloses). One arithmetic pass, O(1) per probe, and no bounding box is ever measured.
  The render ratio only shrinks geometry, so a fit solved without it always fits.
* **Base Size** (default `2`) multiplies every box, line and name. It is baked into the
  element data, so `baseSize(node)` — and therefore every layout, the coordinate grid
  and the spacing metrics — sizes the boxes that will actually be drawn. Absolute gaps
  deliberately do *not* scale, so raising it gives chunkier boxes against the same
  whitespace; re-layout after changing it. It goes up to `32`.
* **Zoom-independent sizing** (off by default: it rewrites every node's geometry on each
  zoom step) multiplies on top. Every size-like property has a pre-multiplied `…View`
  twin recomputed on zoom (`zoom^-strength`), so at strength 1 a room holds at exactly
  Base Size on screen. Layouts are solved against base geometry — they temporarily pin
  the compensation to 1 — so the arrangement is zoom-invariant and never drifts larger.
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

* A location's grouping chips (add/remove) and the **visited** checkbox apply
  immediately rather than through Apply/Revert, because both trigger a re-layout that
  cannot be meaningfully undone by reverting a text field. A grouping's own *parent*
  picker does go through the draft. Rows that come back from an immediate action are
  *merged* into the open draft — fields you have touched are
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
* `buildElements` still rebuilds the whole element array on every store change (the
  diffing above keeps that cheap, but the allocation is O(elements)). Memoising it per
  row would be the next optimisation for maps in the tens of thousands.
* The schema has no migration *system*, but additive changes are applied idempotently
  (`ADD COLUMN IF NOT EXISTS` / `DROP COLUMN IF EXISTS`) on boot, so an existing
  database converges. Anything non-additive still means export, `docker compose down -v`,
  re-import (import fills in anything an older export is missing, e.g. `size: 1`).
* Zoom-independent sizing inflates boxes in *model* space when you zoom out, while layouts
  are solved against base geometry, so at extreme zoom-out compensated boxes can visually
  crowd each other. Lower the strength — or leave the feature off and raise **Base Size**
  instead, which every layout does account for.
