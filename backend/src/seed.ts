import { withTransaction } from './db';

/** A small demo map, written once when the database is first created. */
export async function seedDemoMap() {
  await withTransaction(async (client) => {
    const insert = async (sql: string, values: unknown[]) =>
      (await client.query(sql, values)).rows[0].id as string;

    const mapId = await insert(
      `INSERT INTO maps (name, description) VALUES ($1,$2) RETURNING id`,
      ['Demo: Airport Trip', 'Shows groupings, locks, ephemeral links and notes.']
    );

    const hotel = await insert(
      `INSERT INTO groups (map_id, name, color, notes) VALUES ($1,$2,$3,$4) RETURNING id`,
      [mapId, 'The Hotel', '#7aa7d8', 'Everything inside the hotel building.']
    );

    const rooms: Array<{
      name: string;
      group: string | null;
      kind: string;
      size: number;
      layer: string;
      notes: string;
      visited: boolean;
      x: number;
      y: number;
    }> = [
      { name: 'Hotel Lobby', group: hotel, kind: 'round-rectangle', size: 1.4, layer: 'Ground',
        notes: 'Start here. The front desk holds the luggage.', visited: true, x: 0, y: 0 },
      { name: 'Hotel Room 214', group: hotel, kind: 'round-rectangle', size: 1, layer: 'Floor 2',
        notes: 'The ephemeral link models the elevator.', visited: false, x: 250, y: -150 },
      { name: 'Rental Car Desk', group: null, kind: 'diamond', size: 1, layer: 'Ground',
        notes: 'You must pick up the keys before you can drive.', visited: false, x: 560, y: 150 },
      { name: 'Parking Garage', group: null, kind: 'hexagon', size: 1, layer: 'Underground',
        notes: 'Level -1, spot C14.', visited: false, x: 900, y: 150 },
      { name: 'Airport Terminal B', group: null, kind: 'star', size: 2, layer: 'City',
        notes: 'Forty minute drive.', visited: false, x: 1240, y: 60 }
    ];

    const id = new Map<string, string>();
    for (const r of rooms) {
      id.set(
        r.name,
        await insert(
          `INSERT INTO locations (map_id, group_id, name, kind, size, layer, notes, visited, x, y)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [mapId, r.group, r.name, r.kind, r.size, r.layer, r.notes, r.visited, r.x, r.y]
        )
      );
    }

    const links: Array<{
      from: string;
      to: string;
      name: string;
      notes: string;
      travelKind: string;
      arrowSource: boolean;
      ephemeral: boolean;
      locked: boolean;
      lockNote: string;
      weight: number;
      requires: string[];
    }> = [
      { from: 'Hotel Lobby', to: 'Hotel Room 214', name: 'Elevator',
        notes: 'Key cards only work for your own floor.', travelKind: 'dotted',
        arrowSource: true, ephemeral: true, locked: false, lockNote: '', weight: 1, requires: [] },
      { from: 'Hotel Lobby', to: 'Rental Car Desk', name: 'Walk Out The Main Doors',
        notes: '', travelKind: 'solid', arrowSource: true, ephemeral: false,
        locked: false, lockNote: '', weight: 1, requires: [] },
      { from: 'Rental Car Desk', to: 'Parking Garage', name: 'Take The Keys To The Garage',
        notes: '', travelKind: 'solid', arrowSource: false, ephemeral: false, locked: true,
        lockNote: 'Needs the rental agreement signed.', weight: 2, requires: ['Rental Car Desk'] },
      { from: 'Parking Garage', to: 'Airport Terminal B', name: 'Highway 9 Southbound',
        notes: 'Tolls: $4.', travelKind: 'solid', arrowSource: false, ephemeral: false,
        locked: true, lockNote: 'Requires the car.', weight: 12, requires: ['Parking Garage'] }
    ];

    for (const l of links) {
      const connId = await insert(
        `INSERT INTO connections
           (map_id, source_id, target_id, name, notes, travel_kind,
            arrow_source, arrow_target, ephemeral, locked, lock_note, weight)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,$9,$10,$11) RETURNING id`,
        [mapId, id.get(l.from), id.get(l.to), l.name, l.notes, l.travelKind,
         l.arrowSource, l.ephemeral, l.locked, l.lockNote, l.weight]
      );
      for (const req of l.requires) {
        await client.query(
          `INSERT INTO connection_requirements (connection_id, location_id) VALUES ($1,$2)`,
          [connId, id.get(req)]
        );
      }
    }
  });
  console.log('[seed] demo map created');
}
