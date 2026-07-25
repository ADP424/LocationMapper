# MapGraph

Flexible location/room mapper. Locations are nodes, Connections are edges.
Edges can be one-way or two-way, "ephemeral" (drawn as detached `To X` / `From Y`
stubs, great for floor/level changes), and lockable until specific locations
have been visited. Everything — including notes and layout positions — lives in
PostgreSQL.

## Run it

```bash
cp .env.example .env
docker compose up --build
```

* UI:      http://localhost:8080
* API:     http://localhost:4000/api/health
* Postgres: localhost:2345 (mapgraph/mapgraph)

A small demo map ("Demo: Airport Trip") is seeded on first boot.

## Local development

```bash
# terminal 1
docker compose up db
# terminal 2
cd backend && npm install && DATABASE_URL=postgres://mapgraph:mapgraph@localhost:2345/mapgraph npm run dev
# terminal 3
cd frontend && npm install && npm run dev   # http://localhost:5173, /api is proxied
```

## Using the app

| Action | How |
|---|---|
| New location | **+ Location**, then click the canvas (or press `n`) |
| New connection | **+ Connection** (or `c`), click source then target |
| Inspect | Click a node or an edge — the inspector shows/edits names, notes, flags |
| Mark visited | Double-click a node, or use the inspector checkbox |
| Lock a connection | Inspector → *locked* → add required locations; it opens once all are visited |
| Ephemeral link | Inspector → *ephemeral*; the line becomes two labelled stubs |
| Search | Sidebar search; results centre the viewport and highlight the neighbourhood |
| Layout | Toolbar → ELK layered (tidiest), fCoSE (fastest for huge graphs), etc. Positions are persisted automatically |
| Delete | Select, then `Del` (or the Delete button) |
| Import/Export | Toolbar → JSON round-trip of the whole map |

## API surface

```
GET    /api/health
GET    /api/maps
POST   /api/maps                         { name, description? }
GET    /api/maps/:mapId                  -> { map, locations, connections }
GET    /api/maps/:mapId/export
PATCH  /api/maps/:mapId
DELETE /api/maps/:mapId
PUT    /api/maps/:mapId/positions        { positions: [{id,x,y}] }
POST   /api/maps/import
POST   /api/maps/:mapId/locations
GET    /api/locations/:id
PATCH  /api/locations/:id
DELETE /api/locations/:id
POST   /api/maps/:mapId/connections      { sourceId, targetId, bidirectional?, ephemeral?, locked?, requires?[] , ... }
GET    /api/connections/:id
PATCH  /api/connections/:id
DELETE /api/connections/:id
```

## Scaling notes

* Rendering is Canvas-based with `textureOnViewport`, `hideEdgesOnViewport`,
  `min-zoomed-font-size` and `pixelRatio: 1` → smooth panning with thousands of
  elements.
* Element updates are reconciled incrementally inside `cy.batch()`, so editing a
  single node does not rebuild the scene graph.
* Drag positions are debounced and written in one `UPDATE … FROM unnest(...)`
  statement, so saving a 5 000-node layout is a single round trip.
* ELK layered is the default for clean, low-crossing drawings; switch to fCoSE
  (`draft` quality kicks in automatically above 1 500 nodes) for very large maps.

## Design notes / rationale

1. **Ephemeral connections** are a pure *rendering* concern, so the DB stores a
   single row with `ephemeral = true`; the frontend expands it into two "portal"
   stub nodes plus two short edges (`elements.ts`). Clicking either stub selects
   the underlying connection, and highlighting follows the `connectionId` data
   field across both halves so you can still see the far side.
2. **Locks** are modelled relationally (`connection_requirements`) rather than as
   a single "required room" column, so you can express *"this path opens after
   you've visited the car rental desk **and** signed at reception"*. Effective
   lock state is derived (`isEffectivelyLocked`) and recomputed instantly when a
   location's `visited` flag flips.
3. **Positions live in the database** (`locations.x/y`), so a map reopens exactly
   as you left it; when positions are missing the client falls back to a layout
   engine and writes the result back.
4. **Backend stays dumb**: validation (Zod) + SQL. No graph logic, no traversal,
   no derived state — all of that is computed client-side from the single
   `GET /api/maps/:id` payload, which keeps the API trivially cacheable.
5. **Layers** (`locations.layer`) give you optional floor/level/district grouping,
   rendered as Cytoscape compound parents when "group by layer" is enabled —
   handy for buildings and multi-level towns.
